/** Where whisper's files are, and getting the one we do not ship.
 *
 *  * The binaries ship with the app — they cannot live inside the asar, so they go in
 *    `extraResources` and resolve through `process.resourcesPath` in a packaged build,
 *    through the repo in dev. Not in git either — `scripts/fetch-whisper.mjs` fetches
 *    them, and a clone that has not run it has no voice until it does.
 *  * The model is downloaded on first run rather than bundled — a ~90MB installer against
 *    a ~230MB one. It lands in userData, so it survives an update and an uninstall leaves
 *    it with the rest of the app's data.
 */

import { app, net } from 'electron'
import type { Readable } from 'stream'
import { createWriteStream, existsSync, statSync } from 'fs'
import { mkdir, open, rename, rm } from 'fs/promises'
import { dirname, join } from 'path'
import { log, since } from './verbose'

/** `small`, English-only, quantised to 5 bits. This replaced `base.en` (141MB) after a
 *  specific failure: asked quietly for "next track on Spotify", base returned "Make a
 *  scene on Spotify" — fluent, grammatical, and wrong, the signature of a model guessing
 *  past its acoustic capacity rather than returning noise.
 *
 *  `small` has roughly three times base's capacity, and q5_1 quantisation keeps it
 *  affordable — 181MB against 465MB for the unquantised model, at a much smaller accuracy
 *  cost than the small/base gap it is buying back. The price is latency: measured on this
 *  machine, base transcribed a 2.5s command in 625ms and small takes a few times that. */
const MODEL_FILE = 'ggml-small.en-q5_1.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`

/** What the file should weigh, from the release it is pinned to — used only as a floor
 *  against a truncated download, the common failure. */
const MODEL_MIN_BYTES = 170_000_000

/** Models this app used to ship. Left on disk they are dead weight nothing else will
 *  ever delete, since they live in Ezzy's own userData — removed only after the
 *  replacement has been verified. */
const SUPERSEDED = ['ggml-base.en.bin', 'ggml-tiny.en.bin']

/** ggml's magic number, as the four bytes it is written as on a little-endian machine.
 *  Checked because HuggingFace answers an outage with an HTML error page and a 200, and
 *  a 120KB "model" whisper-server then refuses to load is a far more confusing failure
 *  than a download that says it failed. */
const GGML_MAGIC = Buffer.from([0x6c, 0x6d, 0x67, 0x67])

export interface DownloadProgress {
  /** 0-100. Stays at 0 while the server has not said how big the file is. */
  percent: number
}

/** In dev, the repo's own `resources/whisper`; in a packaged build, next to the asar —
 *  native binaries cannot load out of it. */
function whisperDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'whisper')
    : join(app.getAppPath(), 'resources', 'whisper')
}

export function serverExePath(): string {
  return join(whisperDir(), 'whisper-server.exe')
}

/** False on a clone that has not run `npm run fetch:whisper` — the one case where voice
 *  is missing rather than broken. */
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

/** Fetch the model if it is not already here. Concurrent callers share one download —
 *  holding the hotkey twice while it runs must not start a second one.
 *
 *  Resolves false rather than throwing: a failed download is an ordinary state of the
 *  world, and the caller's job is to say so rather than handle an exception. */
export function ensureModel(onProgress: (progress: DownloadProgress) => void): Promise<boolean> {
  if (hasModel()) return Promise.resolve(true)
  if (!downloading) {
    downloading = download(onProgress).finally(() => {
      downloading = null
    })
  }
  return downloading
}

/** True while a download is in flight, so the caller can report progress rather than
 *  starting another one. */
export function isDownloading(): boolean {
  return downloading !== null
}

async function download(onProgress: (progress: DownloadProgress) => void): Promise<boolean> {
  const startedAt = performance.now()
  const target = modelPath()
  // Written under a temporary name and renamed at the end, so a download killed halfway
  // cannot leave a half file that `hasModel` believes.
  const partial = `${target}.part`
  await mkdir(dirname(target), { recursive: true })
  await rm(partial, { force: true })

  log(`downloading ${MODEL_URL}`)
  const ok = await new Promise<boolean>((resolve) => {
    // Electron's net, not node's https — goes through Chromium's stack, honouring the
    // system proxy and certificate store, and follows the HuggingFace redirect for free.
    const request = net.request({ url: MODEL_URL, method: 'GET' })
    let file: ReturnType<typeof createWriteStream> | null = null

    const fail = (reason: string): void => {
      console.error(`[ezzy] speech model download failed: ${reason}`)
      file?.destroy()
      resolve(false)
    }

    request.on('error', (err) => fail(err.message))
    request.on('response', (response) => {
      // Electron types the response as a plain event emitter, but it implements the
      // Readable stream interface at runtime — the cast is what lets it be piped.
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
      // Piped rather than written chunk by chunk, so the stream pauses when the disk
      // falls behind — the `data` listener alongside it still sees every chunk.
      file.on('finish', () => resolve(true))
      body.pipe(file)

      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total === 0) return
        const percent = Math.floor((received / total) * 100)
        // One IPC message per whole percent, not per chunk — the chunks arrive in thousands.
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

/** Delete the models this app used to use, once the replacement is on disk and verified.
 *  A fixed list rather than "every ggml file that is not the current one" — a rule that
 *  deletes whatever it does not recognise is one bad edit from deleting the model in
 *  use. Failure is ignored — a file that will not delete is wasted disk, not a broken
 *  install. */
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
