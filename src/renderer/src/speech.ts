import { SpeechRequest } from '../../shared/types'

/** The `speechSynthesis` wrapper.
 *
 *  It lives in a renderer because the plan says it has to: speech synthesis is a web API and the
 *  main process does not have one. Specifically it lives in the DOT's renderer, which is the
 *  only window that is always alive — a confirmation usually arrives just after the panel has
 *  been dismissed, so a search bar that no longer exists cannot be the one talking.
 *
 *  Nothing here decides what to say. The sentence, the varied phrasing and the on/off setting
 *  are all main-process concerns (see `main/speech.ts`); this only puts it through the OS. */

/** Whichever installed voice reads English best. Windows always has at least one. */
let chosen: SpeechSynthesisVoice | null = null

/** Chromium collects an utterance that nothing references while it is still speaking, which
 *  truncates it mid-word. Holding the current one is the documented way around that. */
let speaking: SpeechSynthesisUtterance | null = null

/** cancel() followed by speak() in the same task is the long-standing Chromium bug where the
 *  new utterance is queued and never starts. Only paid when something was actually talking. */
const RESTART_MS = 80

/** The pace and loudness now come with the sentence — they are settings, and the main
 *  process is where settings live. See `SpeechRequest`. What used to be the constants here
 *  are the defaults in DEFAULT_CONFIG: just above natural, because a confirmation is four
 *  words the user is already expecting, and below full, because it is furniture rather than
 *  the thing they are doing. */
let rate = 1.08
let volume = 0.85
/** The voice the user asked for by name, or null to pick the best English one. */
let wanted: string | null = null

/** How long after the last word the room still counts as loud.
 *
 *  `onend` fires when the synthesiser has finished, which is a moment before the last of it
 *  has left the speakers and travelled back to the microphone. Without a tail the final
 *  syllable of a confirmation lands at the front of the next recording on its own.
 *
 *  Only ever applied to a sentence that finished by itself. One that was CUT OFF — which is
 *  what every press of the hotkey does to it — needs no tail at all: `cancel` stops the audio
 *  rather than letting it drain, and a tail there would be a quarter second of the user's own
 *  first word thrown away to guard against silence. */
const ECHO_TAIL_MS = 250

/** When speech last stopped, so `isSpeaking` can hold the gate open for its tail. Zero means
 *  nothing has ever been said, which the arithmetic below reads as long ago. */
let endedAt = 0

/** In preference order, matched against the voice name. The Windows 11 natural voices are
 *  much better than the legacy SAPI ones and are worth asking for by name; everything after
 *  is a fallback for a machine that does not have them. */
const PREFERRED = ['aria', 'jenny', 'guy', 'natural', 'zira', 'david', 'mark']

/** Returns a disposer, so the caller's effect can clean up after itself. The dot's component
 *  never unmounts in a packaged build, but it does under StrictMode in dev, and a listener
 *  that survives its own effect is the kind of thing that is only ever noticed later. */
export function initSpeech(): () => void {
  pickVoice()
  // The list is populated asynchronously and is usually empty on the first call.
  window.speechSynthesis.addEventListener('voiceschanged', pickVoice)
  return () => window.speechSynthesis.removeEventListener('voiceschanged', pickVoice)
}

/** Say it, interrupting whatever is already being said. An empty string only interrupts —
 *  that is how the main process shuts speech up when a new command starts. */
export function speak(request: SpeechRequest): void {
  const { text } = request
  // Adopted before anything is said, so a change in settings applies to the very next
  // sentence rather than to the one after it.
  rate = request.rate
  volume = request.volume
  if (request.voice !== wanted) {
    wanted = request.voice
    pickVoice()
  }
  const synth = window.speechSynthesis
  const wasBusy = synth.speaking || synth.pending
  // Dropping the reference before the cancelled utterance's own event arrives is what tells
  // `release` below that this one was interrupted rather than finished — see ECHO_TAIL_MS.
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
  // Guarded so a late event from an utterance that was already cancelled cannot drop the
  // reference to the one that replaced it.
  const release = (): void => {
    // Not the current utterance any more: it was cancelled, and `speak` already let go of it.
    // Nothing is still coming out of the speakers, so no tail is owed.
    if (speaking !== utterance) return
    endedAt = performance.now()
    speaking = null
  }
  utterance.onend = release
  utterance.onerror = (event) => {
    release()
    // Silence is the only symptom a failed confirmation has, so it says so somewhere. Being
    // interrupted is not a failure — that is what a new command is supposed to do to the old
    // one's confirmation. This reaches the verbose log through the console hook in windows.ts.
    if (event.error === 'interrupted' || event.error === 'canceled') return
    console.warn(`speech failed: ${event.error}`)
  }
  utterance.onstart = () => console.debug(`speaking: "${text}"`)
  speaking = utterance
  window.speechSynthesis.speak(utterance)
}

/** Is Ezzy's own voice in the room right now?
 *
 *  Asked by the recorder, which lives in this same window, for every 64ms block it captures.
 *  Echo cancellation is off — measured, it tripled the time the microphone takes to open, and
 *  that time comes out of the user's first word — so anything Ezzy says while the device is
 *  open is recorded along with the user. Whisper transcribes it perfectly well, and the
 *  command it then fails to match is Ezzy's last sentence with the user's new one on the end.
 *
 *  The main process silences speech the instant the hotkey goes down, so what this actually
 *  covers is the fraction of a second between that and the sound stopping — plus the pre-roll,
 *  which is buffered while nothing has been pressed at all.
 *
 *  `tail` asks whether the moments just after the last word count too. The pre-roll asks for
 *  it, because nothing there was meant to be recorded and a stale syllable costs nothing to
 *  discard. A live recording does not, because every block it drops is a block of the user. */
export function isSpeaking(tail = false): boolean {
  const synth = window.speechSynthesis
  if (synth.speaking || synth.pending) return true
  return tail && performance.now() - endedAt < ECHO_TAIL_MS
}

/** Local voices only where there is a choice: a network voice adds latency to something that
 *  is meant to be instant, and it stops working on a train. */
function pickVoice(): void {
  const all = window.speechSynthesis.getVoices()
  // A voice asked for by name wins outright, and is not filtered to English — someone who
  // chose a Spanish voice chose it. A name that is no longer installed falls through to the
  // preference order below rather than leaving the app silent.
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
