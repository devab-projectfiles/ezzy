/** The microphone half of push-to-talk.
 *
 *  This runs in the **dot** window, which draws none of it. `getUserMedia` is a web API with no
 *  main-process equivalent, so recording has to happen in a renderer, and the dot is the only
 *  one that is always alive — the search bar exists only while the panel is open, which is not
 *  a lifetime you can hold a microphone across.
 *
 *  It captures raw PCM rather than using MediaRecorder, because whisper-server reads WAV and
 *  MediaRecorder produces WebM/Opus. Decoding that would mean shipping ffmpeg (the server's
 *  `--convert` flag needs it); writing a 44-byte WAV header instead costs nothing.
 *
 *  The microphone opens when the hotkey goes *down*, not when the hold is recognised 350ms
 *  later: opening a device takes 300-960ms here, and a user who starts talking as they press
 *  loses their first word to it. A press that turns out to be a tap is cancelled — the buffer
 *  is dropped and the device closed without anything being sent anywhere.
 *
 *  It is never held open between commands. The Windows recording indicator should be on
 *  exactly while Ezzy has the microphone, because that indicator is the user's only real
 *  guarantee about an app like this one. */

import { isSpeaking } from './speech'

/** What whisper wants: 16kHz mono. The AudioContext resamples the device's own rate for us. */
const SAMPLE_RATE = 16_000

/** ScriptProcessor's buffer, in frames — 64ms at 16kHz.
 *
 *  This is the granularity of everything the recorder can lose. A block is only handed over
 *  once it is full, so up to one block goes missing at each end of a recording, and a press
 *  shorter than one block records nothing at all — measured, at 4096 frames (256ms) a brief
 *  press on a cold device came back empty. Copying 1024 floats fifteen times a second is not
 *  a cost worth weighing against that. */
const BUFFER_FRAMES = 1024

/** How long the device stays open after a command.
 *
 *  Opening it costs 225-400ms even with echo cancellation off, and that time comes out of the
 *  start of the recording — measured, a 2000ms press captured 1536ms of audio. Someone giving
 *  two commands in a row should not pay it twice, so the graph is left running for a while and
 *  the second command captures every syllable.
 *
 *  Twenty seconds, not indefinitely: Windows shows a microphone indicator for as long as the
 *  device is open, and it should go out shortly after Ezzy stops using it. A press that turns
 *  out to be a tap closes it immediately rather than starting this timer at all. */
const KEEP_WARM_MS = 20_000

/** How much of the audio from *before* the key went down is kept.
 *
 *  Half a second. It exists because even a warm graph loses the start of an utterance: the
 *  press has to cross IPC and it lands somewhere inside a block that has already begun.
 *  Measured, a warm 2000ms press captured 1792ms of itself without this and 2560ms with it.
 *
 *  Only ever filled while the device is already open for a command that just ran, and thrown
 *  away with everything else when it closes — and emptied outright while Ezzy is speaking,
 *  since the half second before a press is exactly where its own confirmation would be. */
const PREROLL_MS = 500
const PREROLL_BLOCKS = Math.ceil((PREROLL_MS / 1000) * (SAMPLE_RATE / BUFFER_FRAMES))

/** Hands-free capture, for the mic button. Voice was given a key to hold; a click has
 *  no equivalent. The recorder decides when the sentence ended, from the signal it is already
 *  copying block by block — no analyser node, no library, no model.
 *
 *  The threshold is measured rather than assumed, because "loud" depends on the room, the
 *  microphone and Chromium's own gain control. The first few blocks are taken as the noise
 *  floor and speech has to clear a multiple of it — a fixed number would either miss a quiet
 *  voice on a laptop mic or hear a fan as talking. */
const FLOOR_BLOCKS = 5
const FLOOR_MULTIPLE = 3.5
/** Below this, nothing counts as speech however quiet the room is. A near-silent buffer scaled
 *  up is exactly what whisper invents sentences out of — see `SILENCE` in `gainFor`. */
const MIN_SPEECH_RMS = 0.012

