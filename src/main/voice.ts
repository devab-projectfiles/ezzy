/** Push-to-talk, end to end.
 *
 *  Hold the hotkey, speak, let go: the panel is already open from the press, the microphone
 *  opens 350ms into the hold, and the release is what sends the audio to whisper-server and
 *  runs whatever came back.
 *
 *  Holding the *same* key that opens the panel is what makes this one gesture rather than two
 *  features. A tap opens the panel and never touches this file — the plan is explicit that the
 *  keyboard path must never touch whisper, and it does not: nothing here runs, and no model is
 *  even loaded, until the first time someone holds the key.
 *
 *  The recording itself happens in the dot's renderer, because `getUserMedia` is a web API and
 *  the main process does not have one. See `renderer/src/recorder.ts`. */

import { app } from 'electron'
import { VoiceFailure, VoiceState } from '../shared/types'
import { indexedApps } from './app-index'
import { registerBuiltinCommands } from './commands/builtin'
import { isSilenceArtefact, normaliseTranscript, runCommand } from './commands/registry'
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
/** The microphone is open and buffering. Set on the press, before it is known whether this
 *  will be a hold — see `armCapture`. */
let armed = false
/** The press became a hold, so what is being buffered is a command. */
let capturing = false
/** Whether the recorder has reported that the microphone is actually delivering audio.
 *
 *  Reset at the start of every session and set by `reportMicLive`. A warm graph answers within
 *  one 64ms block; a cold one takes 225-960ms to open the device, and none of that time
 *  records anything. Which of the two happened is the difference between "Listening..." and
 *  "Getting ready...", and the user starts talking on the strength of that word. */
let micLive = false
/** When the microphone was asked for, so the wait for it can be measured rather than guessed
 *  at. This is the number the whole `arming` state exists because of. */
let armedAt = 0
/** This session was started by the search bar's mic button rather than by holding the hotkey.
 *  A held key ends itself when it comes up; a click has to be ended by something, and the two
 *  things that can end it — a timeout and the panel closing — only apply to this case. */
let fromButton = false
/** The ceiling on a hands-free recording lives in the recorder now (MAX_UTTERANCE_MS): it is
 *  the half that can see the microphone, so it is the half that can tell a long sentence from
 *  a forgotten one. */
/** What the renderer hands back for one hold: the audio, and whether anybody was talking
 *  during it. The second half is measured from the signal — see `hasSpeech` in the recorder —
 *  because the transcript cannot answer it. Whisper never returns nothing; handed an empty
 *  room it invents a confident sentence out of the room tone, and "Subs by
 *  www.zeoranger.co.uk" then goes through the commands as if it had been said. */
interface Recording {
  wav: Buffer
  spoke: boolean
}

/** Resolves when the renderer hands the recording over, or when it says it cannot. */
let pendingAudio: ((recording: Recording | null) => void) | null = null
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

/** Hands-free, the same wait covers the user thinking, speaking, and the recorder deciding
 *  they have finished — so it has to outlast the recorder's own ceilings rather than the few
 *  seconds an already-finished recording needs to arrive. */
const HANDS_FREE_TIMEOUT_MS = 20_000

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

/** What is said when the microphone was open and nothing was said into it.
 *
 *  Deliberately not "I didn't catch that", which means "you spoke and I failed you" and
 *  invites the user to repeat themselves louder. Nothing was spoken, so the answer says so and
 *  says what to do instead. Kept inside the width the pill can draw — it clips rather than
 *  wraps, and the longest sentence it has ever had to hold is 37 characters. */
const NOTHING_HEARD = 'I didn’t hear anything — say a command'

/** Whisper's prompt is capped at a couple of hundred tokens, and it has to leave room for the
 *  command phrasings that go in front of the names — those are what bias it towards hearing a
 *  command at all. Forty names covers everything anyone switches to by voice. */
const PROMPT_NAMES = 40
/** Trimmed from 400 to make room for the command sentences below.
 *
 *  The trade is deliberate and evidence-led: on the failures that prompted this, the app names
 *  were already coming through — "Spotify" was transcribed correctly every time — and the
 *  COMMAND around them was not. Eighty characters of extra app names were buying nothing next
 *  to four sentences that name the thing actually being got wrong. */
const PROMPT_MAX_CHARS = 320

