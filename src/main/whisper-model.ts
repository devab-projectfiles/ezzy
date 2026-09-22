import { app, net } from 'electron'
import type { Readable } from 'stream'
import { createWriteStream, existsSync, statSync } from 'fs'
import { mkdir, open, rename, rm } from 'fs/promises'
import { dirname, join } from 'path'
import { log, since } from './verbose'

// small.en-q5_1, chosen after base.en answered "next track on Spotify" with "Make a scene
// on Spotify" — fluent, grammatical, wrong. Costs latency: base ~625ms, small a few times that.
const MODEL_FILE = 'ggml-small.en-q5_1.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`

const MODEL_MIN_BYTES = 170_000_000

// Left on disk they are dead weight nothing else will ever delete; removed only after the
// replacement is verified.
const SUPERSEDED = ['ggml-base.en.bin', 'ggml-tiny.en.bin']

// ggml's magic number. Checked because HuggingFace answers an outage with an HTML page and a
// 200, and a "model" whisper-server then refuses to load is a more confusing failure than one
// that says it failed.
const GGML_MAGIC = Buffer.from([0x6c, 0x6d, 0x67, 0x67])

export interface DownloadProgress {
  percent: number
}

function whisperDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'whisper')
    : join(app.getAppPath(), 'resources', 'whisper')
}

export function serverExePath(): string {
  return join(whisperDir(), 'whisper-server.exe')
}

export function hasBinaries(): boolean {
  return existsSync(serverExePath())
}

export function modelPath(): string {
  return join(app.getPath('userData'), 'models', MODEL_FILE)
}

export function hasModel(): boolean {
  try {
    return statSync(modelPath()).size >= MODEL_MIN_BYTES
  } catch {
    return false
  }
}

let downloading: Promise<boolean> | null = null

// Concurrent callers share one download — holding the hotkey twice while it runs must not
// start a second one.
export function ensureModel(onProgress: (progress: DownloadProgress) => void): Promise<boolean> {
  if (hasModel()) return Promise.resolve(true)
  if (!downloading) {
    downloading = download(onProgress).finally(() => {
      downloading = null
    })
  }
  return downloading
}

export function isDownloading(): boolean {
  return downloading !== null
}

async function download(onProgress: (progress: DownloadProgress) => void): Promise<boolean> {
  const startedAt = performance.now()
  const target = modelPath()
  // Renamed at the end so a download killed halfway can't leave a half file `hasModel` believes.
  const partial = `${target}.part`
  await mkdir(dirname(target), { recursive: true })
  await rm(partial, { force: true })

  log(`downloading ${MODEL_URL}`)
  const ok = await new Promise<boolean>((resolve) => {
    // Electron's net, not node's https: honours the system proxy and certificate store.
    const request = net.request({ url: MODEL_URL, method: 'GET' })
    let file: ReturnType<typeof createWriteStream> | null = null

    const fail = (reason: string): void => {
      console.error(`[ezzy] speech model download failed: ${reason}`)
      file?.destroy()
      resolve(false)
    }

    request.on('error', (err) => fail(err.message))
    request.on('response', (response) => {
      // Electron types the response as an event emitter, but it's a Readable at runtime.
      const body = response as unknown as Readable
      if (response.statusCode !== 200) {
        fail(`HTTP ${response.statusCode}`)
        body.resume()
        return
      }
      const header = response.headers['content-length']
      const total = Number(Array.isArray(header) ? header[0] : header) || 0
      let received = 0
      let lastReported = -1

      file = createWriteStream(partial)
      file.on('error', (err) => fail(err.message))
      file.on('finish', () => resolve(true))
      body.pipe(file)

      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total === 0) return
        const percent = Math.floor((received / total) * 100)
        // One IPC message per whole percent, not per chunk.
        if (percent === lastReported) return
        lastReported = percent
        onProgress({ percent })
      })
      response.on('error', (err: Error) => fail(err.message))
    })
    request.end()
  })

  if (!ok || !(await isRealModel(partial))) {
    await rm(partial, { force: true })
    return false
  }
  await rename(partial, target)
  since(`speech model downloaded to ${target}`, startedAt)
  await removeSuperseded()
  return true
}

// A fixed list rather than "every ggml file that isn't current" — that rule is one bad edit
// from deleting the model in use.
async function removeSuperseded(): Promise<void> {
  for (const file of SUPERSEDED) {
    if (file === MODEL_FILE) continue
    const path = join(dirname(modelPath()), file)
    try {
      if (!existsSync(path)) continue
      await rm(path, { force: true })
      log(`removed the superseded speech model ${file}`)
    } catch (err) {
      console.error(`[ezzy] could not remove the old speech model ${file}:`, err)
    }
  }
}

async function isRealModel(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r')
    try {
      const size = (await handle.stat()).size
      if (size < MODEL_MIN_BYTES) {
        console.error(`[ezzy] speech model is ${size} bytes, which is too small to be one`)
        return false
      }
      const magic = Buffer.alloc(4)
      await handle.read(magic, 0, 4, 0)
      if (!magic.equals(GGML_MAGIC)) {
        console.error('[ezzy] what downloaded is not a ggml model')
        return false
      }
      return true
    } finally {
      await handle.close()
    }
  } catch (err) {
    console.error('[ezzy] could not check the downloaded model:', err)
    return false
  }
}
