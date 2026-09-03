/** Fuzzy matching over the window list and the app index.
 *
 *  The plan asks for "Fuse.js over `[...windows,...apps]`, windows weighted higher", and the two
 *  halves of that sentence pull in different directions: one index is what makes the
 *  weighting mean anything (a window and an app can only be ranked against each other if
 *  they were scored together), but the panel has two fixed sections. So both happen — one
 *  search over the combined set, then the ranked results split back into their sections,
 *  each keeping the order the combined ranking gave it.
 *
 *  This runs in the main process rather than the panel. The query starts in the search-bar
 *  window and the results are drawn in the panel window, so it has to cross to main either
 *  way; doing the work here costs no extra hop and keeps both lists in one place.
 *
 *  A window is indexed under its
 *  title *and* its owning app, so `index.ts — Visual Studio Code` answers to "index" and to
 *  "code". It does not answer to "typescript" — that would need a synonym table, which is
 *  not something the plan asks for. */

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

/** Windows are weighted higher. Applied to the score rather than as a Fuse key weight,
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

/** A whole-name near-miss, for the case word-start cannot see: the "sigma" for Figma, where
 *  the substitution is in the first syllable.
 *
 *  Two tests, because one of them was not enough. The strings have to be the same *shape* — a
 *  length ratio of at least this — and they have to be the same *sound in the same order*,
 *  which is what edit distance measures and what Fuse's score does not.
 *
 *  That second test exists because of a real miss: "open codex" came back from whisper as
 *  "cordix", which shares six letters with Discord, scores 0.439 against it and has a length
 *  ratio of 0.86 — so Ezzy opened Discord. Reordered letters are cheap for a bitap search and
 *  expensive for edit distance, and that is exactly the difference between the two cases:
 *  measured over this machine's index, every near-miss worth taking scores 0.667 or better
 *  (sigma/Figma 0.800, rise/Rize 0.750, anti-granting/Antigravity 0.667) and every one worth
 *  refusing scores 0.615 or worse (batterys port/BatteryBar 0.615, view as code/Visual Studio
 *  Code 0.444, cordix/Discord 0.286). */
const WHOLE_NAME_RATIO = 0.8
const NEAR_MISS_SIMILARITY = 0.65

/** Two ranks this close are a tie, and a tie is decided by which name is closest in length to
 *  what was said. Measured: "rise" scores 0.354 against both OneDrive and Rize, and without
 *  this the alphabetically earlier one won — "open rize" opened nothing while OneDrive sat at
 *  the top of the ranking being rejected. */
const NEAR_TIE = 0.05

/** How many trailing words may be thrown away when the whole phrase matches nothing.
 *
 *  Whisper appends things. Measured on this machine: "switch to visual studio code" came back
 *  as "switch to visual studio code ciao with", and a command that was understood perfectly
 *  well failed on two words of invention stuck to the end of it. People do it too — "open
 *  notepad please", "switch to chrome real quick".
 *
 *  Two words, no more. It is a cap rather than a threshold: dropping words until something
 *  matches would eventually find a match for anything, and "click the bell to see more of the
 *  video" must not end up opening whatever is closest to "click". */
const MAX_TRAILING_JUNK = 2

/** The phrase to match, then the same phrase without its last word or two.
 *
 *  Only offered when a verb vouched for the utterance. A bare name has nothing to trim: it is
 *  already just a name, and shortening it would be guessing twice over. */
export function spokenVariants(target: string, strict: boolean): string[] {
  const words = target
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  if (strict || words.length <= 1) return [target]
  const variants = [target]
  for (let drop = 1; drop <= MAX_TRAILING_JUNK && words.length - drop >= 1; drop++) {
    const shorter = words.slice(0, words.length - drop)
    // Nothing is named after a preposition. Measured: "the end" — which is what whisper makes
    // of a room with nobody talking in it — trimmed down to "the", and "the" begins the name
    // of an app on this machine. A remnant that is all grammar and no name is not a target.
    if (shorter.every((word) => FUNCTION_WORDS.has(word))) continue
    variants.push(shorter.join(' '))
  }
  return variants
}

/** The words a trailing trim can strand on its own. Not a general stop list — these are only
 *  ever consulted about what is *left over*, never about the phrase the user actually said. */
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
 *  The panel shows a list and lets the user pick, so a mediocre match there costs nothing and
 *  none of this applies to it. A voice command has to pick for the user, and picking wrong is
 *  worse than refusing — Fuse's threshold alone returns Calculator for "crawl", Calendar for
 *  "end" (caL-END-ar contains it exactly, scoring 0.006) and BatteryBar for "batterys port",
 *  every one of which means the wrong application starting.
 *
 *  So a spoken match has to be a match to something the user could plausibly have *said*: it
 *  begins the name or one of its words, or it spells the name out word by word with
 *  initialisms allowed, or it is the whole name with a syllable misheard. Evaluated by running
 *  this function over this machine's real index — 23 things a user would ask for and 15 things
 *  whisper invents out of silence, including four collected from its attempts at "VS Code":
 *  every invention refused, every real target reached but a bare "vs" on its own.
 *
 *  Always fuzzy-match, never exact-match — whisper hands this "sigma" for Figma and
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
  const needle = text.toLowerCase()
  const ranked = rankAll(text, toCandidates(windows, apps))
  // Everything the user could plausibly have been saying, in ranked order. Filtering before
  // choosing rather than gating the winner afterwards is what lets the ranking fall through:
  // "cordix" ranks Discord first and Codex second, and Discord is not something anyone says
  // "cordix" for. Refusing at that point would throw away the answer sitting behind it.
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

