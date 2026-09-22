// Only voice commands speak: someone who clicked a row or pressed Enter is already looking
// at the screen. The saying happens in the dot's renderer since speechSynthesis is a web API
// with no main-process equivalent.

import { getConfig } from './config'
import { log } from './verbose'
import { speakInDot } from './windows'

// Empty leads are in the pool deliberately and are the most common outcome: the plain
// sentence is the good version.
const SUCCESS_LEADS = ['', '', '', 'Okay, ', 'Sure, ', 'Got it, ', 'Right, ']
const FAILURE_LEADS = ['', '', 'Sorry, ', 'Hmm, ']

export type Tone = 'success' | 'failure'

export function speak(text: string, tone: Tone): void {
  if (text.trim() === '') return
  const config = getConfig()
  if (!config.speech) return
  const line = config.speechVariety ? `${lead(tone)}${text}` : text
  log(`speech: "${line}"`)
  speakInDot({
    text: line,
    voice: config.voiceName,
    rate: config.speechRate,
    volume: config.speechVolume
  })
}

export function hush(): void {
  const config = getConfig()
  speakInDot({
    text: '',
    voice: config.voiceName,
    rate: config.speechRate,
    volume: config.speechVolume
  })
}

const lastUsed: Record<Tone, number> = { success: -1, failure: -1 }

function lead(tone: Tone): string {
  const pool = tone === 'success' ? SUCCESS_LEADS : FAILURE_LEADS
  let index = Math.floor(Math.random() * pool.length)
  if (index === lastUsed[tone]) index = (index + 1) % pool.length
  lastUsed[tone] = index
  return pool[index]
}
