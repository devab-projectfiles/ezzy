/** Push-to-talk. Hold the hotkey, speak, let go: the panel is already open from the press, the
 *  mic opens partway into the hold, and release sends the audio to whisper-server. A tap never
 *  touches this file or loads a model — only a hold does.
 *
 *  Recording happens in the dot's renderer (`getUserMedia` is a web API); see recorder.ts. */

import { app } from 'electron'
import { VoiceFailure, VoiceState } from '../shared/types'
import { indexedApps } from './app-index'
import { registerBuiltinCommands } from './commands/builtin'
import { duckForListening, restoreAfterListening } from './commands/playback'
import {
  isSilenceArtefact,
  normaliseTranscript,
  runCommand,
  setCustomPhrases,
  verifyExamples
} from './commands/registry'
import { getConfig } from './config'
import { activeHotkey, watchHold } from './hotkey'
import { hush, speak } from './speech'
import {
  isVoiceInstalled,
  startWhisperServer,
  stopWhisperServer,
  transcribe,
  whenReady
} from './stt'
import { log, since } from './verbose'
import { ensureModel, hasModel, isDownloading } from './whisper-model'
import { listWindows } from './window-tracker'
import { hidePanel, onPanelHidden, sendCapture, sendVoiceState, showPanelForVoice } from './windows'

let state: VoiceState = { kind: 'idle' }
/** Mic is open and buffering, set on the press before it is known whether this is a hold. */
let armed = false
/** The press became a hold, so what is being buffered is a command. */
let capturing = false
/** Whether the recorder has confirmed the mic is delivering audio — a cold open takes
 *  225-960ms, which is the difference between "Listening..." and "Getting ready...". */
let micLive = false
/** When the mic was requested, so the wait can be measured. */
let armedAt = 0
/** Started by the mic button (a click) rather than the hotkey (a hold) — a click has no
 *  release to end it, unlike a held key. */
let fromButton = false

/** What the renderer hands back for one hold. `spoke` is measured from the signal (see
 *  `hasSpeech` in the recorder) — whisper never returns nothing, so the transcript alone
 *  cannot tell silence from speech. */
interface Recording {
  wav: Buffer
  spoke: boolean
}

/** Resolves when the renderer hands the recording over, or when it says it cannot. */
let pendingAudio: ((recording: Recording | null) => void) | null = null
/** A mic failure from a press that never became a hold — held rather than announced, and
 *  reported on the next real hold instead. */
let armFailure: VoiceFailure | null = null
let clearStateTimer: ReturnType<typeof setTimeout> | null = null
/** What whisper heard for the command in flight, shown next to a miss. */
let heard: string | null = null

/** If the renderer has not sent audio by now, something failed silently. */
const AUDIO_TIMEOUT_MS = 4_000

/** Covers thinking, speaking and the recorder's own end-of-utterance detection. */
const HANDS_FREE_TIMEOUT_MS = 20_000

/** How long an error stays on screen before reverting to the search bar. */
const ERROR_MS = 4_000

/** Shorter than an error — the window the user wanted is already in front of them. */
const DONE_MS = 2_600

/** ~0.25s of 16kHz mono PCM. Below this the hold was a slip, not worth transcribing. */
const MIN_AUDIO_BYTES = 44 + 8_000

/** Deliberately not "I didn't catch that" — nothing was said, so this says what to do
 *  instead. Kept under 37 chars; the pill clips rather than wraps. */
const NOTHING_HEARD = 'I didn’t hear anything — say a command'

/** Whisper's prompt context is ~448 tokens and whisper.cpp keeps at most half as prior
 *  text — so this is "which forty names are worth a token", not "fit them all". */
const PROMPT_NAMES = 40
/** Trimmed from 400 to leave room for the command-phrasing examples, which fix more misses
 *  than extra app names do. */
const PROMPT_MAX_CHARS = 320

