import { SpeechRequest } from '../../shared/types'

/** The `speechSynthesis` wrapper. Lives in the dot's renderer — the one window always
 *  alive, since a confirmation usually arrives just after the panel is dismissed and a
 *  search bar that no longer exists cannot be the one talking.
 *
 *  Nothing here decides what to say — the sentence, phrasing and on/off setting are all
 *  main-process concerns (see main/speech.ts); this only puts it through the OS. */

/** Whichever installed voice reads English best. Windows always has at least one. */
let chosen: SpeechSynthesisVoice | null = null

/** Chromium collects an utterance nothing references while it is still speaking, which
 *  truncates it mid-word — holding the current one is the documented way around that. */
let speaking: SpeechSynthesisUtterance | null = null

/** cancel() then speak() in the same task hits a long-standing Chromium bug where the new
 *  utterance is queued and never starts. Only paid when something was actually talking. */
const RESTART_MS = 80

/** Rate and volume travel with the sentence now (see SpeechRequest); these are just the
 *  working values, defaulting to just above natural pace and below full volume — a
 *  confirmation the user is already expecting, not the thing they are doing. */
let rate = 1.08
let volume = 0.85
/** The voice the user asked for by name, or null to pick the best English one. */
let wanted: string | null = null

/** How long after the last word the room still counts as loud. `onend` fires a moment
 *  before the last of it has actually left the speakers and reached the mic — without a
 *  tail, the final syllable lands at the front of the next recording. Only applied to a
 *  sentence that finished on its own; one cut off by the hotkey needs none, since
 *  `cancel` stops the audio rather than letting it drain. */
const ECHO_TAIL_MS = 250

/** When speech last stopped, so `isSpeaking` can hold the gate open for its tail. */
let endedAt = 0

/** In preference order. The Windows 11 natural voices are worth asking for by name;
 *  everything after is a fallback for a machine without them. */
const PREFERRED = ['aria', 'jenny', 'guy', 'natural', 'zira', 'david', 'mark']

/** Returns a disposer — the dot's component never unmounts in a packaged build, but does
 *  under StrictMode in dev. */
export function initSpeech(): () => void {
  pickVoice()
  // The list is populated asynchronously and is usually empty on the first call.
  window.speechSynthesis.addEventListener('voiceschanged', pickVoice)
  return () => window.speechSynthesis.removeEventListener('voiceschanged', pickVoice)
}

/** Say it, interrupting whatever is already being said. An empty string only interrupts —
 *  how the main process shuts speech up when a new command starts. */
export function speak(request: SpeechRequest): void {
  const { text } = request
  // Adopted before anything is said, so a settings change applies to the very next
  // sentence rather than the one after it.
  rate = request.rate
  volume = request.volume
  if (request.voice !== wanted) {
    wanted = request.voice
    pickVoice()
  }
  const synth = window.speechSynthesis
  const wasBusy = synth.speaking || synth.pending
  // Dropping the reference before the cancelled utterance's own event arrives is what
  // tells `release` below this one was interrupted rather than finished.
  synth.cancel()
  speaking = null
  if (text.trim() === '') return
  if (wasBusy) {
    setTimeout(() => say(text), RESTART_MS)
    return
  }
  say(text)
}

function say(text: string): void {
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = rate
  utterance.volume = volume
  if (chosen) {
    utterance.voice = chosen
    utterance.lang = chosen.lang
  }
  // Guarded so a late event from an already-cancelled utterance cannot drop the
  // reference to the one that replaced it.
  const release = (): void => {
    if (speaking !== utterance) return
    endedAt = performance.now()
    speaking = null
  }
  utterance.onend = release
  utterance.onerror = (event) => {
    release()
    // Being interrupted is not a failure — that is what a new command is supposed to do.
    if (event.error === 'interrupted' || event.error === 'canceled') return
    console.warn(`speech failed: ${event.error}`)
  }
  utterance.onstart = () => console.debug(`speaking: "${text}"`)
  speaking = utterance
  window.speechSynthesis.speak(utterance)
}

/** Is Ezzy's own voice in the room right now? Asked by the recorder in this same window
 *  for every 64ms block it captures — echo cancellation is off (it tripled the mic's open
 *  time), so anything Ezzy says while the device is open is recorded along with the user.
 *
 *  Main silences speech the instant the hotkey goes down, so this really only covers the
 *  fraction of a second between that and the sound stopping, plus the pre-roll (buffered
 *  before anything is pressed). `tail` asks whether the moment just after the last word
 *  counts too — yes for the pre-roll (nothing there had to be recorded), no for a live
 *  recording (every block dropped there is a block of the user). */
export function isSpeaking(tail = false): boolean {
  const synth = window.speechSynthesis
  if (synth.speaking || synth.pending) return true
  return tail && performance.now() - endedAt < ECHO_TAIL_MS
}

/** Local voices only where there is a choice — a network voice adds latency to something
 *  meant to be instant, and stops working on a train. */
function pickVoice(): void {
  const all = window.speechSynthesis.getVoices()
  // Logged before anything can return early — Chromium fills this list asynchronously
  // and answers empty until it has, which otherwise looks like a missing feature.
  console.log(`speech: ${all.length} voices available`)
  // A voice asked for by name wins outright and is not filtered to English — someone
  // who chose a Spanish voice chose it. Falls through if it is no longer installed.
  if (wanted !== null) {
    const named = all.find((voice) => voice.name === wanted)
    if (named) {
      chosen = named
      return
    }
  }
  const voices = all.filter((voice) => voice.lang.startsWith('en'))
  if (voices.length === 0) return
  const local = voices.filter((voice) => voice.localService)
  const pool = local.length > 0 ? local : voices
  for (const name of PREFERRED) {
    const hit = pool.find((voice) => voice.name.toLowerCase().includes(name))
    if (hit) {
      chosen = hit
      return
    }
  }
  chosen = pool.find((voice) => voice.default) ?? pool[0]
}
