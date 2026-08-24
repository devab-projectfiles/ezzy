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
function rankAll(
  text: string,
  candidates: Candidate[]
): Array<{ candidate: Candidate; rank: number }> {
  const needle = text.toLowerCase()
  return new Fuse(candidates, OPTIONS)
    .search(text)
    .map((hit) => ({ candidate: hit.item, rank: rank(hit.item, hit.score ?? 1, needle) }))
    .sort((a, b) => a.rank - b.rank || a.candidate.order - b.candidate.order)
}

/** The single best thing a spoken target names, or null when nothing plausibly matches.
 *
 *  The panel shows a list and lets the user pick; a voice command has to pick for them, so
 *  this is the same ranking with the list thrown away. Fuse's own threshold does the refusing:
 *  it returns nothing at all for a query no candidate is close to, which is what turns "switch
 *  to figma" with Figma closed into "I don't see Figma open" rather than into whatever window
 *  happened to share three letters with it.
 *
 *  §5, "always fuzzy-match, never exact-match" — whisper will hand this "sigma" for Figma and
 *  "vice code" for VS Code, and it still has to land. */
export function bestMatch(
  query: string,
  windows: EzzyWindow[],
  apps: IndexedApp[]
): Candidate | null {
  const text = query.trim()
  if (text === '') return null
  const startedAt = performance.now()
  const ranked = rankAll(text, toCandidates(windows, apps))
  since(`best match for "${text}": ${ranked[0]?.candidate.name ?? 'nothing'}`, startedAt)
  return ranked[0]?.candidate ?? null
}
