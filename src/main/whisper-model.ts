/** Where whisper's files are, and getting the one we do not ship (PLAN.md §3, §8 chunk D).
 *
 *  Two halves of the same question, kept together because the answer to both is a path:
 *
 *   * The **binaries** ship with the app. §5: they cannot live inside the asar, so they go in
 *     `extraResources` and resolve through `process.resourcesPath` in a packaged build and
 *     through the repo in dev. They are not in git either — `scripts/fetch-whisper.mjs`
 *     fetches them, and a clone that has not run it has no voice until it does.
 *   * The **model** is downloaded on first run rather than bundled (§3), which is the
 *     difference between a ~90MB installer and a ~230MB one. It lands in userData, so it
 *     survives an update and an uninstall leaves it with the rest of the app's data.
 */

import { app, net } from 'electron'
import type { Readable } from 'stream'
import { createWriteStream, existsSync, statSync } from 'fs'
import { mkdir, open, rename, rm } from 'fs/promises'
import { dirname, join } from 'path'
import { log, since } from './verbose'

/** §3: `base`, English-only. Small enough to download in under a minute on a normal line and
 *  accurate enough for "switch to chrome", which is the whole vocabulary this needs. */
const MODEL_FILE = 'ggml-base.en.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`

/** What the file should weigh, from the release it is pinned to. Only used as a floor: a
 *  truncated download is the failure this catches, and it is the common one. */
const MODEL_MIN_BYTES = 140_000_000

/** ggml's magic number, as the four bytes it is written as on a little-endian machine.
 *  Checked because HuggingFace answers an outage with an HTML error page and a 200, and a
 *  120KB "model" that whisper-server then refuses to load is a far more confusing failure
 *  than a download that says it failed. */
const GGML_MAGIC = Buffer.from([0x6c, 0x6d, 0x67, 0x67])

export interface DownloadProgress {
  /** 0-100. Stays at 0 while the server has not said how big the file is. */
  percent: number
}

/** Where the binaries live. In dev that is the repo's own `resources/whisper`; in a packaged
 *  build it is next to the asar, because §5 is explicit that native binaries cannot be
 *  loaded out of it. */
function whisperDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'whisper')
    : join(app.getAppPath(), 'resources', 'whisper')
}

export function serverExePath(): string {
  return join(whisperDir(), 'whisper-server.exe')
}

/** False on a clone that has not run `npm run fetch:whisper`, which is the one case where
 *  voice is missing rather than broken. The rest of the app does not care. */
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

/** Fetch the model if it is not already here. Concurrent callers share one download — holding
 *  the hotkey twice while it runs must not start a second one.
 *
 *  Resolves false rather than throwing: a failed download is an ordinary state of the world
 *  (no network on first run is in §10's manual checklist), and the caller's job is to say so
 *  rather than to handle an exception. */
export function ensureModel(onProgress: (progress: DownloadProgress) => void): Promise<boolean> {
  if (hasModel()) return Promise.resolve(true)
  if (!downloading) {
    downloading = download(onProgress).finally(() => {
      downloading = null
    })
  }
  return downloading
}

/** True while a download is in flight, so the caller can report progress rather than starting
 *  another one. */
export function isDownloading(): boolean {
  return downloading !== null
}

async function download(onProgress: (progress: DownloadProgress) => void): Promise<boolean> {
  const startedAt = performance.now()
  const target = modelPath()
  // Written under a temporary name and renamed at the end, so a download killed halfway —
  // the user quits, the machine sleeps — cannot leave a half file that `hasModel` believes.
  const partial = `${target}.part`
  await mkdir(dirname(target), { recursive: true })
  await rm(partial, { force: true })

  log(`downloading ${MODEL_URL}`)
  const ok = await new Promise<boolean>((resolve) => {
    // Electron's net, not node's https: it goes through Chromium's stack and so honours the
    // system proxy and the certificate store, which is what a corporate machine needs. It
    // also follows the HuggingFace redirect to the CDN without being told to.
    const request = net.request({ url: MODEL_URL, method: 'GET' })
    let file: ReturnType<typeof createWriteStream> | null = null

    const fail = (reason: string): void => {
      console.error(`[ezzy] speech model download failed: ${reason}`)
      file?.destroy()
      resolve(false)
    }

    request.on('error', (err) => fail(err.message))
    request.on('response', (response) => {
      // Electron types the response as a plain event emitter, but it is documented as
      // implementing the Readable stream interface and is one at runtime. The cast is what
      // lets it be piped, which is what keeps a 141MB download off the heap.
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
      // Piped rather than written chunk by chunk, so the stream pauses when the disk falls
      // behind. Counting in a `data` listener alongside the pipe is safe — the listener sees
      // every chunk and the pipe still owns the flow.
      file.on('finish', () => resolve(true))
      body.pipe(file)

      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total === 0) return
        const percent = Math.floor((received / total) * 100)
        // One IPC message per whole percent rather than per chunk: this is a 141MB download
        // and the chunks arrive in their thousands.
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
  return true
}

/** A complete ggml model, rather than an error page with a 200 on it. */
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