/** How many blocks have to clear MIN_SPEECH_RMS before a recording counts as somebody
 *  talking. Four of them is ~256ms of sound — longer than a click, a chair or a door, shorter
 *  than any word anyone says.
 *
 *  They do not have to be consecutive, deliberately: a command is louder in some places than
 *  others, and the question being asked is "was there a voice in here at all", not "was there
 *  a continuous one". Erring towards yes is right — the cost of a wrong yes is one wasted
 *  transcription, and the cost of a wrong no is a command that was given and ignored. */
const SPEECH_BLOCKS = 4

/** How much quiet ends a sentence. Long enough to survive the pause between words and before
 *  a name — "switch to … Antigravity" — and short enough that the command does not sit there
 *  after the user has plainly finished. */
const TRAILING_SILENCE_MS = 900

/** If nothing that sounds like speech ever arrives, give up rather than hold the microphone.
 *  The main process reports the empty recording as "I didn't catch that". */
const NO_SPEECH_MS = 4_000

/** Nobody dictates a launcher command for this long, and a recording that never ends is a
 *  microphone that never closes. */
const MAX_UTTERANCE_MS = 15_000

const BLOCK_MS = (BUFFER_FRAMES / SAMPLE_RATE) * 1000

let context: AudioContext | null = null
let source: MediaStreamAudioSourceNode | null = null
let processor: ScriptProcessorNode | null = null
let stream: MediaStream | null = null
let chunks: Float32Array[] = []
/** The last few blocks to come through a warm-but-idle graph. See PREROLL_BLOCKS. */
let preroll: Float32Array[] = []
let idleTimer: ReturnType<typeof setTimeout> | null = null
/** Whether the key is still held. Distinct from whether the graph is running: the release can
 *  land while `getUserMedia` is still being granted, and then nothing should start at all. */
let wanted = false
/** Set when the session was started by the mic button, which has no release: the recorder ends
 *  it itself. Null for a held hotkey, which ends when the key comes up. */
let autoStop: AutoStop | null = null
/** Whether this session has already told the main process that audio is arriving. One message
 *  per session, on the first block that is genuinely captured — see `announce`. */
let announced = false

interface AutoStop {
  startedAt: number
  /** RMS of the first FLOOR_BLOCKS blocks, averaged — the room with nobody talking. */
  floor: number[]
  /** What a block has to beat to count as speech. Fixed once the floor is known. */
  threshold: number
  /** Whether anything has yet cleared it. Until it has, silence means "has not started". */
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

  // Still warm from the last command: the graph never stopped, it was only ignoring what came
  // through it. This is the path that costs nothing — and the half second it has been holding
  // in the pre-roll covers the moment between the key going down and this running.
  if (context && processor && stream?.active) {
    chunks = preroll
    preroll = []
    // Nothing to wait for: the graph never stopped, and the next block is at most 64ms away.
    // Saying so now rather than on that block is what keeps a warm press from flashing
    // "Getting ready..." for a frame before it says "Listening".
    announce()
    return
  }

