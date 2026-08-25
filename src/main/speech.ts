/** Spoken confirmations (PLAN.md §8 chunk E).
 *
 *  What gets said is decided here; the saying happens in the dot's renderer, because §5 is
 *  explicit that `speechSynthesis` is a web API with no main-process equivalent and that
 *  trying to work around that is not worth the 0.5ms an IPC hop costs.
 *
 *  **Only voice commands speak.** Someone who clicked a row or pressed Enter is looking
 *  straight at the screen and has already seen the window come forward; narrating that would
 *  be noise. §8 puts the weight on the other case — "spoken matters here, because the user
 *  isn't looking at the dot when a command misses" — so a failure is announced exactly as
 *  readily as a success.
 *
 *  §7's "act before you speak" is not enforced here, it is enforced by where this is called
 *  from: voice.ts speaks only once the command has already run. Speech is fire-and-forget and
 *  must never sit between the user finishing their sentence and the window appearing. */

import { getConfig } from './config'
import { log } from './verbose'
import { speakInDot } from './windows'

/** §8 asks for varied phrasing. Varying the whole sentence would mean every command owning
 *  several ways to describe itself; varying only what comes in front of it costs nothing and
 *  is what actually grates when repeated — the same four words, in the same order, forty times
 *  an hour. The empty leads are in the pool deliberately and are the most common outcome: the
 *  plain sentence is the good version, and the point is that it is not the only one. */
const SUCCESS_LEADS = ['', '', '', 'Okay, ', 'Sure, ', 'Got it, ', 'Right, ']
const FAILURE_LEADS = ['', '', 'Sorry, ', 'Hmm, ']

export type Tone = 'success' | 'failure'

/** Say something, if the user has left speech on. The text is whatever the command's
 *  `describe` returned, or the reason it gave for failing — the same words the pill shows,
 *  so what is heard and what is read never disagree. */
export function speak(text: string, tone: Tone): void {
  if (text.trim() === '') return
  if (!getConfig().speech) return
  const line = `${lead(tone)}${text}`
  log(`speech: "${line}"`)
  speakInDot(line)
}

/** Stop talking. Sent when a new command starts, so a confirmation still playing does not
 *  end up in the microphone that is about to open. */
export function hush(): void {
  speakInDot('')
}

/** Never the same lead twice running, which is the only thing anyone actually notices. */
const lastUsed: Record<Tone, number> = { success: -1, failure: -1 }

function lead(tone: Tone): string {
  const pool = tone === 'success' ? SUCCESS_LEADS : FAILURE_LEADS
  let index = Math.floor(Math.random() * pool.length)
  if (index === lastUsed[tone]) index = (index + 1) % pool.length
  lastUsed[tone] = index
  return pool[index]
}
