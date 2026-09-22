/** The command registry.
 *
 *  Commands are data, not `if/else`. A handler never asks what the user said — it is
 *  handed the groups its own pattern captured, and the registry decides which handler
 *  that is. This is what makes adding a command a small file rather than a refactor.
 *
 *  This file knows nothing about voice. It takes text, from whichever source fed it —
 *  transcript or typed input, tested the same way either time. */

import { CommandInfo } from '../../shared/types'
import { log } from '../verbose'

/** What a command's `run` is given besides its own captures. Deliberately tiny — a
 *  command that needs windows or the app index imports them like any other module. */
export interface CommandContext {
  /** The normalised text this command matched, for logging and messages that quote what
   *  was actually heard. */
  transcript: string
  /** Say why the command could not do what it was asked. Calling this is what turns a run
   *  into a failure; a run that returns without calling it succeeded, and `describe` is
   *  the confirmation. */
  failed(reason: string): void
}

export interface Command {
  id: string
  /** Tested against the normalised transcript. */
  match: RegExp
  run: (groups: RegExpMatchArray, ctx: CommandContext) => Promise<void>
  /** For the spoken and visual confirmation. */
  describe: (groups: RegExpMatchArray) => string

  // ------------------------------------------------------------------ documentation
  // Required, not optional: a command nobody can discover may as well not exist. A regex
  // cannot be shown to a user, so the settings window can only list what Ezzy understands
  // if every command says so itself.

  /** What this command is called, in the settings list. */
  title: string
  /** One sentence on what it does, and on anything surprising about it. */
  summary: string
  /** Things you can actually say. The FIRST is the canonical one a custom phrase rewrites
   *  to, so it must be a form this command's own pattern matches. */
  examples: string[]
  /** Which part of the list it belongs under. */
  group: CommandGroup
  /** Whether the pattern captures free text the user supplies (an app name, a search) —
   *  what makes a custom phrase possible: a closed-vocabulary command genuinely owns the
   *  words it matches, while an open one merely matches the shape of a phrase. */
  takesTarget: boolean
}

export type CommandGroup = 'media' | 'windows' | 'system'

export interface CommandOutcome {
  ok: boolean
  /** `describe` when it worked, the reason passed to `ctx.failed` when it did not. */
  message: string
}

const commands: Command[] = []

/** A user's own wording, normalised, mapped to the canonical phrase it stands for. */
let phrases = new Map<string, string>()

export function register(command: Command): void {
  commands.push(command)
}

/** The registered set, in registration order — which is also match order. */
export function registeredCommands(): readonly Command[] {
  return commands
}

/** Every command as something that can cross IPC and be drawn. Neither the pattern nor
 *  the handler comes with it — one cannot be rendered, the other cannot be serialised. */
export function commandCatalogue(): CommandInfo[] {
  return commands.map(({ id, title, summary, examples, group }) => ({
    id,
    title,
    summary,
    examples,
    group
  }))
}

/** Adopt the user's own wordings. Rebuilt wholesale rather than merged, so removing a
 *  phrase in settings actually removes it. A phrase whose command no longer exists is
 *  dropped — the config outlives any particular set of commands.
 *
 *  Each rewrites to the command's own first example, which is why that field must be a
 *  phrasing its pattern matches — `verifyExamples` checks that it stayed one. */
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

/** Why `phrase` cannot be added, or null when it can. The one that matters is the second:
 *  a phrase some command already understands would be quietly rewritten to a different
 *  command with no way for the user to see it had happened. */
export function phraseProblem(phrase: string): string | null {
  const text = normaliseTranscript(phrase)
  if (text === '') return 'That is not something Ezzy can hear.'
  // Only a closed-vocabulary command can genuinely own a phrase — testing against all of
  // them refuses almost anything, since bare-target matches nearly any short phrase.
  const taken = commands.find((command) => !command.takesTarget && command.match.test(text))
  if (taken) return `Ezzy already understands that — it means “${taken.title}”.`
  if (phrases.has(text)) return 'You have already added that phrase.'
  return null
}

/** Every command's first example has to be matched by that command's own pattern, since
 *  it is what custom phrases rewrite to. Checked at startup and only logged — a mistake
 *  in the source, not anything a user did, and the app stays usable for every other command. */
export function verifyExamples(): void {
  for (const command of commands) {
    const canonical = normaliseTranscript(command.examples[0] ?? '')
    if (canonical !== '' && command.match.test(canonical)) continue
    console.error(
      `[ezzy] ${command.id}: its first example "${command.examples[0]}" is not matched by its own pattern`
    )
  }
}