  const startedAt = performance.now()

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Echo cancellation is off, and that is a latency decision rather than a quality one.
        // Measured: with AEC on, opening the device took 720-870ms; with it off, 225-400ms.
        // Chromium has to wire up the render side of the audio pipeline to cancel against, and
        // every millisecond of that is a millisecond of the user's first word on the floor.
        // Noise suppression and gain control cost nothing measurable and both help in the
        // rooms this is actually used in, so they stay.
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
  // Chromium starts an AudioContext suspended unless the page has been interacted with, and
  // none of Ezzy's windows ever are — the dot is click-through and this one is never clicked.
  // A suspended context runs no graph at all: measured, the first recording came back as zero
  // samples with no error anywhere, which looks exactly like a microphone that is not there.
  if (context.state === 'suspended') await context.resume()
  source = context.createMediaStreamSource(stream)
  // Deprecated in favour of AudioWorklet, and still the right tool here: a worklet needs its
  // own module loaded from a URL, which under this window's `default-src 'self'` CSP means an
  // extra build entry for twenty lines of copying floats.
  processor = context.createScriptProcessor(BUFFER_FRAMES, 1, 1)
  processor.onaudioprocess = (event) => {
    // Copied, not referenced: the event's buffer is reused for the next block.
    const block = new Float32Array(event.inputBuffer.getChannelData(0))
    // Ezzy is talking, so this block is Ezzy. Dropped rather than recorded: with echo
    // cancellation off the confirmation comes back in through the microphone, and a recording
    // that opens with the tail of "Switching to Chrome" is transcribed as exactly that and
    // then matched against the commands as one sentence with whatever the user said next.
    //
    // A dropped block is safe for everything downstream. A gap in the audio is a gap, and the
    // hands-free timers below are driven by the clock rather than by the block count.
    if (wanted) {
      // No tail here: the press has already cut the confirmation off, and waiting out a tail
      // that has nothing left to play would spend the user's first word on it.
      if (isSpeaking()) return
      announce()
      chunks.push(block)
      if (autoStop && endOfUtterance(block, autoStop)) void stop(true)
      return
    }
    // Between commands, while the device is still open. Kept only long enough to cover the
    // start of the next one — and only when the room is the user's. Everything held here was
    // recorded before anything was pressed, so there is no cost to being strict about it.
    if (isSpeaking(true)) {
      preroll = []
      return
    }
    preroll.push(block)
    if (preroll.length > PREROLL_BLOCKS) preroll.shift()
  }

  // A ScriptProcessorNode only runs while it is connected to the destination, so the graph has
  // to reach the speakers — through a silent gain, or the microphone would be played back into
  // the room as it is recorded.
  const silence = context.createGain()
  silence.gain.value = 0
  source.connect(processor)
  processor.connect(silence)
  silence.connect(context.destination)
  // Every stage is measured. Opening the device is the one part of the voice
  // path that happens while the user is still talking, so its cost is the cost of a clipped
  // first word. Forwarded to the main process's --verbose log by windows.ts.
  console.log(`microphone open in ${(performance.now() - startedAt).toFixed(0)}ms`)
}

async function stop(send: boolean): Promise<void> {
  if (!wanted) return
  wanted = false
  autoStop = null
  const recorded = chunks
  chunks = []
  // A tap. Nothing recorded during it is looked at, encoded, or sent, and the device goes
  // straight back — nobody who was not asking for voice should be left with an indicator on.
  if (!send) {
    release()
    return
  }

  // A graph that delivered nothing at all. Seen once in testing, on a cold device while
  // another process was taking the speakers — a ScriptProcessorNode is pulled by the audio
  // *output*, so an output device that stalls stops the input arriving with it.
  //
  // The important part is not to keep it: a graph in this state would stay warm for the next
  // twenty seconds and swallow every command given in them. Tear it down, say so, and let the
  // next press build a new one. The main process reports the empty recording to the user.
  if (recorded.length === 0) {
    console.error(`[ezzy] the audio graph delivered nothing (context ${context?.state})`)
    release()
  } else {
    keepWarm()
  }
  // Whether anybody was talking is decided HERE, and it has to be: this is the last place the
  // real levels exist. `encodeWav` scales a quiet recording up to fill the range, so by the
  // time the main process has the bytes, a silent room and a spoken sentence are the same
  // height — and whisper will write a confident sentence over either of them.
  const spoke = hasSpeech(recorded)

  // Sent even when it is a fraction of a second long, and sent even when nothing was said:
  // the main process is waiting for exactly one answer per hold, and it is the one that turns
  // any of this into something the user is told.
  const wav = encodeWav(recorded)
  const ms = (((wav.byteLength - 44) / 2 / SAMPLE_RATE) * 1000).toFixed(0)
  console.log(`recorded ${ms}ms${spoke ? '' : ' (no speech in it)'}`)
  window.ezzy.sendVoiceAudio(wav, spoke)
}

