/** The microphone half of push-to-talk. Runs in the dot window, which draws none of it —
 *  `getUserMedia` has no main-process equivalent, and the dot is the only window always alive.
 *
 *  Captures raw PCM rather than using MediaRecorder, since whisper-server reads WAV and
 *  MediaRecorder produces WebM/Opus (decoding that would mean shipping ffmpeg).
 *
 *  The mic opens on key-down, not when the hold is recognised 350ms later — opening a
 *  device takes 300-960ms, and a tap is cancelled with the buffer dropped and nothing sent.
 *  Never held open between commands beyond KEEP_WARM_MS, since Windows' recording indicator
 *  is the user's only real guarantee about an app like this one. */

import { isSpeaking } from './speech'

/** What whisper wants: 16kHz mono. */
const SAMPLE_RATE = 16_000

/** ScriptProcessor's buffer, in frames — 64ms at 16kHz. The granularity of everything the
 *  recorder can lose: up to one block at each end of a recording, and a press shorter than
 *  one block records nothing (measured empty at 4096 frames on a cold device). */
const BUFFER_FRAMES = 1024

/** How long the device stays open after a command. Opening it costs 225-400ms even with
 *  echo cancellation off (measured: a 2000ms press captured only 1536ms without this), so a
 *  second command in a row should not pay it twice. 20s, not indefinitely, since Windows'
 *  mic indicator should go out shortly after Ezzy stops using it. */
const KEEP_WARM_MS = 20_000

/** How much audio from before the key went down is kept. 500ms, because even a warm graph
 *  loses the start of an utterance to the press crossing IPC (measured: 1792ms captured of
 *  a warm 2000ms press without this, 2560ms with it). Emptied while Ezzy is speaking, since
 *  that half second is exactly where its own confirmation would be. */
const PREROLL_MS = 500
const PREROLL_BLOCKS = Math.ceil((PREROLL_MS / 1000) * (SAMPLE_RATE / BUFFER_FRAMES))

/** Hands-free end-of-utterance detection for the mic button, from the signal already being
 *  copied block by block — no analyser node, no model. The threshold is measured per session
 *  rather than fixed, since "loud" depends on the room and the mic: the first few blocks are
 *  taken as the noise floor and speech has to clear a multiple of it. */
const FLOOR_BLOCKS = 5
const FLOOR_MULTIPLE = 3.5
/** Below this, nothing counts as speech however quiet the room is — see SILENCE in gainFor. */
const MIN_SPEECH_RMS = 0.012

/** The quietest a block can be and still be somebody talking, for the SEPARATE question of
 *  whether the recording should be answered at all (MIN_SPEECH_RMS decides when to stop
 *  recording). Set below it deliberately: a wrong yes costs one wasted transcription, a
 *  wrong no costs the user a command they actually gave. Measured twice — at 0.005 a real
 *  quiet "open Skool" cleared it in only 3 of 4 required blocks and was refused; this
 *  machine's room sits at 0.0008, so the relative test does the real work either way. */
const AUDIBLE_RMS = 0.003

/** How far above the room a block must be to be a voice. Same multiple as the hands-free
 *  floor, for the same reason. */
const SPEECH_OVER_ROOM = 3.5

/** Which slice of a recording is taken to be the room: the quiet fifth, not the average — a
 *  hold can be mostly speech, so the average would be the speaker's own voice and nothing
 *  could clear 3.5x above it. */
const ROOM_PERCENTILE = 0.2

/** Blocks that must clear the threshold before a recording counts as speech — four is
 *  ~256ms, longer than a click or a door, shorter than any spoken word. Not required to be
 *  consecutive: the question is "was there a voice at all", and erring toward yes costs one
 *  wasted transcription against a command given and ignored. */
const SPEECH_BLOCKS = 4

/** How much quiet ends a sentence — long enough to survive the pause before a name
 *  ("switch to … Antigravity"), short enough not to linger after the user has finished. */
const TRAILING_SILENCE_MS = 900

/** If nothing that sounds like speech ever arrives, give up rather than hold the mic. */
const NO_SPEECH_MS = 4_000

/** Nobody dictates a launcher command for this long. */
const MAX_UTTERANCE_MS = 15_000