export function initVoice(): void {
  registerBuiltinCommands()
  // Runs after commands exist: verifies each phrase's canonical rewrite is still accepted
  // by its own command.
  verifyExamples()
  setCustomPhrases(getConfig().phrases)
  watchHold({
    onPress: () => armCapture(),
    onHold: () => void beginListening(),
    onRelease: (held) => void (held ? finishListening() : cancelCapture())
  })
  // Closing the panel takes the mic button's session with it — the recording is dropped.
  onPanelHidden(() => {
    if (!fromButton || !capturing) return
    log('voice: panel closed while listening, dropping the recording')
    endButtonSession()
    cancelCapture()
    setState({ kind: 'idle' })
  })
  log(isVoiceInstalled() ? 'voice: whisper.cpp found' : 'voice: whisper.cpp is not installed')
}

export function voiceState(): VoiceState {
  return state
}

/** The search bar's mic button — a click, not a hold. First click opens the mic, second
 *  sends what it heard; unlike the hotkey there is no head start on `getUserMedia`. */
export function toggleListening(): void {
  if (!getConfig().voice) {
    // A hotkey hold may not have been meant as one; a mic click is unambiguous.
    fail('Voice is off — turn it on in Settings')
    return
  }
  // Reachable only by reopening the panel mid-session; treated as "I'm done".
  if (capturing) {
    void finishListening()
    return
  }
  fromButton = true
  void listenHandsFree()
}

function endButtonSession(): void {
  fromButton = false
}

/** Voice just switched off in Settings. Frees whisper-server's ~300MB now rather than just
 *  refusing future holds, and cancels any press in flight. */