/** Run whatever `text` names. Returns null when no command claims it, which the caller
 *  reports differently from a command that ran and failed. */
export async function runCommand(text: string): Promise<CommandOutcome | null> {
  // A user's own wording, swapped for the phrasing the patterns are written around —
  // done here rather than in normaliseTranscript since it is a preference, not a fact
  // about speech, and everything below (order, shadowing) then carries on unchanged.
  const canonical = phrases.get(text)
  if (canonical !== undefined) {
    log(`phrase: "${text}" -> "${canonical}"`)
    text = canonical
  }
  for (const command of commands) {
    const groups = command.match.exec(text)
    if (!groups) continue
    // Held on an object rather than a `let` — a closure's assignment to a local is
    // invisible to TypeScript's control flow, which would narrow the check below wrong.
    const outcome: { failure: string | null } = { failure: null }
    const ctx: CommandContext = {
      transcript: text,
      failed: (reason) => {
        outcome.failure = reason
      }
    }
    log(`command ${command.id} matched "${text}"`)
    try {
      await command.run(groups, ctx)
    } catch (err) {
      console.error(`[ezzy] command ${command.id} threw:`, err)
      return { ok: false, message: 'Something went wrong running that' }
    }
    if (outcome.failure !== null) return { ok: false, message: outcome.failure }
    return { ok: true, message: command.describe(groups) }
  }
  return null
}

/** Filler and disfluency whisper transcribes faithfully because it is genuinely there. */
const LEADING_NOISE = /^(?:um|uh|erm|ah|so|okay|ok|now|please|hey|hi|yo)\b[\s,]*/

/** What Ezzy is called, in the forms whisper is likely to produce for it. */
const ADDRESSED = /^(?:hey\s+)?(?:ezzy|easy|izzy|essie|eddy)\b[\s,]*/

/** Whisper's tags for what it heard but did not transcribe: "[BLANK_AUDIO]", "(soft
 *  music)", "*coughs*". `--suppress-nst` removes most of them; this removes the rest. */
const NON_SPEECH = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g

/** What whisper writes when it is given a room instead of a sentence. It never returns
 *  nothing — handed silence or a cough it produces a fluent, confidently punctuated
 *  sentence, and the sentences are the boilerplate from the subtitle tracks it was
 *  trained on ("Subs by www.zeoranger.co.uk", "Thanks for watching!").
 *
 *  The real defence is the signal test in the recorder, which never sends a silent
 *  recording at all. This is the second line, for a chair or a door loud enough to pass
 *  for speech — without it, `bare-target` reads the invention as a name and answers with
 *  a report about something the user never said.
 *
 *  Anchored at the start, and each entry is a phrase no launcher command begins with —
 *  the cost of a wrong entry is a command that cannot be given, so this stays short and
 *  literal rather than a fuzzy match. */
const SILENCE_ARTEFACTS = [
  /^subs (?:by|created by)\b/,
  /^subtitles? (?:by|provided by)\b/,
  /^(?:thanks|thank you)(?: (?:so|very) much)? for watching\b/,
  /^(?:please )?(?:like (?:and )?)?subscribe(?: to (?:my|our|the) channel)?$/,
  /^click the bell\b/,
  /^(?:for more information|more videos)\b/,
  /^amara\.org\b/,
  /^www\.[^ ]*$/,
  /^¡?gracias por ver\b/
]

export function isSilenceArtefact(text: string): boolean {
  return SILENCE_ARTEFACTS.some((pattern) => pattern.test(text))
}

/** Reduce a raw transcript to the text the patterns are written against. Pure and
 *  exported, so it is testable without a microphone alongside command matching and
 *  fuzzy resolution. */
export function normaliseTranscript(raw: string): string {
  let text = raw.toLowerCase().replace(NON_SPEECH, ' ')
  // Curly quotes and apostrophes come back from whisper as typed punctuation.
  text = text.replace(/[“”"'’]/g, '')
  // Interior punctuation whisper adds to a two-word utterance ("Chrome, Ooby") — a comma
  // is never part of anything anyone opens, and leaving it in stops bare-name matching.
  // Dots survive, since "github.com" needs one.
  text = text.replace(/[,;!?]/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(ADDRESSED, '')
  // Twice: "um, okay, switch to chrome" is one utterance people actually produce.
  text = text.replace(LEADING_NOISE, '').replace(LEADING_NOISE, '')
  // Trailing punctuation only — an interior full stop is part of "github.com".
  text = text.replace(/[.,!?;:]+$/, '').trim()
  return text
}
