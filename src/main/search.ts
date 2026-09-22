/** Fuzzy matching over the window list and the app index. One combined Fuse index, split
 *  back into the panel's two sections afterwards so windows and apps can be ranked
 *  against each other. Runs in the main process, where both lists already live. */

import Fuse, { type IFuseOptions } from 'fuse.js'
import { EzzyApp, EzzyWindow, MAX_APP_ROWS } from '../shared/types'
import { IndexedApp, toEzzyApp } from './app-index'
import { since } from './verbose'

export interface Candidate {
  kind: 'window' | 'app'
  name: string
  context: string
  order: number
  aliases: string[]
  window?: EzzyWindow
  app?: IndexedApp
}

const OPTIONS: IFuseOptions<Candidate> = {
  includeScore: true,
  ignoreLocation: true,
  threshold: 0.4,
  keys: [
    { name: 'name', weight: 0.75 },
    { name: 'aliases', weight: 0.75 },
    { name: 'context', weight: 0.25 }
  ]
}

const WINDOW_FAVOUR = 0.55
const PREFIX_FAVOUR = 0.3
const WORD_START_FAVOUR = 0.6

export interface SearchResult {
  windows: EzzyWindow[]
  apps: EzzyApp[]
}

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
  let value = Math.max(score, 0.001)
  const name = candidate.name.toLowerCase()
  if (name.startsWith(needle)) value *= PREFIX_FAVOUR
  else if (startsAWord(name, needle) || startsAWord(candidate.context.toLowerCase(), needle)) {
    value *= WORD_START_FAVOUR
  }
  if (candidate.kind === 'window') value *= WINDOW_FAVOUR
  return value
}

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
  score: number
  rank: number
}

const CONFIDENT = 0.45
const PLAUSIBLE = 0.7
const DECISIVE_GAP = 0.12
const WHOLE_NAME_RATIO = 0.8
const NEAR_MISS_SIMILARITY = 0.65
const NEAR_TIE = 0.05
const MAX_TRAILING_JUNK = 2

export function spokenVariants(target: string, strict: boolean): string[] {
  const words = target
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  if (strict || words.length <= 1) return [target]
  const variants = [target]
  for (let drop = 1; drop <= MAX_TRAILING_JUNK && words.length - drop >= 1; drop++) {
    const shorter = words.slice(0, words.length - drop)
    if (shorter.every((word) => FUNCTION_WORDS.has(word))) continue
    variants.push(shorter.join(' '))
  }
  return variants
}

const FUNCTION_WORDS = new Set(
  (
    'a an and are as at be been but by did do does for from had has have he her here his how i ' +
    'in is it its me my no not now of ok okay on or our please she so than thank thanks that ' +
    'the their then there these they this those to up us was we were what when where which who ' +
    'why will with yeah yes you your'
  ).split(' ')
)

/** The single best thing a spoken target names, or null when nothing matches well enough
 *  — a wrong pick is worse than refusing, so a match must be something the user could
 *  plausibly have said: it begins the name, spells it out word by word (initialisms
 *  allowed), or is the whole name with a syllable misheard. `strict` drops the plausible
 *  band, for the bare-target fallback where no verb vouches for the utterance at all. */
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

function breakTies(ranked: Ranked[], needle: string): Ranked | undefined {
  const best = ranked[0]
  if (best === undefined) return undefined
  let winner = best
  let bestRatio = lengthRatio(needle, best.candidate.name)
  for (const hit of ranked) {
    if (hit.rank - best.rank > NEAR_TIE) break
    if (sameThing(hit.candidate, best.candidate)) continue
    const ratio = lengthRatio(needle, hit.candidate.name)
    if (ratio <= bestRatio) continue
    winner = hit
    bestRatio = ratio
  }
  return winner
}

function runnerUpTo(ranked: Ranked[], best: Ranked): Ranked | undefined {
  return ranked.find((hit) => hit !== best && !sameThing(hit.candidate, best.candidate))
}

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
  const spelledOut = namesItWordByWord(best.candidate, needle)
  if (best.score <= CONFIDENT) return true
  if (best.score > PLAUSIBLE) return false
  if (strict && !spelledOut) return false
  return runnerUp === undefined || runnerUp.score - best.score >= DECISIVE_GAP
}

/** Whether the needle walks the candidate's words in order, allowing an initialism to
 *  stand for the words it abbreviates — what makes "vs code" reach Visual Studio Code. */
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
  const spoken = depunctuate(needle)
  return labelsOf(candidate).some(
    (label) =>
      lengthRatio(spoken, label) >= WHOLE_NAME_RATIO &&
      similarity(spoken, label) >= NEAR_MISS_SIMILARITY
  )
}

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

function beginsSomething(candidate: Candidate, needle: string): boolean {
  const name = candidate.name.toLowerCase()
  const context = candidate.context.toLowerCase()
  return (
    begins(name, needle) ||
    begins(context, needle) ||
    begins(depunctuate(name), depunctuate(needle)) ||
    begins(depunctuate(context), depunctuate(needle))
  )
}

function begins(haystack: string, needle: string): boolean {
  if (needle === '' || haystack === '') return false
  return haystack.startsWith(needle) || startsAWord(haystack, needle)
}

function depunctuate(text: string): string {
  return text.replace(/[^a-z0-9 ]/g, '')
}