/** Among matches that scored the same, the one whose name is the same length as what was
 *  said. Two candidates can only be distinguished by the sound of them at this point, and a
 *  four-letter word is far likelier to have been a four-letter app than half of a longer one. */
function breakTies(ranked: Ranked[], needle: string): Ranked | undefined {
  const best = ranked[0]
  if (best === undefined) return undefined
  let winner = best
  let bestRatio = lengthRatio(needle, best.candidate.name)
  for (const hit of ranked) {
    if (hit.rank - best.rank > NEAR_TIE) break
    // Two windows of the same application are not rival answers, and this rule has nothing
    // useful to say about them: the ranking has already put the most recently used one first,
    // and between "*Journa.md - Notepad" and "Untitled - Notepad" a shorter title is not a
    // better answer — it is just a shorter title. Measured: without this, "notepad" left the
    // Notepad the user had been in for the one they had not touched.
    if (sameThing(hit.candidate, best.candidate)) continue
    const ratio = lengthRatio(needle, hit.candidate.name)
    if (ratio <= bestRatio) continue
    winner = hit
    bestRatio = ratio
  }
  return winner
}

/** The next match that is a genuinely different target.
 *
 *  "Antigravity" and "Antigravity IDE" are one thing with two Start Menu entries, and treating
 *  the second as a rival made the gap rule refuse both: measured, "anti-granting" scored 0.488
 *  and 0.603 against them, a gap of 0.115 against a threshold of 0.12. Nobody was ambiguous
 *  about anything. */
function runnerUpTo(ranked: Ranked[], best: Ranked): Ranked | undefined {
  return ranked.find((hit) => hit !== best && !sameThing(hit.candidate, best.candidate))
}

/** Whether two candidates are the same target wearing different labels.
 *
 *  A window and the app that owns it are the obvious case, and it is not a small one: "vs
 *  code" ranks the open Visual Studio Code *window* first at 0.599 and the Visual Studio Code
 *  *app* second at 0.582 — a runner-up that scores better than the winner, so the gap rule
 *  refused both. They were never two answers. The window's owning app is compared as well as
 *  its title for exactly that.
 *
 *  Prefix rather than equality, so "Antigravity" and "Antigravity IDE" merge too, with a floor
 *  on the length: two short names sharing three letters are not the same application. */
function sameThing(a: Candidate, b: Candidate): boolean {
  return labelsOf(a).some((one) => labelsOf(b).some((two) => sharePrefix(one, two)))
}

const SAME_PREFIX_MIN = 4

function sharePrefix(one: string, two: string): boolean {
  if (Math.min(one.length, two.length) < SAME_PREFIX_MIN) return one === two
  return one.startsWith(two) || two.startsWith(one)
}

function labelsOf(candidate: Candidate): string[] {
  return [candidate.name, candidate.context]
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
  // Spelling out the name word by word is the strongest signal there is — far stronger than
  // any score — so it is also what lets a bare utterance through the plausible band. Nothing
  // whisper invents out of silence lines up with an application's words in order.
  const spelledOut = namesItWordByWord(best.candidate, needle)
  if (best.score <= CONFIDENT) return true
  if (best.score > PLAUSIBLE) return false
  if (strict && !spelledOut) return false
  return runnerUp === undefined || runnerUp.score - best.score >= DECISIVE_GAP
}

/** Whether the needle is something the user could have been saying when they named this
 *  candidate — as opposed to a string that merely shares letters with it. */
/** Whether the needle walks the candidate's words in order, allowing an initialism to stand
 *  for the words it abbreviates.
 *
 *  This is what makes "vs code" reach Visual Studio Code, which the plan asks for by name and which
 *  nothing else here could do: "vs" is not a prefix of anything, the strings share barely a
 *  third of their letters, and Fuse scores the pair 0.599 — indistinguishable by score alone
 *  from a word that means nothing at all. What separates them is structure. "vs" spells the
 *  initials of Visual Studio and "code" is the word that follows, in that order.
 *
 *  Matching may start at any word of the candidate, because a window title is mostly document
 *  name: `index.ts — Visual Studio Code` has to answer to "vs code" too. It may not start
 *  mid-word, which is what keeps "end" away from Calendar. */
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

/** Consume one spoken token at a time: either as the start of the next word, or as the
 *  initials of the next few. Recursive because a token can be both and only one way leads on —
 *  "code" could begin "Code" or stand for "Chrome OS Desktop Edition". The inputs are a
 *  handful of short words, so the backtracking costs nothing worth measuring. */
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
  // Against the owning application as well as the title. A window is mostly named after the
  // document in it, so a near-miss on the *app* name can never clear the length test against
  // the whole title: measured, whisper clipped "visual studio code" to "visual studio con",
  // no open window matched it, and the command launched a second copy of VS Code instead of
  // going to the one already on screen.
  const spoken = depunctuate(needle)
  return labelsOf(candidate).some(
    (label) =>
      lengthRatio(spoken, label) >= WHOLE_NAME_RATIO &&
      similarity(spoken, label) >= NEAR_MISS_SIMILARITY
  )
}

/** 1 for identical strings, 0 for nothing in common. Levenshtein over two short words, which
 *  is a handful of microseconds and is only ever asked about candidates Fuse already returned. */
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
