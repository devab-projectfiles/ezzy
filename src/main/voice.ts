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
import { getConfig } from './config'
import { activeHotkey, watchHold } from './hotkey'
import { hush, speak } from './speech'
import { isVoiceInstalled, startWhisperServer, transcribe, whenReady } from './stt'
import { log, since } from './verbose'
import { ensureModel, hasModel, isDownloading } from './whisper-model'
import { listWindows } from './window-tracker'
import { hidePanel, sendCapture, sendVoiceState, showPanelForVoice } from './windows'

let state: VoiceState = { kind: 'idle' }
/** The microphone is open and buffering. Set on the press, before it is known whether this
 *  will be a hold — see `armCapture`. */
let armed = false
/** The press became a hold, so what is being buffered is a command. */
let capturing = false
/** Resolves when the renderer hands the recording over, or when it says it cannot. */
let pendingAudio: ((wav: Buffer | null) => void) | null = null
/** A microphone failure from a press that never became a hold. Held rather than announced:
 *  the user was opening the panel, not asking to speak. The next hold reports it instead of
 *  waiting four seconds for audio that cannot come. */
let armFailure: VoiceFailure | null = null
let clearStateTimer: ReturnType<typeof setTimeout> | null = null
/** What whisper heard for the command currently in flight, or null before there is a
 *  transcript. Chunk E shows it: a mangled name is the commonest reason a command misses, and
 *  "I couldn't find Sigma" only makes sense next to the word that produced it. */
let heard: string | null = null

/** The renderer has to stop the stream, encode a WAV and send it. If that has not happened by
 *  now, something in it has failed in a way it did not report. */
const AUDIO_TIMEOUT_MS = 4_000

/** How long an error stays on screen before the surface goes back to being a search bar.
 *  Long enough to read a short sentence, short enough not to be in the way of a retry. */
const ERROR_MS = 4_000

/** A confirmation is shorter-lived than a failure: the user asked for it, it happened, and the
 *  window they wanted is already in front of them. This is long enough to catch out of the
 *  corner of an eye and confirm what was heard, and no longer. */
const DONE_MS = 2_600

/** A WAV header is 44 bytes and 16kHz mono PCM is 32,000 bytes a second, so this is a quarter
 *  of a second of audio. Below it the hold was a slip, not a command — usually a tap that
 *  crossed the hold threshold — and it is worth saying "I didn't catch that" without paying
 *  for a transcription first. */
const MIN_AUDIO_BYTES = 44 + 8_000

/** Whisper's prompt is capped at a couple of hundred tokens, and it has to leave room for the
 *  command phrasings that go in front of the names — those are what bias it towards hearing a
 *  command at all. Forty names covers everything anyone switches to by voice. */
const PROMPT_NAMES = 40
const PROMPT_MAX_CHARS = 400

export function initVoice(): void {
  registerBuiltinCommands()
  watchHold({
    onPress: () => armCapture(),
    onHold: () => void beginListening(),
    onRelease: (held) => void (held ? finishListening() : cancelCapture())
  })
  log(isVoiceInstalled() ? 'voice: whisper.cpp found' : 'voice: whisper.cpp is not installed')
}

export function voiceState(): VoiceState {
  return state
}

function setState(next: VoiceState): void {
  state = next
  sendVoiceState(next)
  if (clearStateTimer) clearTimeout(clearStateTimer)
  clearStateTimer = null
  // The two terminal states clear themselves; the rest are cleared by whatever happens next.
  const linger = next.kind === 'error' ? ERROR_MS : next.kind === 'done' ? DONE_MS : 0
  if (linger === 0) return
  clearStateTimer = setTimeout(() => setState({ kind: 'idle' }), linger)
}

/** A command that could not be carried out. §8 chunk E: "a failed command is as clear as a
 *  successful one" — which is why this both draws it and says it out loud. Spoken matters more
 *  here than for a success: the user is looking at the app they expected to be switched away
 *  from, not at the dot. */
function fail(message: string, micBlocked = false): void {
  log(`voice: ${message}`)
  setState({ kind: 'error', message, micBlocked, heard: heard ?? undefined })
  // §5: a blocked microphone has to lead somewhere rather than to a dead button, and the
  // button it leads to lives on the search bar. So this one failure brings the panel up even
  // when the preference says voice should stay on the dot — a sentence about a blocked device
  // with no way to act on it is exactly the dead end that rule is about.
  if (micBlocked) {
    showPanelForVoice()
    // The panel has just opened over the pill, so the message is routed again: the search bar
    // takes it and the pill lets go of it.
    sendVoiceState(state)
  }
  speak(message, 'failure')
}

// ------------------------------------------------------------------ listening

