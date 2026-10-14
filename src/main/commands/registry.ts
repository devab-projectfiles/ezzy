/** The command registry. Commands are data, not `if/else` — a handler is handed the
 *  groups its own pattern captured, and the registry decides which handler that is. */

import { CommandInfo } from '../../shared/types'
import { log } from '../verbose'

export interface CommandContext {
  transcript: string
  failed(reason: string): void
}

export interface Command {
  id: string
  match: RegExp
  run: (groups: RegExpMatchArray, ctx: CommandContext) => Promise<void>
  describe: (groups: RegExpMatchArray) => string
  title: string
  summary: string
  /** The FIRST example is canonical — what a custom phrase rewrites to, so it must be a
   *  form this command's own pattern matches. */
  examples: string[]
  group: CommandGroup
  /** Whether the pattern captures free text — what makes a custom phrase possible at all. */
  takesTarget: boolean
  /** True when running it starts something playing. The music a hold paused then stays
   *  paused, instead of coming back underneath what was just asked for. */
  startsPlayback?: (groups: RegExpMatchArray) => boolean
}

export type CommandGroup = 'media' | 'windows' | 'system'

export interface CommandOutcome {
  ok: boolean
  message: string
}

const commands: Command[] = []
let phrases = new Map<string, string>()

export function register(command: Command): void {
  commands.push(command)
}

export function registeredCommands(): readonly Command[] {
  return commands
}

export function commandCatalogue(): CommandInfo[] {
  return commands.map(({ id, title, summary, examples, group }) => ({
    id,
    title,
    summary,
    examples,
    group
  }))
}

export function setCustomPhrases(map: Record<string, string[]>): void {
  const next = new Map<string, string>()
  for (const [id, list] of Object.entries(map)) {
    const command = commands.find((entry) => entry.id === id)
    if (!command) continue
    for (const phrase of list) {
      const key = normaliseTranscript(phrase)
      if (key !== '') next.set(key, command.examples[0])
    }
  }
  phrases = next
  log(`phrases: ${phrases.size} custom wordings`)
}

export function phraseProblem(phrase: string): string | null {
  const text = normaliseTranscript(phrase)
  if (text === '') return 'That is not something Ezzy can hear.'
  const taken = commands.find((command) => !command.takesTarget && command.match.test(text))
  if (taken) return `Ezzy already understands that — it means “${taken.title}”.`
  if (phrases.has(text)) return 'You have already added that phrase.'
  return null
}

export function verifyExamples(): void {
  for (const command of commands) {
    const canonical = normaliseTranscript(command.examples[0] ?? '')
    if (canonical !== '' && command.match.test(canonical)) continue
    console.error(
      `[ezzy] ${command.id}: its first example "${command.examples[0]}" is not matched by its own pattern`
    )
  }
}

export async function runCommand(text: string): Promise<CommandOutcome | null> {
  const found = commandFor(text)
  if (!found) return null
  const { command, groups, transcript } = found
  if (transcript !== text) log(`phrase: "${text}" -> "${transcript}"`)
  const outcome: { failure: string | null } = { failure: null }
  const ctx: CommandContext = {
    transcript,
    failed: (reason) => {
      outcome.failure = reason
    }
  }
  log(`command ${command.id} matched "${transcript}"`)
  try {
    await command.run(groups, ctx)
  } catch (err) {
    console.error(`[ezzy] command ${command.id} threw:`, err)
    return { ok: false, message: 'Something went wrong running that' }
  }
  if (outcome.failure !== null) return { ok: false, message: outcome.failure }
  return { ok: true, message: command.describe(groups) }
}

/** Asked before the command runs, while the music a hold paused is still paused. */
export function startsPlayback(text: string): boolean {
  const found = commandFor(text)
  return found?.command.startsPlayback?.(found.groups) ?? false
}

interface Found {
  command: Command
  groups: RegExpMatchArray
  transcript: string
}

function commandFor(text: string): Found | null {
  text = phrases.get(text) ?? text
  for (const command of commands) {
    const groups = command.match.exec(text)
    if (groups) return { command, groups, transcript: text }
  }
  return null
}

const LEADING_NOISE = /^(?:um|uh|erm|ah|so|okay|ok|now|please|hey|hi|yo)\b[\s,]*/
const ADDRESSED = /^(?:hey\s+)?(?:ezzy|easy|izzy|essie|eddy)\b[\s,]*/
const NON_SPEECH = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g

/** What whisper writes over silence — a fluent sentence from the subtitle boilerplate it
 *  was trained on, not noise. Anchored at the start; each entry is a phrase no launcher
 *  command begins with. */
const SILENCE_ARTEFACTS = [
  /^subs (?:by|created by)\b/,
  /^subtitles? (?:by|provided by)\b/,
  /^(?:thanks|thank you)(?: (?:so|very) much)? for watching\b/,
  /^(?:please )?(?:like (?:and )?)?subscribe(?: to (?:my|our|the) channel)?$/,
  /^click the bell\b/,
  /^(?:(?:you can )?(?:find|check out) )?(?:the )?links? (?:is |are )?in the description\b/,
  /^(?:for more information|more videos)\b/,
  /^amara\.org\b/,
  /^www\.[^ ]*$/,
  /^¡?gracias por ver\b/
]

export function isSilenceArtefact(text: string): boolean {
  return SILENCE_ARTEFACTS.some((pattern) => pattern.test(text))
}

export function normaliseTranscript(raw: string): string {
  let text = raw.toLowerCase().replace(NON_SPEECH, ' ')
  text = text.replace(/[“”"'’]/g, '')
  text = text.replace(/[,;!?]/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(ADDRESSED, '')
  text = text.replace(LEADING_NOISE, '').replace(LEADING_NOISE, '')
  text = text.replace(/[.,!?;:]+$/, '').trim()
  return text
}