const BLOCK_MS = (BUFFER_FRAMES / SAMPLE_RATE) * 1000

let context: AudioContext | null = null
let source: MediaStreamAudioSourceNode | null = null
let processor: ScriptProcessorNode | null = null
let stream: MediaStream | null = null
let chunks: Float32Array[] = []
/** The last few blocks through a warm-but-idle graph. See PREROLL_BLOCKS. */
let preroll: Float32Array[] = []
let idleTimer: ReturnType<typeof setTimeout> | null = null
/** Whether the key is still held. Distinct from the graph running: a release can land while
 *  `getUserMedia` is still being granted, and then nothing should start at all. */
let wanted = false
/** Set when the session was started by the mic button (no release, so the recorder ends it
 *  itself); null for a held hotkey, which ends when the key comes up. */
let autoStop: AutoStop | null = null
/** One "mic live" message per session, on the first block genuinely captured. */
let announced = false

interface AutoStop {
  startedAt: number
  /** RMS of the first FLOOR_BLOCKS blocks — the room with nobody talking. */
  floor: number[]
  /** What a block has to beat to count as speech, fixed once the floor is known. */
  threshold: number
  /** Whether anything has cleared it yet. Until it has, silence means "not started". */
  heard: boolean
  /** Consecutive quiet blocks since the last loud one. */
  quiet: number
}

export function listenForCapture(): void {
  window.ezzy.onVoiceCapture((capture) => {
    if (capture === 'arm') void start()
    else if (capture === 'listen') void start(true)
    else void stop(capture === 'stop')
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

  // Still warm from the last command — the graph never stopped, it was only being ignored.
  // The pre-roll it has been holding covers the moment between key-down and this running.
  if (context && processor && stream?.active) {
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
        // Echo cancellation stays off. Measured: it costs 720-870ms to open a device against
        // 225-400ms without, and it does not do its job anyway — with music playing and
        // nobody speaking, AEC-on still let 19/37 blocks read as speech ("Family Foundation
        // of China"), AEC-off let through 20/43 ("Copilot, the mic is..."). Structural:
        // Chromium cancels against audio IT renders, and Spotify is a different process.
        // Music is handled by pausing it instead — see duckForListening in playback.ts.
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

  // Released while the permission prompt or the device was still coming up.
  if (!wanted) {
    release()
    return
  }

  context = new AudioContext({ sampleRate: SAMPLE_RATE })
  // Chromium starts an AudioContext suspended until the page is interacted with, and none
  // of Ezzy's windows ever are — a suspended context runs no graph at all (measured: the
  // first recording came back as zero samples with no error).
  if (context.state === 'suspended') await context.resume()
  source = context.createMediaStreamSource(stream)
  // AudioWorklet needs its own module loaded from a URL, which under this window's CSP
  // means an extra build entry for twenty lines of copying floats.
  processor = context.createScriptProcessor(BUFFER_FRAMES, 1, 1)
  processor.onaudioprocess = (event) => {
    // Copied, not referenced — the event's buffer is reused for the next block.
    const block = new Float32Array(event.inputBuffer.getChannelData(0))
    if (wanted) {
      // Ezzy talking is dropped rather than recorded — with AEC off it re-enters through
      // the mic, and a recording opening with its own confirmation's tail gets transcribed
      // as part of the next sentence. No tail here: the press already cut it off.
      if (isSpeaking()) return
      announce()
      chunks.push(block)
      if (autoStop && endOfUtterance(block, autoStop)) void stop(true)
      return
    }
    // Between commands, kept only to cover the start of the next one, and only when the
    // room is the user's — everything held here predates any press, so being strict costs
    // nothing.
    if (isSpeaking(true)) {
      preroll = []
      return
    }
    preroll.push(block)
    if (preroll.length > PREROLL_BLOCKS) preroll.shift()
  }

  // A ScriptProcessorNode only runs while connected to the destination, so the graph must
  // reach the speakers through a silent gain rather than play the mic back into the room.
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
  // A tap — nothing recorded during it is looked at, encoded, or sent.
  if (!send) {
    release()
    return
  }

  // A graph that delivered nothing at all — seen once, on a cold device while another
  // process held the speakers (a ScriptProcessorNode is pulled by the output). Torn down
  // rather than kept warm, or it would swallow every command for the next 20s.
  if (recorded.length === 0) {
    console.error(`[ezzy] the audio graph delivered nothing (context ${context?.state})`)
    release()
  } else {
    keepWarm()
  }
  // Decided here, on the real levels — encodeWav scales a quiet recording up to fill the
  // range, after which a silent room and a spoken sentence are the same height.
  const spoke = hasSpeech(recorded)

  const wav = encodeWav(recorded, spoke)
  const ms = (((wav.byteLength - 44) / 2 / SAMPLE_RATE) * 1000).toFixed(0)
  console.log(`recorded ${ms}ms${spoke ? '' : ' (no speech in it)'}`)
  window.ezzy.sendVoiceAudio(wav, spoke)
}

/** Tells main the mic is live, once per session, on a captured block rather than when
 *  `getUserMedia` resolves — the promise is only half of it; a block in hand is the first
 *  moment "listening" is a true word. */
function announce(): void {
  if (announced) return
  announced = true
  window.ezzy.reportMicLive()
}

/** Leaves the device open for a moment in case another command follows. */
function keepWarm(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    release()
  }, KEEP_WARM_MS)
}

/** Tears the graph down and lets go of the device. */
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

/** Has the speaker finished? Called per 64ms block of a hands-free recording. Three ways to
 *  be done — a sentence that ended, one that never started, one that will not stop — so the
 *  microphone always closes on its own. */
function endOfUtterance(block: Float32Array, session: AutoStop): boolean {
  const elapsed = performance.now() - session.startedAt
  if (elapsed > MAX_UTTERANCE_MS) {
    console.log(`hands-free: ${MAX_UTTERANCE_MS}ms cap reached, sending`)
    return true
  }

  const level = rms(block)

  // The room, taken from this recording's own first blocks rather than remembered — a
  // stale noise floor is worse than none.
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
    // A different clock from the one below — waiting for someone to start is not the same
    // as deciding they have stopped.
    if (elapsed < NO_SPEECH_MS) return false
    console.log('hands-free: nothing was said, giving the microphone back')
    return true
  }
  if (quietMs < TRAILING_SILENCE_MS) return false
  console.log(`hands-free: ${quietMs.toFixed(0)}ms of quiet after speech, sending`)
  return true
}

