/** The microphone half of push-to-talk. Runs in the dot window — the only one always
 *  alive. Captures raw PCM rather than MediaRecorder, since whisper-server reads WAV. */

import { isSpeaking } from './speech'

const SAMPLE_RATE = 16_000
const BUFFER_FRAMES = 1024

/** Pre-roll kept from a warm graph, covering the gap between key-down and this running. */
const PREROLL_MS = 500
const PREROLL_BLOCKS = Math.ceil((PREROLL_MS / 1000) * (SAMPLE_RATE / BUFFER_FRAMES))

const FLOOR_BLOCKS = 5
const FLOOR_MULTIPLE = 3.5
const MIN_SPEECH_RMS = 0.012

/** Threshold for "was anything said at all" — deliberately below MIN_SPEECH_RMS, since a
 *  false yes costs one wasted transcription and a false no costs a command outright. */
const AUDIBLE_RMS = 0.003

const SPEECH_OVER_ROOM = 3.5
/** The room is measured from the quiet 20th percentile, not the average — a hold can be
 *  mostly speech, which would make the average the voice itself. */
const ROOM_PERCENTILE = 0.2
const SPEECH_BLOCKS = 4
const TRAILING_SILENCE_MS = 900
const NO_SPEECH_MS = 4_000
const MAX_UTTERANCE_MS = 15_000

const BLOCK_MS = (BUFFER_FRAMES / SAMPLE_RATE) * 1000

let context: AudioContext | null = null
let source: MediaStreamAudioSourceNode | null = null
let processor: ScriptProcessorNode | null = null
let stream: MediaStream | null = null
let chunks: Float32Array[] = []
let preroll: Float32Array[] = []
let idleTimer: ReturnType<typeof setTimeout> | null = null
let wanted = false
let autoStop: AutoStop | null = null
let announced = false
// How long the device stays open after a command (a setting), so the next one skips the
// 0.5-1.6s it takes to open. Arrives with every capture message.
let readyMs = 0
let reusedWarm = false

interface AutoStop {
  startedAt: number
  floor: number[]
  threshold: number
  heard: boolean
  quiet: number
}

export function listenForCapture(): void {
  window.ezzy.onVoiceCapture((capture, keepReadyMs) => {
    readyMs = keepReadyMs
    if (capture === 'arm') void start()
    else if (capture === 'listen') void start(true)
    else if (capture === 'release') {
      if (!wanted) release()
    } else void stop(capture === 'stop')
  })
}

async function start(handsFree = false): Promise<void> {
  if (wanted) return
  wanted = true
  autoStop = handsFree
    ? { startedAt: performance.now(), floor: [], threshold: MIN_SPEECH_RMS, heard: false, quiet: 0 }
    : null
  chunks = []
  announced = false
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null

  reusedWarm = context !== null && processor !== null && stream?.active === true
  if (reusedWarm) {
    chunks = preroll
    preroll = []
    announce()
    return
  }

  const startedAt = performance.now()

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Off: costs 720-870ms to open with it on, and it cancels against audio Chromium
        // itself renders — Spotify is a different process, so it caught the music anyway.
        // Music is paused instead; see duckForListening in playback.ts.
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  } catch (error) {
    wanted = false
    window.ezzy.reportVoiceFailure(classify(error))
    return
  }

  if (!wanted) {
    release()
    return
  }

  context = new AudioContext({ sampleRate: SAMPLE_RATE })
  if (context.state === 'suspended') await context.resume()
  source = context.createMediaStreamSource(stream)
  processor = context.createScriptProcessor(BUFFER_FRAMES, 1, 1)
  processor.onaudioprocess = (event) => {
    const block = new Float32Array(event.inputBuffer.getChannelData(0))
    if (wanted) {
      // Ezzy's own voice, dropped rather than recorded — echo cancellation is off, so it
      // would otherwise glue the tail of a confirmation to the front of the next command.
      if (isSpeaking()) return
      announce()
      chunks.push(block)
      if (autoStop && endOfUtterance(block, autoStop)) void stop(true)
      return
    }
    if (isSpeaking(true)) {
      preroll = []
      return
    }
    preroll.push(block)
    if (preroll.length > PREROLL_BLOCKS) preroll.shift()
  }

  const silence = context.createGain()
  silence.gain.value = 0
  source.connect(processor)
  processor.connect(silence)
  silence.connect(context.destination)
  console.log(`microphone open in ${(performance.now() - startedAt).toFixed(0)}ms`)
}

async function stop(send: boolean): Promise<void> {
  if (!wanted) return
  wanted = false
  autoStop = null
  const recorded = chunks
  chunks = []
  if (!send) {
    // A tap opened the mic only to close it — but if it was already warm from a command, a
    // tap is no reason to throw that away.
    if (reusedWarm) keepWarm()
    else release()
    return
  }

  if (recorded.length === 0) {
    console.error(`[ezzy] the audio graph delivered nothing (context ${context?.state})`)
    release()
  } else {
    keepWarm()
  }
  const spoke = hasSpeech(recorded)

  const wav = encodeWav(recorded, spoke)
  const ms = (((wav.byteLength - 44) / 2 / SAMPLE_RATE) * 1000).toFixed(0)
  console.log(`recorded ${ms}ms${spoke ? '' : ' (no speech in it)'}`)
  window.ezzy.sendVoiceAudio(wav, spoke)
}