export function releaseVoice(): void {
  if (getConfig().voice) return
  cancelCapture()
  stopWhisperServer()
  if (state.kind !== 'idle') setState({ kind: 'idle' })
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

/** A command that failed — drawn AND spoken, since the user is looking at the app they
 *  expected to leave, not at the dot. */
function fail(message: string, micBlocked = false): void {
  log(`voice: ${message}`)
  setState({ kind: 'error', message, micBlocked, heard: heard ?? undefined })
  // A blocked mic has to lead somewhere: brings the panel up even in quiet mode.
  if (micBlocked) {
    showPanelForVoice()
    // The panel just opened over the pill, so the message is re-sent for the search bar.
    sendVoiceState(state)
  }
  speak(message, 'failure')
}

// ------------------------------------------------------------------ listening

/** The hotkey went down; nobody knows yet if this is a tap. The mic opens HERE rather than
 *  at the hold threshold — measured 300-960ms to open, and starting later clipped the first
 *  word ("open antigravity" arrived as "antigravity"). Costs a mic-indicator blink on every
 *  tap, but nothing from a tap is ever sent (`cancelCapture` throws it away). */
function armCapture(): void {
  if (armed || !getConfig().voice || !isVoiceInstalled() || !hasModel()) return
  armed = true
  micLive = false
  armedAt = performance.now()
  // Hushed on the press, not the hold: echo cancellation is off, so the mic hears Ezzy's
  // own voice, and hushing later left the tail of the last reply glued to the new recording.
  hush()
  // Before sendCapture — every ms here comes out of the user's first word.
  sendCapture('arm')
  // Started here and left running — the first command of a session pays for the model
  // load, the rest do not.
  startWhisperServer()
}

function cancelCapture(): void {
  if (!armed) return
  armed = false
  capturing = false
  // Nothing is paused by a press, only a hold — but a hold can be abandoned.
  restoreAfterListening()
  sendCapture('cancel')
}

/** Stops music for the recording, if enabled — echo cancellation cannot do this. */
function quieten(): void {
  if (getConfig().duckMusic) duckForListening()
}

async function beginListening(source: 'hotkey' | 'mic-button' = 'hotkey'): Promise<void> {
  if (capturing) return
  // Voice off: a hold is just a long tap, and the panel the press opened is already where
  // they can type instead.
  if (!getConfig().voice) return
  // Stop any confirmation before the mic that is about to open hears it.
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

  // Skipped when the mic BUTTON started it — the panel is already open and in use.
  if (source === 'hotkey') {
    // voicePanel off (default): the pill carries the exchange. On: the panel comes back up
    // for the search bar to report. Quiet mode has to CLOSE a panel the press just opened.
    if (getConfig().voicePanel) showPanelForVoice()
    else hidePanel()
  }

  if (!hasModel()) {
    void fetchModel()
    return
  }

  // The mic has been buffering since the press; this only commits to it being a command.
  if (!armed) armCapture()
  if (!armed && armFailure !== null) {
    reportFailure(armFailure)
    return
  }
  capturing = true
  quieten()
  // "Listening" only if the device has already answered; otherwise "getting ready" until
  // reportMicLive promotes it.
  setState({ kind: micLive ? 'listening' : 'arming' })
}

async function finishListening(): Promise<void> {
  if (!capturing) {
    cancelCapture()
    endButtonSession()
    return
  }
  endButtonSession()
  capturing = false
  armed = false
  const releasedAt = performance.now()
  sendCapture('stop')
  restoreAfterListening()
  setState({ kind: 'thinking' })
  await transcribeAndRun(await audioFromRenderer(), releasedAt)
}

/** The mic button's session, ended by the recorder rather than a key release. Panel closes
 *  on the way in; nothing is clicked to finish — the recorder detects end-of-sentence and
 *  sends. */
async function listenHandsFree(): Promise<void> {
  if (capturing) {
    endButtonSession()
    return
  }
  hush()
  heard = null

  if (!isVoiceInstalled()) {
    fail(
      app.isPackaged
        ? 'Speech files are missing from this install'
        : 'Voice needs whisper.cpp — run npm run fetch:whisper'
    )
    endButtonSession()
    return
  }
  // Closed first, so the user is talking to the dot, not a window over what they were
  // reading.
  hidePanel()
  if (!hasModel()) {
    void fetchModel()
    endButtonSession()
    return
  }

  startWhisperServer()
  armed = true
  capturing = true
  micLive = false
  armedAt = performance.now()
  setState({ kind: 'arming' })
  sendCapture('listen')
  quieten()

  const recording = await audioFromRenderer(HANDS_FREE_TIMEOUT_MS)
  restoreAfterListening()
  // The recorder decides when the sentence ended — this is the first moment main knows.
  const finishedAt = performance.now()
  capturing = false
  armed = false
  endButtonSession()
  if (state.kind === 'listening' || state.kind === 'arming') setState({ kind: 'thinking' })
  await transcribeAndRun(recording, finishedAt)
}

/** Everything both gestures do once there is a recording: transcribe it and run what it says. */
async function transcribeAndRun(recording: Recording | null, releasedAt: number): Promise<void> {
  // A capture failure already reported its own message via reportCaptureFailure.
  if (!recording || recording.wav.length < MIN_AUDIO_BYTES) {
    if (state.kind === 'thinking') fail('I didn’t catch that')
    return
  }

  // Silence still transcribes to a sentence that gets acted on, so this is checked first.
  if (!recording.spoke) {
    log('voice: the recording holds no speech')
    fail(NOTHING_HEARD)
    return
  }
  const wav = recording.wav

  // The server may still be loading the model on the first command of a session.
  if (!(await whenReady())) {
    fail('The speech engine didn’t start')
    return
  }

  // Logged in full — the only way to see what whisper was actually told.
  const prompt = whisperPrompt()
  log(`voice: prompt "${prompt}"`)
  const raw = await transcribe(wav, prompt)
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
  // Catches what the signal test misses (a cough, a door). `heard` stays unset for these,
  // so a made-up sentence is never quoted back as something the user said.
  if (isSilenceArtefact(text)) {
    log(`voice: "${text}" is what whisper writes over a room, not a command`)
    fail(NOTHING_HEARD)
    return
  }
  // The normalised form — it is what commands were actually matched against.
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
  // Act before you speak — the command has already switched windows by the time either of
  // these lines runs. The panel is gone, so the dot's pill draws this.
  setState({ kind: 'done', message: outcome.message, heard: text })
  speak(outcome.message, 'success')
  since(`voice: key release -> ${outcome.message}`, releasedAt)
}

/** The recording, or null if it never arrived. */
function audioFromRenderer(timeoutMs = AUDIO_TIMEOUT_MS): Promise<Recording | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAudio = null
      console.error('[ezzy] the recorder never sent any audio')
      resolve(null)
    }, timeoutMs)
    pendingAudio = (recording) => {
      clearTimeout(timer)
      pendingAudio = null
      resolve(recording)
    }
  })
}

