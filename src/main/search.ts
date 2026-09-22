/** Fuzzy matching over the window list and the app index.
 *
 *  One combined Fuse index rather than two — a window and an app can only be ranked
 *  against each other if they are scored together — with the results split back into the
 *  panel's two fixed sections afterwards, each keeping the order the combined ranking gave it.
 *
 *  Runs in the main process: the query starts in the search bar and the results are drawn
 *  in the panel, so it crosses to main either way, and this keeps both lists in one place.
 *
 *  A window is indexed under its title AND its owning app, so `index.ts — Visual Studio
 *  Code` answers to "index" and to "code" (not to "typescript" — that would need a synonym
 *  table). */

import Fuse, { type IFuseOptions } from 'fuse.js'
import { EzzyApp, EzzyWindow, MAX_APP_ROWS } from '../shared/types'
import { IndexedApp, toEzzyApp } from './app-index'
import { since } from './verbose'

/** Exported for `bestMatch`, which hands one back to the command registry. */
export interface Candidate {
  kind: 'window' | 'app'
  /** A window's title, an app's name. */
  name: string
  /** A window's owning app; empty for an app. */
  context: string
  /** Position in the source list — equal scores fall back to MRU order for windows and
   *  alphabetical for apps, rather than to whatever Fuse happened to emit. */
  order: number
  /** Names the user supplied, weighted like the real name — see `labelsOf`. */
  aliases: string[]
  window?: EzzyWindow
  app?: IndexedApp
}

const OPTIONS: IFuseOptions<Candidate> = {
  includeScore: true,
  // Without this Fuse scores by how near the start of the string a match lands, which is
  // exactly wrong for window titles — the app name is at the end of every one.
  ignoreLocation: true,
  threshold: 0.4,
  keys: [
    { name: 'name', weight: 0.75 },
    // Its own key rather than folded into `name` — Fuse scores a key as one string, and
    // joining several aliases together would make each a worse match than it is alone.
    { name: 'aliases', weight: 0.75 },
    { name: 'context', weight: 0.25 }
  ]
}

/** Windows are weighted higher. Applied to the score rather than as a Fuse key weight,
 *  since the preference is for a kind of record, not a field. Lower is better in Fuse. */
const WINDOW_FAVOUR = 0.55

/** A name that starts with what was typed is almost always intended, and Fuse's
 *  ignoreLocation scoring does not know that — this is what makes "ch" reliably find
 *  Chrome rather than whichever app happens to contain both letters. */
const PREFIX_FAVOUR = 0.3
/** Weaker version, for a match at the start of any word: "vs" -> "Visual Studio Code". */
const WORD_START_FAVOUR = 0.6

export interface SearchResult {
  windows: EzzyWindow[]
  apps: EzzyApp[]
}

/** Rank both lists against a query. An empty query is the panel's resting state — windows
 *  in MRU order, apps alphabetically — and takes no Fuse call. */
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
  // Fuse returns 0 for a perfect match, and 0 stays 0 through every multiplier below, so
  // the floor keeps two perfect matches distinguishable by the favours that follow.
  let value = Math.max(score, 0.001)
  const name = candidate.name.toLowerCase()
  if (name.startsWith(needle)) value *= PREFIX_FAVOUR
  else if (startsAWord(name, needle) || startsAWord(candidate.context.toLowerCase(), needle)) {
    value *= WORD_START_FAVOUR
  }
  if (candidate.kind === 'window') value *= WINDOW_FAVOUR
  return value
}

/** Whether the needle begins any word of the haystack. A word boundary is anything that is
 *  not a letter or digit — spaces, hyphens, dots, the em dash Windows puts in a title bar. */
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
      aliases: [],
      order,
      window
    })),
    ...apps.map((app, order): Candidate => ({
      kind: 'app',
      name: app.name,
      context: '',
      aliases: app.aliases,
      order,
      app
    }))
  ]
}

/** Rebuilt per query rather than kept warm — both lists change constantly, and building an
 *  index over a few hundred short strings is sub-millisecond. */
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
  /** Fuse's own score, 0 for a perfect match — kept apart from `rank`, which is about
   *  ordering the list, not about whether the top of it means anything. */
  score: number
  rank: number
}

/** A match good enough to act on without asking. Measured on this machine's index:
 *  "chrome" scores 0.026 on Chrome, "cursor" 0.000, "anti-gravity" 0.155 on Antigravity. */
const CONFIDENT = 0.45

/** Above CONFIDENT but still worth acting on if nothing else is close. */
const PLAUSIBLE = 0.7

/** How far ahead of the runner-up a merely plausible match must be. Measured: "crawl"
 *  ties Calculator and Calendar at 0.503, "crow" ties three apps at 0.479 — a tie in that
 *  band means whisper produced a word that resembles nothing. */
const DECISIVE_GAP = 0.12