function announce(): void {
  if (announced) return
  announced = true
  window.ezzy.reportMicLive()
}

function keepWarm(): void {
  if (readyMs <= 0) {
    release()
    return
  }
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    release()
  }, readyMs)
}

function release(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  preroll = []
  if (processor) {
    processor.onaudioprocess = null
    processor.disconnect()
  }
  source?.disconnect()
  processor = null
  source = null
  void context?.close()
  context = null
  for (const track of stream?.getTracks() ?? []) track.stop()
  stream = null
}

function endOfUtterance(block: Float32Array, session: AutoStop): boolean {
  const elapsed = performance.now() - session.startedAt
  if (elapsed > MAX_UTTERANCE_MS) {
    console.log(`hands-free: ${MAX_UTTERANCE_MS}ms cap reached, sending`)
    return true
  }

  const level = rms(block)

  if (session.floor.length < FLOOR_BLOCKS) {
    session.floor.push(level)
    if (session.floor.length === FLOOR_BLOCKS) {
      const mean = session.floor.reduce((sum, value) => sum + value, 0) / session.floor.length
      session.threshold = Math.max(mean * FLOOR_MULTIPLE, MIN_SPEECH_RMS)
      console.log(
        `hands-free: noise floor ${mean.toFixed(4)}, speech above ${session.threshold.toFixed(4)}`
      )
    }
    return false
  }

  if (level >= session.threshold) {
    session.heard = true
    session.quiet = 0
    return false
  }

  session.quiet++
  const quietMs = session.quiet * BLOCK_MS
  if (!session.heard) {
    if (elapsed < NO_SPEECH_MS) return false
    console.log('hands-free: nothing was said, giving the microphone back')
    return true
  }
  if (quietMs < TRAILING_SILENCE_MS) return false
  console.log(`hands-free: ${quietMs.toFixed(0)}ms of quiet after speech, sending`)
  return true
}

/** Logged in full — the spread across blocks is what a quiet voice is told apart from a
 *  silent room by, not any single number. */
function hasSpeech(blocks: Float32Array[]): boolean {
  if (blocks.length === 0) return false
  const levels = blocks.map(rms)
  const sorted = [...levels].sort((a, b) => a - b)
  const room = sorted[Math.floor(sorted.length * ROOM_PERCENTILE)] ?? 0
  const threshold = Math.max(room * SPEECH_OVER_ROOM, AUDIBLE_RMS)
  let loud = 0
  for (const level of levels) if (level >= threshold) loud++
  const over = (at: number): number => levels.filter((level) => level >= at).length
  console.log(
    `speech test: room ${room.toFixed(4)}, loudest ${sorted[sorted.length - 1].toFixed(4)}, ` +
      `needs ${threshold.toFixed(4)}, ${loud}/${levels.length} over it ` +
      `[>.002 ${over(0.002)}, >.005 ${over(0.005)}, >.01 ${over(0.01)}, >.02 ${over(0.02)}]`
  )
  return loud >= SPEECH_BLOCKS
}

function rms(block: Float32Array): number {
  let sum = 0
  for (const sample of block) sum += sample * sample
  return Math.sqrt(sum / block.length)
}

/** Scales a quiet recording up before encoding to 16-bit PCM — otherwise a voice peaking
 *  at 0.015 only uses ~9 of 16 bits. SILENCE stops that from amplifying an empty room into
 *  something whisper mistakes for speech; it only applies when nothing was said. */
const HEADROOM = 0.9
const SILENCE = 0.02
const MAX_GAIN = 20

function gainFor(blocks: Float32Array[], spoke: boolean): number {
  let peak = 0
  for (const block of blocks) {
    for (const sample of block) {
      const level = Math.abs(sample)
      if (level > peak) peak = level
    }
  }
  if (peak >= HEADROOM) return 1
  if (!spoke && peak <= SILENCE) return 1
  return Math.min(HEADROOM / peak, MAX_GAIN)
}

function encodeWav(blocks: Float32Array[], spoke: boolean): ArrayBuffer {
  let frames = 0
  for (const block of blocks) frames += block.length
  const gain = gainFor(blocks, spoke)

  const buffer = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + frames * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, frames * 2, true)

  let offset = 44
  for (const block of blocks) {
    for (const sample of block) {
      const clamped = Math.max(-1, Math.min(1, sample * gain))
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      offset += 2
    }
  }
  return buffer
}

function classify(error: unknown): 'denied' | 'no-device' | 'failed' {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device'
  console.error('[ezzy] could not open the microphone:', error)
  return 'failed'
}
