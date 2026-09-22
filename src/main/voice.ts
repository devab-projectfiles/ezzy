/** Push-to-talk. Hold the hotkey, speak, let go — release sends the audio to
 *  whisper-server. A tap never touches this file or loads a model. Recording happens in
 *  the dot's renderer (`getUserMedia` is a web API); see recorder.ts. */

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
let armed = false
let capturing = false
let micLive = false
let armedAt = 0
let fromButton = false

interface Recording {
  wav: Buffer
  spoke: boolean
}

let pendingAudio: ((recording: Recording | null) => void) | null = null
let armFailure: VoiceFailure | null = null
let clearStateTimer: ReturnType<typeof setTimeout> | null = null
let heard: string | null = null

const AUDIO_TIMEOUT_MS = 4_000
const HANDS_FREE_TIMEOUT_MS = 20_000
const ERROR_MS = 4_000
const DONE_MS = 2_600
const MIN_AUDIO_BYTES = 44 + 8_000

const NOTHING_HEARD = 'I didn’t hear anything — say a command'

/** Whisper's prompt is capped by the model's own context, not by us — this is "which
 *  forty names are worth a token", not "fit them all". */
const PROMPT_NAMES = 40
const PROMPT_MAX_CHARS = 320

export function initVoice(): void {
  registerBuiltinCommands()
  verifyExamples()
  setCustomPhrases(getConfig().phrases)
  watchHold({
    onPress: () => armCapture(),
    onHold: () => void beginListening(),
    onRelease: (held) => void (held ? finishListening() : cancelCapture())
  })
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

export function toggleListening(): void {
  if (!getConfig().voice) {
    fail('Voice is off — turn it on in Settings')
    return
  }
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
  const linger = next.kind === 'error' ? ERROR_MS : next.kind === 'done' ? DONE_MS : 0
  if (linger === 0) return
  clearStateTimer = setTimeout(() => setState({ kind: 'idle' }), linger)
}

function fail(message: string, micBlocked = false): void {
  log(`voice: ${message}`)
  setState({ kind: 'error', message, micBlocked, heard: heard ?? undefined })
  if (micBlocked) {
    showPanelForVoice()
    sendVoiceState(state)
  }
  speak(message, 'failure')
}

// ------------------------------------------------------------------ listening

/** The mic opens on key-down, not at the hold threshold — measured 300-960ms to open,
 *  and starting later clipped the first word. Nothing from a tap is ever sent. */
function armCapture(): void {
  if (armed || !getConfig().voice || !isVoiceInstalled() || !hasModel()) return
  armed = true
  micLive = false
  armedAt = performance.now()
  hush()
  sendCapture('arm')
  startWhisperServer()
}

function cancelCapture(): void {
  if (!armed) return
  armed = false
  capturing = false
  restoreAfterListening()
  sendCapture('cancel')
}

function quieten(): void {
  if (getConfig().duckMusic) duckForListening()
}

async function beginListening(source: 'hotkey' | 'mic-button' = 'hotkey'): Promise<void> {
  if (capturing) return
  if (!getConfig().voice) return
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

  if (source === 'hotkey') {
    if (getConfig().voicePanel) showPanelForVoice()
    else hidePanel()
  }

  if (!hasModel()) {
    void fetchModel()
    return
  }

  if (!armed) armCapture()
  if (!armed && armFailure !== null) {
    reportFailure(armFailure)
    return
  }
  capturing = true
  quieten()
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
  const finishedAt = performance.now()
  capturing = false
  armed = false
  endButtonSession()
  if (state.kind === 'listening' || state.kind === 'arming') setState({ kind: 'thinking' })
  await transcribeAndRun(recording, finishedAt)
}

async function transcribeAndRun(recording: Recording | null, releasedAt: number): Promise<void> {
  if (!recording || recording.wav.length < MIN_AUDIO_BYTES) {
    if (state.kind === 'thinking') fail('I didn’t catch that')
    return
  }

  if (!recording.spoke) {
    log('voice: the recording holds no speech')
    fail(NOTHING_HEARD)
    return
  }
  const wav = recording.wav

  if (!(await whenReady())) {
    fail('The speech engine didn’t start')
    return
  }

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
  if (isSilenceArtefact(text)) {
    log(`voice: "${text}" is what whisper writes over a room, not a command`)
    fail(NOTHING_HEARD)
    return
  }
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
  setState({ kind: 'done', message: outcome.message, heard: text })
  speak(outcome.message, 'success')
  since(`voice: key release -> ${outcome.message}`, releasedAt)
}

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

export function reportMicLive(): void {
  micLive = true
  since('voice: microphone live', armedAt)
  if (capturing && state.kind === 'arming') setState({ kind: 'listening' })
}

export function receiveAudio(wav: Buffer, spoke: boolean): void {
  log(`voice: ${(wav.length / 1024).toFixed(0)}KB of audio${spoke ? '' : ', no speech in it'}`)
  armFailure = null
  pendingAudio?.({ wav, spoke })
}

export function reportCaptureFailure(kind: VoiceFailure): void {
  const wasListening = capturing
  armed = false
  capturing = false
  armFailure = kind
  pendingAudio?.(null)
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
    if (state.kind === 'downloading') setState({ kind: 'downloading', percent })
  })
  if (!ok) {
    const hotkey = activeHotkey()
    fail(`Speech model download failed${hotkey ? ` — hold ${hotkey} to retry` : ''}`)
    return
  }
  setState({ kind: 'idle' })
  startWhisperServer()
}

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
  // Shortest first, not a tie-break — alphabetical order ran out of budget at D and never
  // reached Spotify, Skool or YouTube.
  const byLength = [...indexedApps()].sort(
    (one, two) => one.name.length - two.name.length || one.name.localeCompare(two.name)
  )
  for (const entry of byLength) add(entry.name)

  let list = names.join(', ')
  if (list.length > PROMPT_MAX_CHARS) list = list.slice(0, list.lastIndexOf(', ', PROMPT_MAX_CHARS))

  const examples = [
    `Switch to ${names[0] ?? 'Chrome'}.`,
    `Open ${names[1] ?? 'Notepad'}.`,
    'Close this window.',
    'Pause the music.',
    'Play music.',
    'Next track on Spotify.',
    'Previous track on Spotify.',
    'Skip this song.',
    'Play YouTube.'
  ].join(' ')
  return `${examples} Apps: ${list}.`
}