/** A whole-name near-miss ("sigma" for Figma), for a substitution word-start cannot see.
 *  Two tests: the strings must be the same length (a ratio floor) and the same sound in
 *  the same order (edit distance, which Fuse's own score does not measure) — needed
 *  because "cordix" (whisper's "codex") shares six letters with Discord and would
 *  otherwise pass on score alone. Measured over this machine's index: every near-miss
 *  worth taking scores 0.667+, every one worth refusing scores 0.615 or worse. */
const WHOLE_NAME_RATIO = 0.8
const NEAR_MISS_SIMILARITY = 0.65

/** Two ranks this close are a tie, broken by which name is closest in length to what was
 *  said. Measured: "rise" scores identically against OneDrive and Rize, and without this
 *  the alphabetically earlier one always won. */
const NEAR_TIE = 0.05

/** How many trailing words may be dropped when the whole phrase matches nothing — whisper
 *  appends things ("switch to visual studio code ciao with"), and people do too ("open
 *  notepad please"). Capped at two: dropping words until something matches would
 *  eventually match anything. */
const MAX_TRAILING_JUNK = 2

/** The phrase to match, then the same phrase without its last word or two. Only offered
 *  when a verb vouched for the utterance — a bare name has nothing to trim. */
export function spokenVariants(target: string, strict: boolean): string[] {
  const words = target
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  if (strict || words.length <= 1) return [target]
  const variants = [target]
  for (let drop = 1; drop <= MAX_TRAILING_JUNK && words.length - drop >= 1; drop++) {
    const shorter = words.slice(0, words.length - drop)
    // A remnant that is all grammar and no name is not a target — "the end" (what a
    // silent room transcribes as) trims to "the", which begins a real app name.
    if (shorter.every((word) => FUNCTION_WORDS.has(word))) continue
    variants.push(shorter.join(' '))
  }
  return variants
}

/** Words a trailing trim can strand on its own — never consulted about what the user
 *  actually said, only about what is left over. */
const FUNCTION_WORDS = new Set(
  (
    'a an and are as at be been but by did do does for from had has have he her here his how i ' +
    'in is it its me my no not now of ok okay on or our please she so than thank thanks that ' +
    'the their then there these they this those to up us was we were what when where which who ' +
    'why will with yeah yes you your'
  ).split(' ')
)

/** The single best thing a spoken target names, or null when nothing matches well enough.
 *
 *  Voice has to pick for the user, and picking wrong is worse than refusing — Fuse's
 *  threshold alone returns Calculator for "crawl" and Calendar for "end". So a spoken
 *  match must be something the user could plausibly have SAID: it begins the name or one
 *  of its words, or spells it out word by word with initialisms allowed, or is the whole
 *  name with a syllable misheard — never an exact match, since whisper hands this "sigma"
 *  for Figma. Verified by running this over 23 real targets and 15 things whisper invents
 *  out of silence on this machine's index: every invention refused, every real one reached.
 *
 *  `strict` drops the plausible band — for the bare-target fallback, where no verb
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
  const needle = text.toLowerCase()
  const ranked = rankAll(text, toCandidates(windows, apps))
  // Filtered before choosing, not gated on the winner afterwards — "cordix" ranks
  // Discord first and Codex second, and refusing at the top would throw away Codex too.
  const eligible = ranked.filter((hit) => soundsLikeIt(hit.candidate, needle))
  const best = breakTies(eligible, needle)
  const accepted =
    best !== undefined && isConfident(best, runnerUpTo(eligible, best), needle, strict)
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

/** Among matches that scored the same, the one whose name is closest in length to what
 *  was said — the only thing left to distinguish them by. */
function breakTies(ranked: Ranked[], needle: string): Ranked | undefined {
  const best = ranked[0]
  if (best === undefined) return undefined
  let winner = best
  let bestRatio = lengthRatio(needle, best.candidate.name)
  for (const hit of ranked) {
    if (hit.rank - best.rank > NEAR_TIE) break
    // Two windows of the same app are not rival answers — the ranking already put the
    // most recently used one first, and a shorter title is not a better one.
    if (sameThing(hit.candidate, best.candidate)) continue
    const ratio = lengthRatio(needle, hit.candidate.name)
    if (ratio <= bestRatio) continue
    winner = hit
    bestRatio = ratio
  }
  return winner
}

/** The next match that is a genuinely different target — "Antigravity" and "Antigravity
 *  IDE" are one thing with two Start Menu entries, not two candidates to be torn between. */
function runnerUpTo(ranked: Ranked[], best: Ranked): Ranked | undefined {
  return ranked.find((hit) => hit !== best && !sameThing(hit.candidate, best.candidate))
}

/** Whether two candidates are the same target wearing different labels — a window and its
 *  owning app is the common case ("vs code" ranks the window ahead of the app itself, and
 *  treating them as rivals made the gap rule refuse both). Prefix rather than equality, so
 *  "Antigravity" merges with "Antigravity IDE" too, with a length floor so two short names
 *  sharing three letters are not treated as the same thing. */
function sameThing(a: Candidate, b: Candidate): boolean {
  return labelsOf(a).some((one) => labelsOf(b).some((two) => sharePrefix(one, two)))
}

