import { SpeechRequest } from '../../shared/types'

// Lives in the dot's renderer, the one window always alive. Nothing here decides what to
// say — the sentence, phrasing and on/off setting are main-process concerns (main/speech.ts).

let chosen: SpeechSynthesisVoice | null = null

// Chromium collects an utterance nothing references while it's still speaking, which
// truncates it mid-word — holding the current one is the documented way around that.
let speaking: SpeechSynthesisUtterance | null = null

// cancel() then speak() in the same task hits a Chromium bug where the new utterance is
// queued and never starts.
const RESTART_MS = 80

let rate = 1.08
let volume = 0.85
let wanted: string | null = null

// `onend` fires a moment before the last of the audio has actually reached the mic; without
// a tail the final syllable lands at the front of the next recording.
const ECHO_TAIL_MS = 250

let endedAt = 0

const PREFERRED = ['aria', 'jenny', 'guy', 'natural', 'zira', 'david', 'mark']

export function initSpeech(): () => void {
  pickVoice()
  window.speechSynthesis.addEventListener('voiceschanged', pickVoice)
  return () => window.speechSynthesis.removeEventListener('voiceschanged', pickVoice)
}

export function speak(request: SpeechRequest): void {
  const { text } = request
  rate = request.rate
  volume = request.volume
  if (request.voice !== wanted) {
    wanted = request.voice
    pickVoice()
  }
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
  utterance.rate = rate
  utterance.volume = volume
  if (chosen) {
    utterance.voice = chosen
    utterance.lang = chosen.lang
  }
  const release = (): void => {
    if (speaking !== utterance) return
    endedAt = performance.now()
    speaking = null
  }
  utterance.onend = release
  utterance.onerror = (event) => {
    release()
    if (event.error === 'interrupted' || event.error === 'canceled') return
    console.warn(`speech failed: ${event.error}`)
  }
  utterance.onstart = () => console.debug(`speaking: "${text}"`)
  speaking = utterance
  window.speechSynthesis.speak(utterance)
}

// Echo cancellation is off (it tripled the mic's open time), so anything Ezzy says while the
// device is open is recorded along with the user. `tail` covers the pre-roll, where nothing
// had to be recorded; a live recording passes false since every dropped block is the user's.
export function isSpeaking(tail = false): boolean {
  const synth = window.speechSynthesis
  if (synth.speaking || synth.pending) return true
  return tail && performance.now() - endedAt < ECHO_TAIL_MS
}

function pickVoice(): void {
  const all = window.speechSynthesis.getVoices()
  console.log(`speech: ${all.length} voices available`)
  // A voice asked for by name wins outright and is not filtered to English.
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
