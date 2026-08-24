/** Push-to-talk, end to end (PLAN.md §8 chunk D).
 *
 *  Hold the hotkey, speak, let go: the panel is already open from the press, the microphone
 *  opens 350ms into the hold, and the release is what sends the audio to whisper-server and
 *  runs whatever came back.
 *
 *  Holding the *same* key that opens the panel is what makes this one gesture rather than two
 *  features. A tap opens the panel and never touches this file — §7 is explicit that the
 *  keyboard path must never touch whisper, and it does not: nothing here runs, and no model is
 *  even loaded, until the first time someone holds the key.
 *
 *  The recording itself happens in the dot's renderer, because `getUserMedia` is a web API and
 *  the main process does not have one. See `renderer/src/recorder.ts`. */

import { app } from 'electron'
import { VoiceFailure, VoiceState } from '../shared/types'
import { indexedApps } from './app-index'
import { registerBuiltinCommands } from './commands/builtin'
import { normaliseTranscript, runCommand } from './commands/registry'
import { activeHotkey, watchHold } from './hotkey'
import { isVoiceInstalled, startWhisperServer, transcribe, whenReady } from './stt'
import { log, since } from './verbose'
import { ensureModel, hasModel, isDownloading } from './whisper-model'
import { listWindows } from './window-tracker'
import { sendVoiceState, showPanelForVoice, startCapture, stopCapture } from './windows'

let state: VoiceState = { kind: 'idle' }
/** Set between the hold starting and the audio arriving. */
let capturing = false
/** Resolves when the renderer hands the recording over, or when it says it cannot. */
let pendingAudio: ((wav: Buffer | null) => void) | null = null
let clearErrorTimer: ReturnType<typeof setTimeout> | null = null

/** The renderer has to stop the stream, encode a WAV and send it. If that has not happened by
 *  now, something in it has failed in a way it did not report. */
const AUDIO_TIMEOUT_MS = 4_000

/** How long an error stays on the search bar before it goes back to being a search bar. Long
 *  enough to read a short sentence, short enough not to be in the way of a retry. */
const ERROR_MS = 4_000

/** A WAV header is 44 bytes and 16kHz mono PCM is 32,000 bytes a second, so this is a quarter
 *  of a second of audio. Below it the hold was a slip, not a command — usually a tap that
 *  crossed the hold threshold — and it is worth saying "I didn't catch that" without paying
 *  for a transcription first. */
const MIN_AUDIO_BYTES = 44 + 8_000

/** Whisper's prompt is a few hundred tokens at most, and a list this long already covers
 *  every app anyone switches to by voice. */
const PROMPT_NAMES = 60
const PROMPT_MAX_CHARS = 600

export function initVoice(): void {
  registerBuiltinCommands()
  watchHold({
    onHold: () => void beginListening(),
    onRelease: () => void finishListening()
  })
  log(isVoiceInstalled() ? 'voice: whisper.cpp found' : 'voice: whisper.cpp is not installed')
}

export function voiceState(): VoiceState {
  return state
}

function setState(next: VoiceState): void {
  state = next
  sendVoiceState(next)
  if (clearErrorTimer) clearTimeout(clearErrorTimer)
  clearErrorTimer = null
  if (next.kind !== 'error') return
  clearErrorTimer = setTimeout(() => setState({ kind: 'idle' }), ERROR_MS)
}

function fail(message: string, micBlocked = false): void {
  log(`voice: ${message}`)
  setState({ kind: 'error', message, micBlocked })
}

// ------------------------------------------------------------------ listening

async function beginListening(): Promise<void> {
  if (capturing) return

  if (!isVoiceInstalled()) {
    fail(
      app.isPackaged
        ? 'Speech files are missing from this install'
        : 'Voice needs whisper.cpp — run npm run fetch:whisper'
    )
    return
  }

  // The hold may have arrived on a closed panel, or on one the press just closed. Either way
  // the search bar is where everything below is reported, so it has to be up.
  showPanelForVoice()

  if (!hasModel()) {
    void fetchModel()
    return
  }

  // Started on the first hold rather than at launch, and left running afterwards — §5's
  // "model load is the real latency". The first command of a session waits for it; the rest
  // do not.
  startWhisperServer()

  capturing = true
  setState({ kind: 'listening' })
  startCapture()
}

