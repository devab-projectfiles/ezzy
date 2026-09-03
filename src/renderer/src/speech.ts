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

/** Just above natural. A confirmation is four words the user is already expecting, and the
 *  default rate makes it feel like waiting for a machine to finish. */
const RATE = 1.08

/** The confirmation is furniture, not the thing the user is doing. */
const VOLUME = 0.85

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
export function speak(text: string): void {
  const synth = window.speechSynthesis
  const wasBusy = synth.speaking || synth.pending
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
  utterance.rate = RATE
  utterance.volume = VOLUME
  if (chosen) {
    utterance.voice = chosen
    utterance.lang = chosen.lang
  }
  // Guarded so a late event from an utterance that was already cancelled cannot drop the
  // reference to the one that replaced it.
  const release = (): void => {
    if (speaking === utterance) speaking = null
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

/** Local voices only where there is a choice: a network voice adds latency to something that
 *  is meant to be instant, and it stops working on a train. */
function pickVoice(): void {
  const voices = window.speechSynthesis.getVoices().filter((voice) => voice.lang.startsWith('en'))
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
