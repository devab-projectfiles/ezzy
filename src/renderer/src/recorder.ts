/** The microphone half of push-to-talk (PLAN.md §8 chunk D).
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
 *  The microphone is opened when the hold starts and closed the moment it ends. Ezzy never
 *  holds it open between commands — the Windows recording indicator should be on exactly when
 *  Ezzy is listening, because that indicator is the user's only real guarantee. */

/** What whisper wants: 16kHz mono. The AudioContext resamples the device's own rate for us. */
const SAMPLE_RATE = 16_000

/** ScriptProcessor's buffer, in frames — 256ms at 16kHz. Large enough that the callback is not
 *  hot, small enough that the tail of an utterance is not lost when the key comes up. */
const BUFFER_FRAMES = 4096

let context: AudioContext | null = null
let source: MediaStreamAudioSourceNode | null = null
let processor: ScriptProcessorNode | null = null
let stream: MediaStream | null = null
let chunks: Float32Array[] = []
/** Whether the key is still held. Distinct from whether the graph is running: the release can
 *  land while `getUserMedia` is still being granted, and then nothing should start at all. */
let wanted = false

export function listenForCapture(): void {
  window.ezzy.onVoiceCapture((recording) => {
    if (recording) void start()
    else void stop()
  })
}

async function start(): Promise<void> {
  if (wanted) return
  wanted = true
  chunks = []
  const startedAt = performance.now()

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // All three are Chromium's own processing, and all three help: a launcher is used in
        // rooms with fans and keyboards in them, not in a booth.
        echoCancellation: true,
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
    if (!wanted) return
    // Copied, not referenced: the event's buffer is reused for the next block.
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
  }

  // A ScriptProcessorNode only runs while it is connected to the destination, so the graph has
  // to reach the speakers — through a silent gain, or the microphone would be played back into
  // the room as it is recorded.
  const silence = context.createGain()
  silence.gain.value = 0
  source.connect(processor)
  processor.connect(silence)
  silence.connect(context.destination)
  // §7 asks for every stage to be measured. Opening the device is the one part of the voice
  // path that happens while the user is still talking, so its cost is the cost of a clipped
  // first word. Forwarded to the main process's --verbose log by windows.ts.
  console.log(`microphone open in ${(performance.now() - startedAt).toFixed(0)}ms`)
}

async function stop(): Promise<void> {
  if (!wanted) return
  wanted = false
  const recorded = chunks
  chunks = []
  release()
  // Sent even when it is a fraction of a second long: the main process is waiting for exactly
  // one answer per hold, and it is the one that decides whether that was enough audio to be a
  // command. Silence answered with silence is a clearer failure than a timeout.
  const wav = encodeWav(recorded)
  console.log(`recorded ${(((wav.byteLength - 44) / 2 / SAMPLE_RATE) * 1000).toFixed(0)}ms`)
  window.ezzy.sendVoiceAudio(wav)
}

/** Tear the graph down and let go of the device. */
function release(): void {
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

/** 16-bit PCM, mono, in a canonical 44-byte WAV. */
function encodeWav(blocks: Float32Array[]): ArrayBuffer {
  let frames = 0
  for (const block of blocks) frames += block.length

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
      // Clamped before scaling: the web audio range is nominally -1..1 but a loud room does
      // overshoot it, and wrapping a sample round is an audible click.
      const clamped = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      offset += 2
    }
  }
  return buffer
}

/** The DOMException never crosses the bridge — only which of the three failures it was. */
function classify(error: unknown): 'denied' | 'no-device' | 'failed' {
  const name = error instanceof DOMException ? error.name : ''
  // §5: Windows Settings > Privacy > Microphone blocks this silently, and Chromium reports the
  // block as an ordinary permission denial.
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device'
  console.error('[ezzy] could not open the microphone:', error)
  return 'failed'
}
