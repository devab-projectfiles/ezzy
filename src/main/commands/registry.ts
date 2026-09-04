/** The command registry.
 *
 *  Commands are **data, not `if/else`**. A handler never asks what the user said — it is
 *  handed the groups its own pattern captured, and the registry is what decides which handler
 *  that is. It is the single most important structural decision in the app: it is what
 *  makes adding a command a small file rather than a refactor.
 *
 *  This file knows nothing about voice. It takes text, which is what the plan asks for — "tested
 *  against transcript or typed input" — and chunk D only feeds it the one source. */

import { log } from '../verbose'

/** What a command's `run` is given besides its own captures. Deliberately tiny: a command
 *  that needs windows or the app index imports them, the same as any other module. */
export interface CommandContext {
  /** The normalised text this command matched, for logging and for messages that want to
   *  quote what was actually heard. */
  transcript: string
  /** Say why the command could not do what it was asked — "I don't see Figma open". Calling
   *  this is what turns a run into a failure; a run that returns without calling it succeeded,
   *  and `describe` is the confirmation. */
  failed(reason: string): void
}

export interface Command {
  id: string
  /** Tested against the normalised transcript. */
  match: RegExp
  run: (groups: RegExpMatchArray, ctx: CommandContext) => Promise<void>
  /** For the spoken and visual confirmation. */
  describe: (groups: RegExpMatchArray) => string
}

export interface CommandOutcome {
  ok: boolean
  /** What happened, in the words the user should hear: `describe` when it worked, the
   *  reason passed to `ctx.failed` when it did not. */
  message: string
}

const commands: Command[] = []

export function register(command: Command): void {
  commands.push(command)
}

/** The registered set, in registration order — which is also match order. */
export function registeredCommands(): readonly Command[] {
  return commands
}

/** Run whatever `text` names. Returns null when no command claims it, which the caller
 *  reports differently from a command that ran and failed: "I don't know how to do that" is
 *  not the same answer as "I don't see Figma open". */
export async function runCommand(text: string): Promise<CommandOutcome | null> {
  for (const command of commands) {
    const groups = command.match.exec(text)
    if (!groups) continue
    // Held on an object rather than in a `let`: a closure's assignment to a local is invisible
    // to TypeScript's control flow, which would narrow the check below to "always null".
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

/** What Ezzy is called, in the forms whisper is likely to produce for it. Addressing the app
 *  by name is natural enough that people do it whether or not they are told to. */
const ADDRESSED = /^(?:hey\s+)?(?:ezzy|easy|izzy|essie|eddy)\b[\s,]*/

/** Whisper's tags for what it heard but did not transcribe: "[BLANK_AUDIO]", "(soft music)",
 *  "*coughs*". `--suppress-nst` removes most of them; this removes the rest. */
const NON_SPEECH = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g

/** What whisper writes when it is given a room instead of a sentence.
 *
 *  It never returns nothing. Handed silence or a cough it produces a fluent, confidently
 *  punctuated sentence, and the sentences are not random — they are the boilerplate from the
 *  subtitle tracks it was trained on. "Subs by www.zeoranger.co.uk" and "Thanks for watching!"
 *  are the two this machine produces most.
 *
 *  The real defence is the signal test in the recorder, which never sends a silent recording
 *  at all. This is the second line, for the case where a chair or a door was loud enough to
 *  pass for speech: without it, `bare-target` reads the invention as a name and answers with
 *  "I couldn't find Subs By Www.zeoranger.co.uk", which is a report about something the user
 *  never said.
 *
 *  Anchored at the start, and every entry is a phrase no launcher command begins with. The
 *  cost of a wrong entry here is a command that cannot be given, so the list stays short and
 *  stays literal rather than growing a fuzzy match.
 *
 *  Pure and exported for the same reason as `normaliseTranscript`: it is a rule about text,
 *  and it belongs in the layer that can be tested without a microphone. */
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

/** Reduce a raw transcript to the text the patterns are written against.
 *
 *  Pure and exported on purpose — the plan puts transcript normalisation in the layer that is
 *  actually testable, alongside command matching and fuzzy resolution. */
export function normaliseTranscript(raw: string): string {
  let text = raw.toLowerCase().replace(NON_SPEECH, ' ')
  // Curly quotes and apostrophes come back from whisper as typed punctuation.
  text = text.replace(/[“”"'’]/g, '')
  // Interior punctuation whisper adds to a two-word utterance: "Chrome, Ooby" for one word it
  // could not place. A comma is never part of anything anyone is trying to open, and leaving
  // it in stops the bare-name pattern matching at all. Dots survive — "github.com" needs one.
  text = text.replace(/[,;!?]/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(ADDRESSED, '')
  // Twice: "um, okay, switch to chrome" is one utterance people actually produce.
  text = text.replace(LEADING_NOISE, '').replace(LEADING_NOISE, '')
  // Trailing punctuation only. An interior full stop is part of "github.com".
  text = text.replace(/[.,!?;:]+$/, '').trim()
  return text
}