/** Tell the main process the microphone is live, once per session.
 *
 *  Sent on a captured block rather than when `getUserMedia` resolves, because the promise is
 *  only half of it: the AudioContext still has to be built, resumed and pulled, and a graph
 *  that is not running looks exactly like a microphone that is not there. A block in hand is
 *  the first moment "listening" is a true word. */
function announce(): void {
  if (announced) return
  announced = true
  window.ezzy.reportMicLive()
}

/** Leave the device open for a moment in case another command follows. */
function keepWarm(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    release()
  }, KEEP_WARM_MS)
}

/** Tear the graph down and let go of the device. */
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

/** Has the speaker finished? Called for every 64ms block of a hands-free recording.
 *
 *  Three ways to be done, and the order matters: a sentence that ended, a sentence that never
 *  started, and one that will not stop. Only the first is the good case; the other two exist
 *  so the microphone always closes on its own. */
function endOfUtterance(block: Float32Array, session: AutoStop): boolean {
  const elapsed = performance.now() - session.startedAt
  if (elapsed > MAX_UTTERANCE_MS) {
    console.log(`hands-free: ${MAX_UTTERANCE_MS}ms cap reached, sending`)
    return true
  }

  const level = rms(block)

  // The room, before anyone speaks. Taken from the first blocks of THIS recording rather than
  // remembered, because the noise floor of a room changes and a stale one is worse than none.
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
    // Nothing has been said at all yet. This is a different clock from the one below: waiting
    // for someone to start is not the same as deciding they have stopped.
    if (elapsed < NO_SPEECH_MS) return false
    console.log('hands-free: nothing was said, giving the microphone back')
    return true
  }
  if (quietMs < TRAILING_SILENCE_MS) return false
  console.log(`hands-free: ${quietMs.toFixed(0)}ms of quiet after speech, sending`)
  return true
}

/** Was anybody talking during this recording?
 *
 *  Measured before `encodeWav`'s gain, against the same threshold the hands-free recorder uses
 *  to decide that somebody has started speaking — it is the same question asked at the end
 *  rather than as it goes along, so the two cannot disagree about what counts as a voice. */
function hasSpeech(blocks: Float32Array[]): boolean {
  let loud = 0
  for (const block of blocks) {
    if (rms(block) < MIN_SPEECH_RMS) continue
    if (++loud >= SPEECH_BLOCKS) return true
  }
  return false
}

function rms(block: Float32Array): number {
  let sum = 0
  for (const sample of block) sum += sample * sample
  return Math.sqrt(sum / block.length)
}

/** Quiet recordings transcribe badly, and a laptop's built-in microphone two feet from the
 *  speaker's mouth is quiet. Chromium's gain control helps but is conservative.
 *
 *  Bounded at both ends. Nothing louder than HEADROOM is touched, so a normal recording passes
 *  through untouched; nothing quieter than SILENCE is touched either, because scaling a
 *  near-empty buffer up by 8x turns room tone into something whisper will happily invent
 *  sentences out of. */
const HEADROOM = 0.9
const SILENCE = 0.02
const MAX_GAIN = 8

function gainFor(blocks: Float32Array[]): number {
  let peak = 0
  for (const block of blocks) {
    for (const sample of block) {
      const level = Math.abs(sample)
      if (level > peak) peak = level
    }
  }
  if (peak >= HEADROOM || peak <= SILENCE) return 1
  return Math.min(HEADROOM / peak, MAX_GAIN)
}

/** 16-bit PCM, mono, in a canonical 44-byte WAV. */
function encodeWav(blocks: Float32Array[]): ArrayBuffer {
  let frames = 0
  for (const block of blocks) frames += block.length
  const gain = gainFor(blocks)

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
      // Clamped after the gain and before scaling: the web audio range is nominally -1..1 but
      // a loud room does overshoot it, and wrapping a sample round is an audible click.
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
  // Windows Settings > Privacy > Microphone blocks this silently, and Chromium reports the
  // block as an ordinary permission denial.
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device'
  console.error('[ezzy] could not open the microphone:', error)
  return 'failed'
}