async function finishListening(): Promise<void> {
  if (!capturing) return
  capturing = false
  const releasedAt = performance.now()
  stopCapture()
  setState({ kind: 'thinking' })

  const wav = await audioFromRenderer()
  // A capture failure reports itself through `reportCaptureFailure`, which has already put a
  // more specific message on screen than anything that could be said here.
  if (!wav || wav.length < MIN_AUDIO_BYTES) {
    if (state.kind === 'thinking') fail('I didn’t catch that')
    return
  }

  // The server may still be loading the model, which on the first command of a session is the
  // longest part of the wait. Waiting is right: the alternative is telling the user their
  // command failed a second before it would have worked.
  if (!(await whenReady())) {
    fail('The speech engine didn’t start')
    return
  }

  const heard = await transcribe(wav, whisperPrompt())
  if (heard === null) {
    fail('I couldn’t transcribe that')
    return
  }

  const text = normaliseTranscript(heard)
  log(`voice: heard "${heard.trim()}" -> "${text}"`)
  if (text === '') {
    fail('I didn’t catch that')
    return
  }

  const outcome = await runCommand(text)
  if (outcome === null) {
    fail(`I don’t know how to "${text}"`)
    return
  }
  if (!outcome.ok) {
    fail(outcome.message)
    return
  }
  // §7: act before you speak. The command has already put the window in front by the time
  // this line runs, and the panel went with it — there is nothing left to show.
  setState({ kind: 'idle' })
  since(`voice: key release -> ${outcome.message}`, releasedAt)
}

/** The recording, or null if it never arrived. */
function audioFromRenderer(): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAudio = null
      console.error('[ezzy] the recorder never sent any audio')
      resolve(null)
    }, AUDIO_TIMEOUT_MS)
    pendingAudio = (wav) => {
      clearTimeout(timer)
      pendingAudio = null
      resolve(wav)
    }
  })
}

/** The dot's renderer has finished recording. */
export function receiveAudio(wav: Buffer): void {
  log(`voice: ${(wav.length / 1024).toFixed(0)}KB of audio`)
  pendingAudio?.(wav)
}

/** The dot's renderer could not record at all. §5: a blocked microphone has to lead somewhere,
 *  so the message that goes with `micBlocked` is paired with a button in the search bar. */
export function reportCaptureFailure(kind: VoiceFailure): void {
  capturing = false
  pendingAudio?.(null)
  switch (kind) {
    case 'denied':
      fail('Microphone access is blocked for Ezzy', true)
      return
    case 'no-device':
      fail('No microphone found')
      return
    default:
      fail('The microphone wouldn’t start')
  }
}

// ------------------------------------------------------------------- the model

async function fetchModel(): Promise<void> {
  if (isDownloading()) return
  setState({ kind: 'downloading', percent: 0 })
  const ok = await ensureModel(({ percent }) => {
    // A later state — an error, a command — must not be overwritten by a progress event that
    // was already in flight.
    if (state.kind === 'downloading') setState({ kind: 'downloading', percent })
  })
  if (!ok) {
    const hotkey = activeHotkey()
    fail(`Speech model download failed${hotkey ? ` — hold ${hotkey} to retry` : ''}`)
    return
  }
  setState({ kind: 'idle' })
  // Load it now rather than making the next hold wait for both.
  startWhisperServer()
}

/** §5's highest-leverage mitigation, and the reason "open n8n" has any chance at all: whisper
 *  has never heard of the software on this machine, so it is told what is on it.
 *
 *  Open windows first — the thing someone is switching to is almost always already running —
 *  then the installed apps in the order the index holds them. */
function whisperPrompt(): string {
  const names: string[] = []
  const seen = new Set<string>()
  const add = (name: string): void => {
    const key = name.trim().toLowerCase()
    if (key === '' || seen.has(key) || names.length >= PROMPT_NAMES) return
    seen.add(key)
    names.push(name.trim())
  }
  for (const window of listWindows()) add(window.app)
  for (const entry of indexedApps()) add(entry.name)

  let list = names.join(', ')
  if (list.length > PROMPT_MAX_CHARS) list = list.slice(0, list.lastIndexOf(', ', PROMPT_MAX_CHARS))
  // Phrased as a sentence rather than a bare list: the prompt is prior *text*, and whisper
  // conditions on it as language, not as a vocabulary.
  return `Voice commands for a window switcher. Switch to or open: ${list}.`
}