const SAME_PREFIX_MIN = 4

function sharePrefix(one: string, two: string): boolean {
  if (Math.min(one.length, two.length) < SAME_PREFIX_MIN) return one === two
  return one.startsWith(two) || two.startsWith(one)
}

function labelsOf(candidate: Candidate): string[] {
  return [candidate.name, candidate.context, ...candidate.aliases]
    .map((label) => depunctuate(label.toLowerCase()))
    .filter((label) => label !== '')
}

function lengthRatio(needle: string, name: string): number {
  const other = name.toLowerCase()
  return Math.min(needle.length, other.length) / Math.max(needle.length, other.length)
}

function isConfident(
  best: Ranked,
  runnerUp: Ranked | undefined,
  needle: string,
  strict: boolean
): boolean {
  // Spelling out the name word by word is the strongest signal there is, so it is also
  // what lets a bare utterance through the plausible band.
  const spelledOut = namesItWordByWord(best.candidate, needle)
  if (best.score <= CONFIDENT) return true
  if (best.score > PLAUSIBLE) return false
  if (strict && !spelledOut) return false
  return runnerUp === undefined || runnerUp.score - best.score >= DECISIVE_GAP
}

/** Whether the needle walks the candidate's words in order, allowing an initialism to
 *  stand for the words it abbreviates — what makes "vs code" reach Visual Studio Code,
 *  which shares barely a third of its letters with the phrase and scores no better than
 *  noise by Fuse alone. Matching may start at any word (a window title is mostly document
 *  name), never mid-word (which is what keeps "end" away from Calendar). */
function namesItWordByWord(candidate: Candidate, needle: string): boolean {
  const spoken = wordsOf(needle)
  if (spoken.length === 0) return false
  for (const text of [candidate.name, candidate.context]) {
    const target = wordsOf(text)
    for (let start = 0; start < target.length; start++) {
      if (walk(target, spoken, start, 0)) return true
    }
  }
  return false
}

/** Consume one spoken token at a time, as the start of the next word or as initials of
 *  the next few — recursive since a token can be either ("code" could begin "Code" or
 *  stand for an initialism). The inputs are a handful of short words, so backtracking
 *  costs nothing worth measuring. */
function walk(target: string[], spoken: string[], t: number, s: number): boolean {
  if (s === spoken.length) return true
  if (t >= target.length) return false
  const token = spoken[s]
  if (target[t].startsWith(token) && walk(target, spoken, t + 1, s + 1)) return true
  if (token.length >= 2 && t + token.length <= target.length) {
    const initials = target
      .slice(t, t + token.length)
      .map((word) => word[0])
      .join('')
    if (initials === token && walk(target, spoken, t + token.length, s + 1)) return true
  }
  return false
}

function wordsOf(text: string): string[] {
  return depunctuate(text.toLowerCase())
    .split(' ')
    .filter((word) => word !== '')
}

function soundsLikeIt(candidate: Candidate, needle: string): boolean {
  if (beginsSomething(candidate, needle)) return true
  if (namesItWordByWord(candidate, needle)) return true
  // Against the owning app as well as the title — a near-miss on the app name can never
  // clear the length test against a whole window title (measured: "visual studio con"
  // matched no open window and launched a second VS Code instead of switching to it).
  const spoken = depunctuate(needle)
  return labelsOf(candidate).some(
    (label) =>
      lengthRatio(spoken, label) >= WHOLE_NAME_RATIO &&
      similarity(spoken, label) >= NEAR_MISS_SIMILARITY
  )
}

/** 1 for identical strings, 0 for nothing in common. */
function similarity(one: string, two: string): number {
  const longest = Math.max(one.length, two.length)
  if (longest === 0) return 1
  return 1 - editDistance(one, two) / longest
}

function editDistance(one: string, two: string): number {
  let previous = Array.from({ length: two.length + 1 }, (_, column) => column)
  for (let row = 1; row <= one.length; row++) {
    const current = [row]
    for (let column = 1; column <= two.length; column++) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (one[row - 1] === two[column - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[two.length]
}

/** The needle begins the name, one of its words, or the owning app's. */
function beginsSomething(candidate: Candidate, needle: string): boolean {
  const name = candidate.name.toLowerCase()
  const context = candidate.context.toLowerCase()
  return (
    begins(name, needle) ||
    begins(context, needle) ||
    // Punctuation stripped from both sides — carries "anti-gravity" to Antigravity.
    begins(depunctuate(name), depunctuate(needle)) ||
    begins(depunctuate(context), depunctuate(needle))
  )
}

function begins(haystack: string, needle: string): boolean {
  if (needle === '' || haystack === '') return false
  return haystack.startsWith(needle) || startsAWord(haystack, needle)
}

/** Spaces are kept — they are word boundaries, and word boundaries are the whole point. */
function depunctuate(text: string): string {
  return text.replace(/[^a-z0-9 ]/g, '')
}
