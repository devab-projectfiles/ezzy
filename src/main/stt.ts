/** whisper-server's lifecycle, and one POST of audio for one transcript.
 *
 *  Spawning `whisper-cli.exe` per command
 *  pays 150-600ms of model load *every time*. So the server is started once, holds the model
 *  in memory for as long as Ezzy runs, and every utterance is an HTTP POST to localhost. It is
 *  the difference between voice feeling like a feature and feeling like a wait.
 *
 *  It is deliberately not started at app launch. the cold start budget is 2s to tray-ready
 *  and loading base.en costs a good part of that on a cold file cache, for a feature most
 *  sessions never use — so the server comes up the first time the hotkey is held, and stays
 *  up from then on. The second command onward pays nothing. */

import { ChildProcess, spawn } from 'child_process'
import { request } from 'http'
import { createServer } from 'net'
import { cpus } from 'os'
import { dirname } from 'path'
import { log, since } from './verbose'
import { hasBinaries, hasModel, modelPath, serverExePath } from './whisper-model'

let child: ChildProcess | null = null
/** Set the moment a start is asked for, because the spawn itself is a tick or two behind it —
 *  a release that lands in that gap must wait for the server rather than conclude there is
 *  none. Cleared when the process is up, or when it turns out there will not be one. */
let starting = false
let port = 0
let listening = false
let waiters: Array<(ready: boolean) => void> = []

/** Half the cores, floored at two and capped at eight. Whisper scales with threads up to a
 *  point and then contends; taking every core would also make the machine stutter for the
 *  second the transcription runs, on a background app. */
const THREADS = Math.max(2, Math.min(8, Math.floor(cpus().length / 2)))

/** How long the server gets to load the model before we give up on it. base.en is 141MB off
 *  disk — a second warm, several cold. Generous because the alternative to waiting is telling
 *  the user their command failed when it was about to work. */
const READY_TIMEOUT_MS = 30_000

const READY_POLL_MS = 120

/** How much of whisper's 30-second encoder window one utterance actually needs.
 *
 *  Whisper always pads its input to 30s and encodes all of it, which is why a 1.3s command
 *  costs the same as a paragraph. `audio_ctx` shortens that window, and it is the single
 *  biggest lever on the voice budget — measured here on base.en, 8 threads, over four
 *  utterances: the full 1500 frames took 1061-1090ms and 512 took 426-439ms, for identical
 *  transcripts. 512 frames is a bit over 10 seconds of audio, which no spoken command comes
 *  near; anything longer is sent at full context rather than quietly truncated. */
const SHORT_AUDIO_CTX = 512
const SHORT_AUDIO_SECONDS = 9.5

/** A transcription that has not come back by now is not coming back. Budgets 1200ms for
 *  the whole voice path, so this is a stuck-process guard rather than a deadline. */
const INFERENCE_TIMEOUT_MS = 20_000

export function isVoiceInstalled(): boolean {
  return hasBinaries()
}

/** Start the server if it is not already up. Returns immediately — the model load happens in
 *  the background and `whenReady` is what waits for it. */
export function startWhisperServer(): void {
  if (child || starting || !hasBinaries() || !hasModel()) return
  const startedAt = performance.now()
  starting = true

  void freePort().then((chosen) => {
    // Two holds of the hotkey in quick succession both reach here; the second must not spawn
    // a second server on a second port.
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
        // Suppresses the "[BLANK_AUDIO]", "(upbeat music)" tags whisper emits for anything it
        // does not hear as speech. They are noise in a transcript that is about to be matched
        // against a command; the registry's normalisation drops the ones that get through anyway.
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
      // A crash mid-session is worth saying out loud: everything downstream of it just times
      // out otherwise, and "voice stopped working an hour in" is impossible to diagnose from
      // the symptom alone.
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

/** Wait for the server to answer. Resolves false if it never does, so the caller can say so
 *  rather than hanging on a promise that will not settle. */
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

/** whisper-server binds its port before it has finished loading the model, so "the port is
 *  open" is not the same as "it can answer". Its root page is served from the same handler
 *  chain as inference, so a 200 from it means the model is in memory. */
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

/** Ask the OS for a port nobody is using. A fixed port would collide with whatever else on the
 *  machine picked the same number — and a second copy of Ezzy cannot happen, but a second
 *  whisper-server from some other app certainly can. */
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

/** Transcribe one utterance. `prompt` is the highest-leverage mitigation for whisper never
 *  having heard of your software — see `voice.ts`, which builds it from what is installed.
 *
 *  Node's http rather than Electron's net, which is the opposite of the choice made for the
 *  model download: this request never leaves the machine, and pushing it through Chromium's
 *  stack would subject localhost to the system proxy for no benefit. */
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

/** The server takes its parameters as multipart fields alongside the audio, which is also how
 *  the prompt gets in per request rather than being fixed at spawn — so the app names it is
 *  seeded with are the ones installed now, not the ones installed when Ezzy started. */
function multipart(boundary: string, wav: Buffer, prompt: string, seconds: number): Buffer {
  const fields: Array<[string, string]> = [
    ['response_format', 'json'],
    ['no_timestamps', 'true'],
    ['language', 'en'],
    // Deterministic decoding. The fallback temperatures exist to recover from a bad sample on
    // long-form audio; on a two-second command they only add a re-decode.
    ['temperature', '0'],
    // Beam search rather than greedy decoding. Measured at +50ms on this machine with
    // audio_ctx below — the encoder is the expensive half and beams only touch the decoder —
    // which is a small price for the case it exists to fix: a word the greedy path commits to
    // early and then cannot back out of.
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
