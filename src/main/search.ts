/** Fuzzy matching over the window list and the app index (PLAN.md §8 chunk C).
 *
 *  §8 asks for "Fuse.js over `[...windows, ...apps]`, windows weighted higher", and the two
 *  halves of that sentence pull in different directions: one index is what makes the
 *  weighting mean anything (a window and an app can only be ranked against each other if
 *  they were scored together), but §6's panel has two fixed sections. So both happen — one
 *  search over the combined set, then the ranked results split back into their sections,
 *  each keeping the order the combined ranking gave it.
 *
 *  This runs in the main process rather than the panel. The query starts in the search-bar
 *  window and the results are drawn in the panel window, so it has to cross to main either
 *  way; doing the work here costs no extra hop and keeps both lists in one place.
 *
 *  §5, "match against window titles, not just app names": a window is indexed under its
 *  title *and* its owning app, so `index.ts — Visual Studio Code` answers to "index" and to
 *  "code". It does not answer to "typescript" — that would need a synonym table, which is
 *  not something §8 asks for. */

import Fuse, { type IFuseOptions } from 'fuse.js'
import { EzzyApp, EzzyWindow, MAX_APP_ROWS } from '../shared/types'
import { IndexedApp, toEzzyApp } from './app-index'
import { since } from './verbose'

/** Exported for `bestMatch`, which hands one of these back to the command registry — the
 *  caller needs to know whether it found a window to focus or an app to launch. */
export interface Candidate {
  kind: 'window' | 'app'
  /** What the row is called: a window's title, an app's name. */
  name: string
  /** Secondary text — a window's owning app. Empty for an app, whose name is all there is. */
  context: string
  /** Position in the source list, so equal scores fall back to MRU order for windows and
   *  alphabetical order for apps rather than to whatever Fuse happened to emit. */
  order: number
  window?: EzzyWindow
  app?: IndexedApp
}

const OPTIONS: IFuseOptions<Candidate> = {
  includeScore: true,
  // Without this Fuse scores a match by how near the start of the string it lands, which is
  // exactly wrong for window titles: the app name is at the end of every one of them.
  ignoreLocation: true,
  // Loose enough for a two-character abbreviation to reach the right app, tight enough that
  // typing three letters does not return the whole Start Menu.
  threshold: 0.4,
  keys: [
    { name: 'name', weight: 0.75 },
    { name: 'context', weight: 0.25 }
  ]
}

/** §8: "windows weighted higher". Applied to the score rather than as a Fuse key weight,
 *  because the preference is for a *kind* of record and Fuse weights fields. Lower is better
 *  in Fuse, so this multiplies a window's score down. */
const WINDOW_FAVOUR = 0.55

/** A name that starts with what was typed is almost always the intended one, and Fuse's
 *  ignoreLocation scoring deliberately does not know that. This is what makes "typing 2–3
 *  characters reliably finds the right thing" hold for `ch` -> Chrome rather than for
 *  whichever installed app happens to contain c and h. */
const PREFIX_FAVOUR = 0.3
/** Weaker version of the same, for a match at the start of any word: "vs" -> "Visual
 *  Studio Code", "wc" -> nothing, "code" -> "Visual Studio Code". */
const WORD_START_FAVOUR = 0.6

export interface SearchResult {
  windows: EzzyWindow[]
  apps: EzzyApp[]
}

/** Rank both lists against a query. An empty query is not a search: it is the panel's
 *  resting state — windows in MRU order, apps alphabetically — and takes no Fuse call. */
