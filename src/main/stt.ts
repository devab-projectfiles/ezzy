/** whisper-server's lifecycle, and one POST of audio for one transcript.
 *
 *  Spawning `whisper-cli.exe` per command pays 150-600ms of model load every time, so the
 *  server is started once and holds the model in memory for as long as Ezzy runs; every
 *  utterance after that is an HTTP POST to localhost.
 *
 *  Not started at app launch — loading the model costs a good part of the 2s cold-start
 *  budget, for a feature most sessions never use — so it comes up the first time the
 *  hotkey is held and stays up from then on. */

import { ChildProcess, spawn } from 'child_process'
import { request } from 'http'
import { createServer } from 'net'
import { cpus } from 'os'
import { dirname } from 'path'
import { log, since } from './verbose'
import { hasBinaries, hasModel, modelPath, serverExePath } from './whisper-model'

let child: ChildProcess | null = null
/** Set the moment a start is asked for, since the spawn itself lags a tick behind — a
 *  release landing in that gap must wait for the server rather than conclude there is none. */
let starting = false
let port = 0
let listening = false
let waiters: Array<(ready: boolean) => void> = []

/** Half the cores, floored at two and capped at eight — whisper contends past that
 *  point, and taking every core would stutter the machine for the second a
 *  transcription runs, on a background app. */
const THREADS = Math.max(2, Math.min(8, Math.floor(cpus().length / 2)))

/** How long the server gets to load the model before giving up. Generous, since the
 *  alternative to waiting is telling the user their command failed when it was about to
 *  work. */
const READY_TIMEOUT_MS = 30_000

const READY_POLL_MS = 120

/** How much of whisper's 30-second encoder window one utterance actually needs. Whisper
 *  always pads to 30s and encodes all of it, so a 1.3s command costs the same as a
 *  paragraph — `audio_ctx` shortens that window, and it is the single biggest lever on
 *  the voice budget. Measured on small.en-q5_1 over four runs of the same 2.3s command:
 *  512 frames averaged 1450ms, 384 averaged 1235ms (identical transcripts); 256 was no
 *  better and less consistent; 192 was twice as slow as either. 384 is where the curve
 *  flattens rather than turning back up.
 *
 *  384 frames is a bit under 8s of audio, so the cutoff tracks it — anything longer is
 *  sent at full context, slower but correct, never silently truncated. No spoken command
 *  comes near 7s; the recorder's own ceiling is 15. */
const SHORT_AUDIO_CTX = 384
const SHORT_AUDIO_SECONDS = 7

/** A transcription that has not come back by now is not coming back — a stuck-process
 *  guard rather than a deadline (the voice path budgets 1200ms overall). */
const INFERENCE_TIMEOUT_MS = 20_000

export function isVoiceInstalled(): boolean {
  return hasBinaries()
}

/** Start the server if it is not already up. Returns immediately — the model load
 *  happens in the background and `whenReady` is what waits for it. */
export function startWhisperServer(): void {
  if (child || starting || !hasBinaries() || !hasModel()) return
  const startedAt = performance.now()
  starting = true

  void freePort().then((chosen) => {
    // Two holds of the hotkey in quick succession both reach here — the second must not
    // spawn a second server on a second port.
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
        // English-only model, so language detection is a decode we can simply skip.
        '--language',
        'en',
        '--no-timestamps',
        // Suppresses "[BLANK_AUDIO]", "(upbeat music)" tags whisper emits for anything it
        // does not hear as speech; the registry's normalisation drops what gets through anyway.
        '--suppress-nst'
      ],
      {
        // The DLLs next to the exe are found relative to the process's directory.
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
      // A crash mid-session is worth saying out loud — otherwise everything downstream
      // just times out with no way to diagnose it from the symptom alone.
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

/** Wait for the server to answer. Resolves false if it never does, so the caller can say
 *  so rather than hanging on a promise that will not settle. */
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

/** whisper-server binds its port before it finishes loading the model, so "the port is
 *  open" is not the same as "it can answer". Its root page shares the inference handler
 *  chain, so a 200 from it means the model is in memory. */
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

/** Ask the OS for a port nobody is using — a fixed port could collide with some other
 *  app's own whisper-server on the same machine. */
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

// ------------------------------------------------------------------- inference

/** Transcribe one utterance. `prompt` is the highest-leverage mitigation for whisper
 *  never having heard of your software — see voice.ts, which builds it from what is
 *  installed.
 *
 *  Node's http rather than Electron's net — the opposite choice from the model download —
 *  since this request never leaves the machine and pushing localhost through Chromium's
 *  stack would subject it to the system proxy for no benefit. */
export async function transcribe(wav: Buffer, prompt: string): Promise<string | null> {
  if (!listening) return null
  const startedAt = performance.now()

  const boundary = `----ezzy${Date.now().toString(16)}`
  // 16kHz mono 16-bit, so two bytes a frame past the 44-byte header.
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

/** The server takes its parameters as multipart fields alongside the audio, which is
 *  also how the prompt gets in per request rather than fixed at spawn — so it always
 *  reflects the apps installed now, not the ones installed when Ezzy started. */
function multipart(boundary: string, wav: Buffer, prompt: string, seconds: number): Buffer {
  const fields: Array<[string, string]> = [
    ['response_format', 'json'],
    ['no_timestamps', 'true'],
    ['language', 'en'],
    // Deterministic decoding — the fallback temperatures exist to recover from a bad
    // sample on long-form audio, and on a two-second command they only add a re-decode.
    ['temperature', '0'],
    // Beam search over greedy: measured +50ms with audio_ctx below (the encoder is the
    // expensive half; beams only touch the decoder), a small price for the case it fixes
    // — a word greedy commits to early and cannot back out of. Still true on the larger
    // model: measured over the same utterance, beam 5 took 1935-1966ms and greedy
    // 1831-1863ms — a hundred milliseconds, while audio_ctx is the real lever.
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