/** The dot's renderer captured its first block — the only real signal the mic is delivering
 *  audio (a resolved `getUserMedia` promise is not, since the graph still has to be pulled). */
export function reportMicLive(): void {
  micLive = true
  since('voice: microphone live', armedAt)
  if (capturing && state.kind === 'arming') setState({ kind: 'listening' })
}

/** The dot's renderer has finished recording. */
export function receiveAudio(wav: Buffer, spoke: boolean): void {
  log(`voice: ${(wav.length / 1024).toFixed(0)}KB of audio${spoke ? '' : ', no speech in it'}`)
  // The device answered, so whatever went wrong last time is over.
  armFailure = null
  pendingAudio?.({ wav, spoke })
}

/** The dot's renderer could not record at all. A blocked mic needs somewhere to lead,
 *  paired with a button in the search bar. */
export function reportCaptureFailure(kind: VoiceFailure): void {
  const wasListening = capturing
  armed = false
  capturing = false
  armFailure = kind
  pendingAudio?.(null)
  // Not worth interrupting a tap over — the user was opening the panel, not asking to speak.
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
    // A later state must not be overwritten by a progress event already in flight.
    if (state.kind === 'downloading') setState({ kind: 'downloading', percent })
  })
  if (!ok) {
    const hotkey = activeHotkey()
    fail(`Speech model download failed${hotkey ? ` — hold ${hotkey} to retry` : ''}`)
    return
  }
  setState({ kind: 'idle' })
  // Loaded now rather than making the next hold wait for both.
  startWhisperServer()
}

/** The highest-leverage fix for "whisper has never heard of this app" — open windows first
 *  (most switches are to something already running), then the index in prompt order. */
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
  // Shortest first — not a tie-break, the whole rule. Alphabetical order ran out of budget
  // at D and never reached Spotify, Skool or YouTube; short names are what people say aloud.
  const byLength = [...indexedApps()].sort(
    (one, two) => one.name.length - two.name.length || one.name.localeCompare(two.name)
  )
  for (const entry of byLength) add(entry.name)

  let list = names.join(', ')
  if (list.length > PROMPT_MAX_CHARS) list = list.slice(0, list.lastIndexOf(', ', PROMPT_MAX_CHARS))

  // Whole sentences, not a bare word list — the prompt conditions whisper as language, so
  // the verb gets biased too. The media lines exist because of a measured failure: "next
  // track on Spotify" came back as three different wrong sentences on three attempts.
  const examples = [
    `Switch to ${names[0] ?? 'Chrome'}.`,
    `Open ${names[1] ?? 'Notepad'}.`,
    'Close this window.',
    // "pause" also comes back as "pose" (which the commands accept) — cheaper to bias the
    // right spelling than to keep collecting the wrong ones.
    'Pause the music.',
    'Play music.',
    'Next track on Spotify.',
    'Previous track on Spotify.',
    'Skip this song.',
    'Play YouTube.'
  ].join(' ')
  return `${examples} Apps: ${list}.`
}