export function initVoice(): void {
  registerBuiltinCommands()
  watchHold({
    onPress: () => armCapture(),
    onHold: () => void beginListening(),
    onRelease: (held) => void (held ? finishListening() : cancelCapture())
  })
  // The panel going away takes the mic button with it, so a session it started has to end
  // here. Dismissing the panel is not "send it" — the user closed the thing they were talking
  // to — so the recording is thrown away rather than transcribed.
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

/** The search bar's mic button, which is a click rather than a hold.
 *
 *  Push-to-talk has a natural end — you let go. A click does not, so the same button ends the
 *  utterance: first click opens the microphone, second sends what it heard. Everything after
 *  that is the hotkey's own path, unchanged; this only replaces the gesture.
 *
 *  The microphone is opened here rather than pre-armed, so unlike the hotkey there is no head
 *  start on `getUserMedia` — speak a beat after clicking, the way the button's own listening
 *  state tells you to. */
export function toggleListening(): void {
  if (!getConfig().voice) {
    // Silence is right for a hotkey hold, which the user may not have meant as one. A click on
    // a microphone is unambiguous, so it gets an answer.
    fail('Voice is off — turn it on in Settings')
    return
  }
  // Clicked again during a session — only reachable by reopening the panel, since the click
  // closes it. Treated as "I have finished", the same as letting go of the hotkey.
  if (capturing) {
    void finishListening()
    return
  }
  fromButton = true
  void listenHandsFree()
}

/** The session is over, however it ended. */
function endButtonSession(): void {
  fromButton = false
}

/** Voice has just been switched off in settings.
 *
 *  Turning it off has to give the memory back, or the switch is only a promise about future
 *  holds: whisper-server is ~300MB resident and nothing else ever stops it before quit. Any
 *  press in flight is cancelled too, so the microphone is not left open by a hold that was
 *  armed a moment before the switch was flipped. */
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

/** A command that could not be carried out. Chunk E: "a failed command is as clear as a
 *  successful one" — which is why this both draws it and says it out loud. Spoken matters more
 *  here than for a success: the user is looking at the app they expected to be switched away
 *  from, not at the dot. */
function fail(message: string, micBlocked = false): void {
  log(`voice: ${message}`)
  setState({ kind: 'error', message, micBlocked, heard: heard ?? undefined })
  // A blocked microphone has to lead somewhere rather than to a dead button, and the
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
  if (armed || !getConfig().voice || !isVoiceInstalled() || !hasModel()) return
  armed = true
  micLive = false
  armedAt = performance.now()
  // Silence the last confirmation HERE, on the press, rather than at the hold 350ms later.
  //
  // Echo cancellation is off — it tripled the time the device takes to open — so the
  // microphone hears Ezzy's own voice out of the speakers, and the graph is still warm from
  // the command that produced it. Hushing at the hold left those 350ms of Ezzy talking at the
  // front of the recording, and whisper transcribed them faithfully: the end of its own last
  // sentence, glued to the start of the user's new one, matched against as one command.
  hush()
  // Before the whisper server, because this is the message that opens the device and every
  // millisecond in front of it comes out of the user's first word.
  sendCapture('arm')
  // Started here rather than at launch and left running afterwards — the "model load is the
  // real latency". The first command of a session waits for it; the rest do not.
  startWhisperServer()
}

function cancelCapture(): void {
  if (!armed) return
  armed = false
  capturing = false
  sendCapture('cancel')
}

async function beginListening(source: 'hotkey' | 'mic-button' = 'hotkey'): Promise<void> {
  if (capturing) return
  // Chunk F's voice switch. Off, a hold is just a long tap — no microphone, no download, no
  // message. Saying "voice is off" here would be worse than silence: the user turned it off,
  // and the panel the press already opened is exactly where they can type instead.
  if (!getConfig().voice) return
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

  // None of this applies when the mic BUTTON started it: the panel is already open, the user
  // is looking at it, and they clicked something inside it. Closing it under them — which is
  // what quiet mode does to a hotkey hold — would take away the thing they just used.
  if (source === 'hotkey') {
    // Whether the panel comes up for this is the user's call (`voicePanel`). Off — the default
    // — the dot's pill carries the whole exchange and nothing covers what you were reading. On,
    // it is chunk D's behaviour: the hold may have arrived on a closed panel, or on one the
    // press just closed, so it has to be brought back up for the search bar to report on.
    if (getConfig().voicePanel) showPanelForVoice()
    // Quiet mode has to CLOSE a panel rather than not open one: the press toggles it before
    // anyone knows this is a hold, and that is deliberate — the plan gives the tap a 50ms budget from
    // the press, so the panel cannot wait 350ms to find out what kind of press it was.
    else hidePanel()
  }

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
  // "Listening" only if the device has already answered. Otherwise the surface says it is
  // getting ready, and `reportMicLive` promotes it the moment audio starts arriving.
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
  setState({ kind: 'thinking' })
  await transcribeAndRun(await audioFromRenderer(), releasedAt)
}

/** Hands-free: the mic button's session, ended by the recorder rather than by a key coming up.
 *
 *  The panel is closed on the way in, which is what was asked for and is also what the hotkey
 *  does in its default quiet mode — the dot's pill carries listening, thinking and the answer,
 *  so nothing has to stay on screen for the user to talk to. Nothing is clicked to finish: the
 *  recorder listens for the end of the sentence and sends, and the command runs from that. */
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
  // Out of the way first, so the user is talking to the dot rather than to a window sitting
  // over what they were reading.
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

  const recording = await audioFromRenderer(HANDS_FREE_TIMEOUT_MS)
  // The recorder decides when the sentence ended, so this is the first moment the main process
  // knows it has — which is exactly when "listening" becomes "thinking".
  const finishedAt = performance.now()
  capturing = false
  armed = false
  endButtonSession()
  if (state.kind === 'listening' || state.kind === 'arming') setState({ kind: 'thinking' })
  await transcribeAndRun(recording, finishedAt)
}