export function search(query: string, windows: EzzyWindow[], apps: IndexedApp[]): SearchResult {
  const text = query.trim()
  if (text === '') {
    return { windows, apps: apps.slice(0, MAX_APP_ROWS).map(toEzzyApp) }
  }

  const startedAt = performance.now()
  const ranked = rankAll(text, toCandidates(windows, apps))

  const matchedWindows: EzzyWindow[] = []
  const matchedApps: EzzyApp[] = []
  for (const { candidate } of ranked) {
    if (candidate.window) matchedWindows.push(candidate.window)
    else if (candidate.app && matchedApps.length < MAX_APP_ROWS) {
      matchedApps.push(toEzzyApp(candidate.app))
    }
  }
  since(`search "${text}": ${matchedWindows.length}w ${matchedApps.length}a`, startedAt)
  return { windows: matchedWindows, apps: matchedApps }
}

function rank(candidate: Candidate, score: number, needle: string): number {
  // Fuse returns 0 for a perfect match, and 0 stays 0 through every multiplier below — so a
  // perfect app match would tie a perfect window match. The floor keeps the preferences
  // meaningful all the way down.
  let value = Math.max(score, 0.001)
  const name = candidate.name.toLowerCase()
  if (name.startsWith(needle)) value *= PREFIX_FAVOUR
  else if (startsAWord(name, needle) || startsAWord(candidate.context.toLowerCase(), needle)) {
    value *= WORD_START_FAVOUR
  }
  if (candidate.kind === 'window') value *= WINDOW_FAVOUR
  return value
}

/** Whether the needle begins any word of the haystack. Word boundaries are anything that is
 *  not a letter or a digit, which covers spaces, hyphens, dots and the em dash that Windows
 *  puts between a document and its app in a title bar. */
function startsAWord(haystack: string, needle: string): boolean {
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    if (at === 0 || !/[a-z0-9]/.test(haystack[at - 1])) return true
    at = haystack.indexOf(needle, at + 1)
  }
  return false
}

function toCandidates(windows: EzzyWindow[], apps: IndexedApp[]): Candidate[] {
  return [
    ...windows.map((window, order): Candidate => ({
      kind: 'window',
      name: window.title,
      context: window.app,
      order,
      window
    })),
    ...apps.map((app, order): Candidate => ({
      kind: 'app',
      name: app.name,
      context: '',
      order,
      app
    }))
  ]
}

/** Rebuilt per query rather than kept warm. Both lists change constantly — every window title
 *  edit and every icon that lands re-publishes them — so a cached index would need invalidating
 *  on both, and building one over a few hundred short strings is sub-millisecond. */
function rankAll(text: string, candidates: Candidate[]): Ranked[] {
  const needle = text.toLowerCase()
  return new Fuse(candidates, OPTIONS)
    .search(text)
    .map((hit) => ({
      candidate: hit.item,
      score: hit.score ?? 1,
      rank: rank(hit.item, hit.score ?? 1, needle)
    }))
    .sort((a, b) => a.rank - b.rank || a.candidate.order - b.candidate.order)
}

interface Ranked {
  candidate: Candidate
  /** Fuse's own score, 0 for a perfect match. Kept apart from `rank` because the favours
   *  that go into a rank are about *ordering* a list, and confidence is about whether the top
   *  of that list means anything at all. */
  score: number
  rank: number
}

/** A match good enough to act on without asking. Everything at or under this is either the
 *  right answer or a near-duplicate of it: measured against this machine's index, "chrome"
 *  scores 0.026 on Google Chrome, "cursor" 0.000, "anti-gravity" 0.155 on Antigravity. */
const CONFIDENT = 0.45

/** Above CONFIDENT but still worth acting on *if nothing else is close*. */
const PLAUSIBLE = 0.7

/** How far ahead of the runner-up a merely plausible match has to be. Measured, "crawl"
 *  returns Calculator and Calendar tied at 0.503 and "crow" returns three apps tied at 0.479 —
 *  a tie in that band means whisper produced a word that resembles nothing. */
const DECISIVE_GAP = 0.12

/** A whole-name near-miss, for the case word-start cannot see: §5's "sigma" for Figma, where
 *  the substitution is in the first syllable. The two strings have to be the same shape —
 *  measured, sigma/Figma is a length ratio of 1.0 at 0.299, while "batterys port"/BatteryBar
 *  is 0.77 at 0.385 and is not the same word at all. */