/** The hotkey has gone down. Nobody knows yet whether this is a tap or a command, and that is
 *  exactly why the microphone opens here rather than 350ms later.
 *
 *  Measured: `getUserMedia` takes 300-960ms to hand back a stream. Starting it at the hold
 *  threshold meant the device was still opening while the user was already speaking, and the
 *  verb went missing — "open antigravity" arrived as "antigravity", which is most of what was
 *  behind commands being understood and then refused.
 *
 *  The cost is that Windows' microphone indicator blinks on every panel open, including taps
 *  that never record. Nothing is sent anywhere for a tap: `cancelCapture` throws the buffer
 *  away and closes the device. */
function armCapture(): void {
  if (armed || !isVoiceInstalled() || !hasModel()) return
  armed = true
  // Started here rather than at launch and left running afterwards — §5's "model load is the
  // real latency". The first command of a session waits for it; the rest do not.
  startWhisperServer()
  sendCapture('arm')
}

function cancelCapture(): void {
  if (!armed) return
  armed = false
  capturing = false
  sendCapture('cancel')
}

async function beginListening(): Promise<void> {
  if (capturing) return
  // Stop any confirmation still playing, before the microphone that is about to open hears
  // Ezzy talking about the last command.
  hush()
  heard = null

  if (!isVoiceInstalled()) {
    fail(
      app.isPackaged
        ? 'Speech files are missing from this install'
        : 'Voice needs whisper.cpp — run npm run fetch:whisper'
    )
    return
  }

  // Whether the panel comes up for this is the user's call (`voicePanel`). Off — the default
  // — the dot's pill carries the whole exchange and nothing covers what you were reading. On,
  // it is chunk D's behaviour: the hold may have arrived on a closed panel, or on one the
  // press just closed, so it has to be brought back up for the search bar to report on.
  if (getConfig().voicePanel) showPanelForVoice()
  // Quiet mode has to CLOSE a panel rather than not open one: the press toggles it before
  // anyone knows this is a hold, and that is deliberate — §7 gives the tap a 50ms budget from
  // the press, so the panel cannot wait 350ms to find out what kind of press it was.
  else hidePanel()

  if (!hasModel()) {
    void fetchModel()
    return
  }

  // The microphone has been buffering since the press; this only decides that what it has is
  // going to be a command.
  if (!armed) armCapture()
  if (!armed && armFailure !== null) {
    reportFailure(armFailure)
    return
  }
  capturing = true
  setState({ kind: 'listening' })
}

async function finishListening(): Promise<void> {
  if (!capturing) {
    cancelCapture()
    return
  }
  capturing = false
  armed = false
  const releasedAt = performance.now()
  sendCapture('stop')
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

  const raw = await transcribe(wav, whisperPrompt())
  if (raw === null) {
    fail('I couldn’t transcribe that')
    return
  }

  const text = normaliseTranscript(raw)
  log(`voice: heard "${raw.trim()}" -> "${text}"`)
  if (text === '') {
    fail('I didn’t catch that')
    return
  }
  // The normalised form, not the raw one: it is what the commands were matched against, so it
  // is the honest answer to "what did you think I said".
  heard = text

  const outcome = await runCommand(text)
  if (outcome === null) {
    fail(`I didn’t understand "${text}"`)
    return
  }
  if (!outcome.ok) {
    fail(outcome.message)
    return
  }
  // §7: act before you speak. The command has already put the window in front by the time
  // either of these lines runs — neither the pill nor the confirmation is allowed to sit
  // between the user finishing their sentence and the window appearing.
  //
  // The panel went with it, so the dot's pill is what draws this: it is the one surface that
  // outlives a successful command (see sendVoiceState).
  setState({ kind: 'done', message: outcome.message, heard: text })
  speak(outcome.message, 'success')
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
  // The device answered, so whatever went wrong last time is over.
  armFailure = null
  pendingAudio?.(wav)
}

/** The dot's renderer could not record at all. §5: a blocked microphone has to lead somewhere,
 *  so the message that goes with `micBlocked` is paired with a button in the search bar. */
export function reportCaptureFailure(kind: VoiceFailure): void {
  const wasListening = capturing
  armed = false
  capturing = false
  armFailure = kind
  pendingAudio?.(null)
  // A microphone that could not be opened during a press is not worth interrupting a tap
  // over — the user was opening the panel, not asking to speak.
  if (!wasListening) {
    log(`voice: microphone unavailable (${kind})`)
    return
  }
  reportFailure(kind)
}

function reportFailure(kind: VoiceFailure): void {
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

  // Whole sentences in the shapes the commands are written in, not a bare vocabulary list: the
  // prompt is prior *text* and whisper conditions on it as language. Giving it "Switch to
  // Antigravity." makes both the verb and the name likelier, and the verb matters as much as
  // the name — a command whose verb was misheard is a command that does not run.
  const examples = [
    `Switch to ${names[0] ?? 'Chrome'}.`,
    `Open ${names[1] ?? 'Notepad'}.`,
    'Close this window.'
  ].join(' ')
  return `${examples} Apps: ${list}.`
}