/** Everything both gestures do once there is a recording: transcribe it and run what it says. */
async function transcribeAndRun(recording: Recording | null, releasedAt: number): Promise<void> {
  // A capture failure reports itself through `reportCaptureFailure`, which has already put a
  // more specific message on screen than anything that could be said here.
  if (!recording || recording.wav.length < MIN_AUDIO_BYTES) {
    if (state.kind === 'thinking') fail('I didn’t catch that')
    return
  }

  // Nobody spoke. Answered here rather than after transcribing, because transcribing silence
  // does not produce silence — it produces a sentence, and a sentence gets acted on. This is
  // also the cheapest possible answer: the recording is never sent anywhere.
  if (!recording.spoke) {
    log('voice: the recording holds no speech')
    fail(NOTHING_HEARD)
    return
  }
  const wav = recording.wav

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
  // The signal test above catches most of it. This catches the rest: a cough, a chair or a
  // door is enough audio to look like speech, and what whisper writes over it is one of a
  // small set of sentences from the subtitle tracks it was trained on. `heard` is left unset
  // for these on purpose — quoting the invention back would present it as something the user
  // might have said.
  if (isSilenceArtefact(text)) {
    log(`voice: "${text}" is what whisper writes over a room, not a command`)
    fail(NOTHING_HEARD)
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
  // Act before you speak. The command has already put the window in front by the time
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

/** The dot's renderer has captured its first block: the device is open and audio is real.
 *
 *  This is the only signal either process has for that. `getUserMedia` resolving is not it —
 *  the graph still has to be built and pulled — so the recorder waits for a block rather than
 *  for a promise. */
export function reportMicLive(): void {
  micLive = true
  // The one measurement this whole state exists for: everything before it is a word the user
  // said into a device that was not there yet.
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

/** The dot's renderer could not record at all. A blocked microphone has to lead somewhere,
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

/** the highest-leverage mitigation, and the reason "open n8n" has any chance at all: whisper
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
  // Whole sentences in the shapes the commands are written in — see below. The media ones are
  // here because of a measured failure and they are the most valuable lines in the list: asked
  // quietly for "next track on Spotify", whisper returned "Make a scene on Spotify", "Make a
  // sound in this Spotify" and "Low Bangs, Spotify" on three consecutive attempts. Every one
  // of those is fluent English, which is what a model does when it cannot hear well enough and
  // falls back on guessing what a sentence probably was. The prompt is where that guess is
  // biased, so a failure of this exact shape is the one thing a prompt can genuinely fix.
  const examples = [
    `Switch to ${names[0] ?? 'Chrome'}.`,
    `Open ${names[1] ?? 'Notepad'}.`,
    'Close this window.',
    // "pause" also comes back as "pose", which the commands accept — but it is cheaper to have
    // whisper write the word than to keep collecting the spellings it writes instead.
    'Pause the music.',
    'Play music.',
    'Next track on Spotify.',
    'Previous track on Spotify.',
    'Skip this song.',
    'Play YouTube.'
  ].join(' ')
  return `${examples} Apps: ${list}.`
}