const WHOLE_NAME_RATIO = 0.8
const WHOLE_NAME_SCORE = 0.3

/** The single best thing a spoken target names, or null when nothing matches well enough.
 *
 *  The panel shows a list and lets the user pick, so a mediocre match there costs nothing and
 *  none of this applies to it. A voice command has to pick for the user, and picking wrong is
 *  worse than refusing — Fuse's threshold alone returns Calculator for "crawl", Calendar for
 *  "end" (caL-END-ar contains it exactly, scoring 0.006) and BatteryBar for "batterys port",
 *  every one of which means the wrong application starting.
 *
 *  So a spoken match has to be a match to something the user could plausibly have *said*: it
 *  begins the name or one of its words, or it is the whole name with a syllable misheard.
 *  Evaluated over 18 real targets and 11 things whisper invents out of silence: every
 *  invention refused, and the only real targets it turns away are "vs code" (say "visual
 *  studio code") and the genuine ambiguity between "code" and the Codex app.
 *
 *  §5, "always fuzzy-match, never exact-match" — whisper hands this "sigma" for Figma and
 *  "anti-gravity" for Antigravity, and both still land.
 *
 *  `strict` drops the plausible band. It is for the bare-target fallback, where no verb
 *  vouches for the utterance being a command at all. */
export function bestMatch(
  query: string,
  windows: EzzyWindow[],
  apps: IndexedApp[],
  strict = false
): Candidate | null {
  const text = query.trim()
  if (text === '') return null
  const startedAt = performance.now()
  const ranked = rankAll(text, toCandidates(windows, apps))
  const best = ranked[0]
  const accepted = best !== undefined && isConfident(best, ranked[1], text.toLowerCase(), strict)
  since(
    `best match for "${text}": ${
      best === undefined
        ? 'nothing'
        : `${best.candidate.name} @ ${best.score.toFixed(3)}${accepted ? '' : ' (rejected)'}`
    }`,
    startedAt
  )
  return accepted ? best.candidate : null
}

function isConfident(
  best: Ranked,
  runnerUp: Ranked | undefined,
  needle: string,
  strict: boolean
): boolean {
  if (!soundsLikeIt(best, needle)) return false
  if (best.score <= CONFIDENT) return true
  if (strict || best.score > PLAUSIBLE) return false
  return runnerUp === undefined || runnerUp.score - best.score >= DECISIVE_GAP
}

/** Whether the needle is something the user could have been saying when they named this
 *  candidate — as opposed to a string that merely shares letters with it. */
function soundsLikeIt(best: Ranked, needle: string): boolean {
  if (beginsSomething(best.candidate, needle)) return true
  const name = best.candidate.name.toLowerCase()
  const ratio = Math.min(needle.length, name.length) / Math.max(needle.length, name.length)
  return ratio >= WHOLE_NAME_RATIO && best.score <= WHOLE_NAME_SCORE
}

/** The needle begins the name, one of its words, or the owning app's — the shapes a spoken
 *  name actually takes, since people say things from the front. */
function beginsSomething(candidate: Candidate, needle: string): boolean {
  const name = candidate.name.toLowerCase()
  const context = candidate.context.toLowerCase()
  return (
    begins(name, needle) ||
    begins(context, needle) ||
    // Punctuation removed from both sides, which is what carries "anti-gravity" to
    // Antigravity: whisper hyphenates compound names and no app is spelled that way.
    begins(depunctuate(name), depunctuate(needle)) ||
    begins(depunctuate(context), depunctuate(needle))
  )
}

function begins(haystack: string, needle: string): boolean {
  if (needle === '' || haystack === '') return false
  return haystack.startsWith(needle) || startsAWord(haystack, needle)
}

/** Spaces are kept: they are word boundaries, and word boundaries are the whole point. */
function depunctuate(text: string): string {
  return text.replace(/[^a-z0-9 ]/g, '')
}