/** Was anybody talking? Measured before encodeWav's gain, relative to the room rather than
 *  a fixed number — a fixed number is a rule about how loudly the user must speak, which is
 *  the exact complaint this exists to fix. Logged in full: the spread across blocks is what
 *  distinguishes a room from a murmur, not any single number. */
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

/** Scales a quiet recording up before it is written to 16-bit PCM — a voice peaking at
 *  0.015 only uses ~9 of the 16 available bits, and the rest is thrown away at encode time.
 *  Does not improve signal-to-noise (not a substitute for speaking up), but stops the
 *  encoder making things worse. SILENCE guards against amplifying a near-empty buffer into
 *  exactly what whisper invents sentences out of — it only applies when nothing was said; a
 *  recording the speech test has vouched for is amplified however quiet it is. */
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

/** 16-bit PCM, mono, in a canonical 44-byte WAV. */
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
  view.setUint32(16, 16, true) // PCM header length
  view.setUint16(20, 1, true) // PCM, uncompressed
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true) // bytes per second
  view.setUint16(32, 2, true) // bytes per frame
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, frames * 2, true)

  let offset = 44
  for (const block of blocks) {
    for (const sample of block) {
      // Clamped after the gain, before scaling: web audio's range is nominally -1..1 but a
      // loud room can overshoot it, and wrapping a sample round is an audible click.
      const clamped = Math.max(-1, Math.min(1, sample * gain))
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      offset += 2
    }
  }
  return buffer
}

/** The DOMException never crosses the bridge — only which of the three failures it was. */
function classify(error: unknown): 'denied' | 'no-device' | 'failed' {
  const name = error instanceof DOMException ? error.name : ''
  // A mic blocked in Windows Settings reports as an ordinary permission denial.
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device'
  console.error('[ezzy] could not open the microphone:', error)
  return 'failed'
}
