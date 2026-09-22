/** whisper-server's lifecycle, and one POST of audio for one transcript. Started once and
 *  held in memory, on first hold of the hotkey rather than at launch. */

import { ChildProcess, spawn } from 'child_process'
import { request } from 'http'
import { createServer } from 'net'
import { cpus } from 'os'
import { dirname } from 'path'
import { log, since } from './verbose'
import { hasBinaries, hasModel, modelPath, serverExePath } from './whisper-model'

let child: ChildProcess | null = null
let starting = false
let port = 0
let listening = false
let waiters: Array<(ready: boolean) => void> = []

const THREADS = Math.max(2, Math.min(8, Math.floor(cpus().length / 2)))
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 120

/** Whisper always pads to 30s and encodes all of it; `audio_ctx` shortens that window and
 *  is the single biggest lever on latency. Measured on small.en-q5_1: 384 frames is where
 *  the curve flattens (1235ms vs 1450ms at 512, 192 twice as slow as either). */
const SHORT_AUDIO_CTX = 384
const SHORT_AUDIO_SECONDS = 7

const INFERENCE_TIMEOUT_MS = 20_000

export function isVoiceInstalled(): boolean {
  return hasBinaries()
}

export function startWhisperServer(): void {
  if (child || starting || !hasBinaries() || !hasModel()) return
  const startedAt = performance.now()
  starting = true

  void freePort().then((chosen) => {
    if (child) return
    port = chosen
    const exe = serverExePath()
    child = spawn(
      exe,
      [
        '--model',
        modelPath(),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--threads',
        String(THREADS),
        '--language',
        'en',
        '--no-timestamps',
        '--suppress-nst'
      ],
      {
        cwd: dirname(exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    child.stdout?.on('data', (data: Buffer) => log(`[whisper] ${data.toString().trim()}`))
    child.stderr?.on('data', (data: Buffer) => log(`[whisper] ${data.toString().trim()}`))
    child.on('error', (err) => {
      console.error(`[ezzy] could not start ${exe}:`, err)
      child = null
      starting = false
      settle(false)
    })
    child.on('exit', (code) => {
      if (!listening) console.error(`[ezzy] whisper-server exited with code ${code}`)
      else log(`whisper-server exited with code ${code}`)
      child = null
      listening = false
      starting = false
      settle(false)
    })

    void pollUntilListening(startedAt)
  })
}

export function whenReady(): Promise<boolean> {
  if (listening) return Promise.resolve(true)
  if (!child && !starting) return Promise.resolve(false)
  return new Promise((resolve) => waiters.push(resolve))
}

export function stopWhisperServer(): void {
  if (!child) return
  log('stopping whisper-server')
  child.kill()
  child = null
  listening = false
  starting = false
  settle(false)
}

function settle(ready: boolean): void {
  const pending = waiters
  waiters = []
  for (const resolve of pending) resolve(ready)
}

async function pollUntilListening(startedAt: number): Promise<void> {
  const deadline = performance.now() + READY_TIMEOUT_MS
  while (child && performance.now() < deadline) {
    if (await ping()) {
      listening = true
      starting = false
      since(`whisper-server ready on port ${port} (${THREADS} threads)`, startedAt)
      settle(true)
      return
    }
    await sleep(READY_POLL_MS)
  }
  if (!listening) {
    starting = false
    console.error('[ezzy] whisper-server did not come up in time')
    settle(false)
  }
}

function ping(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1_000 },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const chosen = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(chosen))
    })
    probe.on('error', () => resolve(0))
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function transcribe(wav: Buffer, prompt: string): Promise<string | null> {
  if (!listening) return null
  const startedAt = performance.now()

  const boundary = `----ezzy${Date.now().toString(16)}`
  const seconds = (wav.length - 44) / (16_000 * 2)
  const body = multipart(boundary, wav, prompt, seconds)

  return new Promise<string | null>((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/inference',
        method: 'POST',
        timeout: INFERENCE_TIMEOUT_MS,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            console.error(`[ezzy] whisper-server answered ${res.statusCode}: ${text.slice(0, 200)}`)
            resolve(null)
            return
          }
          since(`transcribed ${(wav.length / 32_000).toFixed(1)}s of audio`, startedAt)
          resolve(readTranscript(text))
        })
      }
    )
    req.on('error', (err) => {
      console.error('[ezzy] whisper-server request failed:', err)
      resolve(null)
    })
    req.on('timeout', () => {
      req.destroy()
      console.error('[ezzy] whisper-server did not answer in time')
      resolve(null)
    })
    req.end(body)
  })
}

function multipart(boundary: string, wav: Buffer, prompt: string, seconds: number): Buffer {
  const fields: Array<[string, string]> = [
    ['response_format', 'json'],
    ['no_timestamps', 'true'],
    ['language', 'en'],
    ['temperature', '0'],
    ['beam_size', '5'],
    ['prompt', prompt]
  ]
  if (seconds <= SHORT_AUDIO_SECONDS) fields.push(['audio_ctx', String(SHORT_AUDIO_CTX)])
  const parts: Buffer[] = []
  for (const [name, value] of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8'
      )
    )
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="utterance.wav"\r\n` +
        'Content-Type: audio/wav\r\n\r\n',
      'utf8'
    ),
    wav,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  )
  return Buffer.concat(parts)
}

interface InferenceResponse {
  text?: unknown
  error?: unknown
}

function readTranscript(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as InferenceResponse
    if (typeof parsed.error === 'string') {
      console.error(`[ezzy] whisper-server: ${parsed.error}`)
      return null
    }
    return typeof parsed.text === 'string' ? parsed.text : null
  } catch {
    console.error(`[ezzy] could not parse the transcript: ${payload.slice(0, 200)}`)
    return null
  }
}
