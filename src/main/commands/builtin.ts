/** The v1 commands, registered as data.
 *
 *  `switch to X` and `open X` do the same thing, on purpose: "switch to Spotify" with
 *  Spotify closed used to fail even though "open Spotify" would have worked a second
 *  earlier. The verbs are synonyms in the user's head, so they are synonyms here — only
 *  the confirmation differs. */

import { indexedApps } from '../app-index'
import { focusWindow } from '../focus'
import { launchApp, openDirect, resolveDirect } from '../launcher'
import { mediaIn, nextTrack, playPause, previousTrack } from '../media-keys'
import { hibernateMachine, shutDownMachine, sleepMachine } from '../power'
import { bestMatch, spokenVariants } from '../search'
import { listWindows } from '../window-tracker'
import { closeWindow } from '../win32'
import { hidePanel } from '../windows'
import { log } from '../verbose'
import { registerMediaSearchCommands } from './media-search'
import { mediaToPlayer, musicPlayerWindow, playOrPause, registerPlaybackCommands } from './playback'
import { registerSystemCommands } from './system'
import { CommandContext, register } from './registry'

/** "switch to chrome", "go back to code", "switch over to the terminal", "take me to slack". */
const SWITCH =
  /^(?:switch|switched|change|swap|go|jump|flip|move|take me|bring me|head)(?:\s+(?:over|back|me))*\s+to\s+(?:the\s+)?(.+)$/

/** "open figma", "launch spotify", "start notion", "open github.com", "play spotify".
 *
 *  `play` is here because it is also in PLAY_PAUSE: a verb that works the media keys on
 *  its own still has to reach the launcher when an app name follows it. PLAY_PAUSE is
 *  registered first and matches only a closed list of objects, so the two never overlap. */
const OPEN =
  /^(?:open|launch|start|run|play|bring up|pull up|show me|show|focus|activate)(?:\s+up)?\s+(?:the\s+)?(.+)$/

/** "close all windows", "close everything". Before CLOSE_THIS, which would otherwise read
 *  "close all windows" as "close the window". */
const CLOSE_ALL = /^(?:close|quit|kill)\s+(?:all|every)\s*(?:the\s+)?(?:windows?|thing|things)?$/

/** "close this window", "close it", "close this", "close the current window". */
const CLOSE_THIS =
  /^(?:close|quit|dismiss|kill)\s+(?:this|that|it|the|current)?\s*(?:window|app|thing)?$/

/** "close chrome", "close the outlook window". */
const CLOSE_NAMED = /^(?:close|quit|kill)\s+(?:the\s+)?(.+?)(?:\s+window)?$/

/** "play", "pause", "resume", "pause the music", "play/pause".
 *
 *  Anchored to the whole utterance with only a handful of objects allowed after the verb,
 *  so "play spotify" falls through to OPEN rather than toggling whatever is already
 *  playing — the only reason this can sit above the verbs without shadowing them.
 *
 *  "pose" is "pause" in an Ethiopian accent, and whisper writes down what it hears — this
 *  is a correct transcription of how the word is said, so the command accepts it rather
 *  than being fixed upstream (rewriting "pose" globally would break an app called that). */
const PLAY_PAUSE =
  /^(?:(play|pause|pose|resume|unpause|stop)|play\s*[/-]?\s*pause|toggle)(?:\s+(?:the|this|that))?(?:\s+(?:music|song|track|audio|video|media|playback|it))?$/

/** The verbs above that mean stop, "pose" among them, and "stop" (which reaches this the
 *  same way playback.ts's "stop spotify" does). */
const PAUSING = new Set(['pause', 'pose', 'stop'])

/** "next", "next track", "skip", "skip this song". */
const NEXT_TRACK = /^(?:next|skip|forward)(?:\s+(?:the|this|that))?(?:\s+(?:track|song|one|it))?$/

/** "previous", "previous track", "go back", "last song". "go back" only matches on its
 *  own — "go back to code" is SWITCH, which needs the "to". */
const PREVIOUS_TRACK =
  /^(?:previous|prev|back|go back|last)(?:\s+(?:the|this|that))?(?:\s+(?:track|song|one))?$/

/** A bare name, no verb in front: "chrome", "antigravity". Catches a first word the
 *  microphone clips off ("open antigravity" arriving as just "antigravity"). Capped at
 *  four words and matched strictly, since this pattern also catches whatever whisper
 *  invents out of silence. */
const BARE = /^([a-z0-9][a-z0-9 .+&'-]{1,40})$/
const BARE_MAX_WORDS = 4

/** What whisper writes over a silent room, found in use rather than imagined: a click of
 *  the mic in a quiet room came back as "The", was taken as a bare target, and opened
 *  something nobody asked for. Only bare targets are filtered — a verb vouches for the
 *  utterance being a command, so "open the" is a user and "the" alone is a microphone. */
const NOT_A_TARGET = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'at',
  'it',
  'is',
  'was',
  'i',
  'you',
  'he',
  'she',
  'we',
  'they',
  'me',
  'my',
  'your',
  'that',
  'this',
  'these',
  'there',
  'then',
  'yes',
  'no',
  'yeah',
  'nope',
  'oh',
  'ah',
  'hm',
  'hmm',
  'huh',
  'mm',
  'bye',
  'hi',
  'hello',
  // "click" resolves to the Clock app and "go" to Google Chrome ("go" begins "Google") —
  // both found by running the matcher over this machine's real index.
  'click',
  'go',
  'thanks',
  'thank you',
  'what',
  'why',
  'how',
  'when',
  'where',
  'who'
])

/** What the last play-pause did, read by `describe` right after `run` for the same command. */
let playPauseSaid = 'Play/pause'

/** Which half of the toggle a verb asks for, or null when it means either — "toggle" and
 *  "play/pause" capture no group, so an absent verb is exactly the case for a real toggle. */
function wantedHalf(verb: string | undefined): 'play' | 'pause' | null {
  if (verb === undefined) return null
  return PAUSING.has(verb) ? 'pause' : 'play'
}
/** The same, for next-track and previous-track. */
let skipTarget: string | null = null

export function registerBuiltinCommands(): void {
  // The three that cannot be undone, first: each matches a whole utterance and nothing
  // else, so they shadow nothing — the other way round, "go to sleep" was read by
  // `switch to` as a request to switch to something called "sleep".
  register({
    id: 'sleep',
    takesTarget: false,
    title: 'Sleep',
    group: 'system',
    summary: 'Puts the machine to sleep. Applications still get their usual chance to object.',
    examples: ['go to sleep', 'sleep the computer', 'suspend'],
    match:
      /^(?:sleep|go to sleep|suspend)(?:\s+the)?(?:\s+(?:pc|computer|laptop|machine|system))?$/,
    describe: () => 'Going to sleep',
    run: async (_groups, ctx) => {
      hidePanel()
      if (!sleepMachine()) ctx.failed('Windows wouldn’t go to sleep')
    }
  })

  register({
    id: 'hibernate',
    takesTarget: false,
    title: 'Hibernate',
    group: 'system',
    summary: 'Hibernates the machine rather than sleeping it.',
    examples: ['hibernate', 'hibernate the laptop'],
    match: /^hibernate(?:\s+the)?(?:\s+(?:pc|computer|laptop|machine|system))?$/,
    describe: () => 'Hibernating',
    run: async (_groups, ctx) => {
      hidePanel()
      if (!hibernateMachine()) ctx.failed('Windows wouldn’t hibernate')
    }
  })

  register({
    id: 'shut-down',
    takesTarget: false,
    title: 'Shut down',
    group: 'system',
    summary: 'Shuts Windows down.',
    examples: ['shut down', 'power off the computer', 'turn off'],
    match:
      /^(?:shut\s*down|power\s*off|turn\s*off)(?:\s+the)?(?:\s+(?:pc|computer|laptop|machine|system))?$/,
    describe: () => 'Shutting down',
    run: async (_groups, ctx) => {
      hidePanel()
      if (!(await shutDownMachine())) ctx.failed('Windows wouldn’t shut down')
    }
  })

  // The media keys, above the verbs for the same reason as the power commands. None of
  // the three can fail — Windows routes the key and never reports back — so the
  // confirmation says what Ezzy did, not what the music did.
  register({
    id: 'play-pause',
    takesTarget: false,
    title: 'Play or pause',
    group: 'media',
    summary:
      'Toggles playback. It picks who gets it: a dedicated music player if one is running, Spotify if not, and the plain media key only when neither is - which is where a browser video ends up. It says which app it reached.',
    examples: ['play music', 'pause the music', 'pause', 'stop the music', 'resume'],
    match: PLAY_PAUSE,
    describe: () => playPauseSaid,
    run: async (groups) => {
      // A dedicated player if one is running, Spotify if not, and the bare media key only
      // otherwise — see playback.ts for the full ladder.
      const player = musicPlayerWindow()
      const wanted = wantedHalf(groups[1])
      if (player && wanted !== null) {
        playPauseSaid = playOrPause(player, wanted).said
      } else if (player) {
        mediaIn(player.id, player.app, 'play-pause')
        playPauseSaid = `Play/pause ${player.app}`
      } else {
        playPause()
        playPauseSaid = wanted === null ? 'Play/pause' : wanted === 'play' ? 'Playing' : 'Pausing'
      }
      hidePanel()
    }
  })

  // Skipping picks its recipient the same way play/pause does — a "next" landing in a
  // different app than the "play" before it would be worse than either alone.
  register({
    id: 'next-track',
    takesTarget: false,
    title: 'Next track',
    group: 'media',
    summary:
      'Skips forward, using the same ladder as play or pause - so a skip can never land in a different app than the play before it.',
    examples: ['next track', 'next song', 'skip', 'skip this song'],
    match: NEXT_TRACK,
    describe: () => (skipTarget === null ? 'Next track' : `Next track on ${skipTarget}`),
    run: async () => {
      skipTarget = mediaToPlayer('next')
      if (skipTarget === null) nextTrack()
      hidePanel()
    }
  })

  register({
    id: 'previous-track',
    takesTarget: false,
    title: 'Previous track',
    group: 'media',
    summary: 'Goes back a track, using the same ladder as play or pause.',
    examples: ['previous track', 'go back', 'last song'],
    match: PREVIOUS_TRACK,
    describe: () => (skipTarget === null ? 'Previous track' : `Previous track on ${skipTarget}`),
    run: async () => {
      skipTarget = mediaToPlayer('previous')
      if (skipTarget === null) previousTrack()
      hidePanel()
    }
  })

  // Naming a service — "play spotify", "pause youtube" — before anything that could read
  // the name as an app to open or a search term. Registered after play-pause, which
  // matches only bare verbs and cannot see these.
  registerPlaybackCommands(goTo)

  // After the media keys (so "play the music" still reaches play-pause), before every
  // pattern below (so "play daft punk" is not read as an app to open). `goTo` is handed
  // over rather than imported by that file, to keep the two out of an import cycle.
  registerMediaSearchCommands(goTo)

  // `open bluetooth` has to be considered before `open` reads "bluetooth" as an app to
  // hunt for. Neither pattern here can shadow anything else, since both name what they
  // accept rather than taking `(.+)`.
  registerSystemCommands()

  register({
    id: 'switch-to',
    takesTarget: true,
    title: 'Switch to a window',
    group: 'windows',
    summary:
      'Brings a window forward. Browser windows answer to the site in their active tab, so switch to gmail finds the window showing it.',
    examples: ['switch to chrome', 'go back to code', 'take me to slack'],
    match: SWITCH,
    describe: (groups) => `Switching to ${spoken(groups[1])}`,
    run: (groups, ctx) => goTo(groups[1], ctx)
  })

  register({
    id: 'open',
    takesTarget: true,
    title: 'Open an app',
    group: 'windows',
    summary:
      'Goes to the window if it is already open, starts the application if it is not, and otherwise opens a path or a web address.',
    examples: ['open figma', 'launch spotify', 'open github.com'],
    match: OPEN,
    describe: (groups) => `Opening ${spoken(groups[1])}`,
    run: (groups, ctx) => goTo(groups[1], ctx)
  })

  register({
    id: 'close-all',
    takesTarget: false,
    title: 'Close everything',
    group: 'windows',
    summary:
      'Asks every window to close. Each one is asked rather than told, so anything with unsaved work still gets to stop you.',
    examples: ['close all windows', 'close everything'],
    match: CLOSE_ALL,
    describe: () => 'Closing every window',
    run: async (_groups, ctx) => {
      // Snapshotted before the first close, since closing a window changes the list.
      const open = listWindows()
      if (open.length === 0) {
        ctx.failed('There are no windows to close')
        return
      }
      let asked = 0
      for (const window of open) if (closeWindow(window.id)) asked++
      log(`asked ${asked} of ${open.length} windows to close`)
      if (asked === 0) {
        ctx.failed('Windows wouldn’t close any of them')
        return
      }
      hidePanel()
    }
  })

  // Before CLOSE_NAMED, which would otherwise read "close this window" as a window
  // called "this" — after CLOSE_ALL, which it would read as "close the window".
  register({
    id: 'close-this',
    takesTarget: false,
    title: 'Close this window',
    group: 'windows',
    summary: 'Closes the window in front, the same way its title bar X does.',
    examples: ['close this window', 'close it'],
    match: CLOSE_THIS,
    describe: () => 'Closing this window',
    run: async (_groups, ctx) => {
      // Ezzy's own windows are filtered out of the tracker, so this is never the panel.
      const front = listWindows()[0]
      if (!front) {
        ctx.failed('There is no window to close')
        return
      }
      close(front.id, front.title, ctx)
    }
  })

  register({
    id: 'close-named',
    takesTarget: true,
    title: 'Close a window',
    group: 'windows',
    summary: 'Closes a window you name.',
    examples: ['close chrome', 'close the outlook window'],
    match: CLOSE_NAMED,
    describe: (groups) => `Closing ${spoken(groups[1])}`,
    run: async (groups, ctx) => {
      const target = groups[1]
      const match = spokenVariants(target, false)
        .map((phrase) => bestMatch(phrase, listWindows(), []))
        .find((hit) => hit?.window)
      if (!match?.window) {
        ctx.failed(`I don't see ${spoken(target)} open`)
        return
      }
      close(match.window.id, match.window.title, ctx)
    }
  })

  // Last: every pattern with a verb in it gets first refusal.
  register({
    id: 'bare-target',
    takesTarget: true,
    title: 'A name on its own',
    group: 'windows',
    summary:
      'A name with no verb in front of it opens that thing. It is what catches a first word clipped off by the microphone, so it is deliberately strict - it refuses the words whisper invents out of a silent room.',
    examples: ['chrome', 'antigravity'],
    match: BARE,
    describe: (groups) => `Opening ${spoken(groups[1])}`,
    run: async (groups, ctx) => {
      const target = groups[1]
      if (NOT_A_TARGET.has(target)) {
        // Not "I didn't understand" — they almost certainly said nothing at all.
        log(`ignoring "${target}": whisper heard the room, not a command`)
        ctx.failed('I didn’t catch that')
        return
      }
      if (target.split(/\s+/).length > BARE_MAX_WORDS) {
        ctx.failed(`I didn't understand "${target}"`)
        return
      }
      await goTo(target, ctx, true)
    }
  })
}

/** The ladder: live window, installed app, file path, URL.
 *
 *  The two lists are searched in turn rather than ranked together — measured, a combined
 *  ranking gave "open notepad" to the app index over a window that was already open,
 *  starting a second Notepad. Opening what is already open means going to it. */
async function goTo(target: string, ctx: CommandContext, strict = false): Promise<void> {
  // The whole phrase first, then the same phrase without whatever whisper stuck on the
  // end. Each variant walks the full ladder before the next is tried.
  for (const phrase of spokenVariants(target, strict)) {
    if (await tryPhrase(phrase, ctx, strict)) return
  }
  ctx.failed(`I couldn't find ${spoken(target)}`)
}

/** One rung-by-rung attempt at one phrase. Returns false only when nothing matched — a
 *  match that then failed to open has already reported itself. */
async function tryPhrase(target: string, ctx: CommandContext, strict: boolean): Promise<boolean> {
  const open = bestMatch(target, listWindows(), [], strict)
  if (open?.window) {
    if (!focus(open.window.id)) ctx.failed(`Windows wouldn't switch to ${open.window.app}`)
    return true
  }

  const installed = bestMatch(target, [], indexedApps(), strict)
  if (installed?.app) {
    // Acted on first, dismissed second — the opposite of a clicked row, since a spoken
    // command's only feedback is the search bar, and hiding it first loses a failure.
    if (!(await launchApp(installed.app.id))) {
      ctx.failed(`${installed.app.name} wouldn't start`)
      return true
    }
    hidePanel()
    return true
  }

  // Not offered to a bare target — "documents" should not open a folder just because one
  // of that name happens to exist.
  if (!strict && resolveDirect(spokenUrl(target))) {
    if (!(await openDirect())) {
      ctx.failed(`I couldn't open ${target}`)
      return true
    }
    hidePanel()
    return true
  }

  return false
}

/** Focus, then dismiss — the search bar is the foreground window at this moment, which is
 *  what makes SetForegroundWindow legal here. */
function focus(id: number): boolean {
  const focused = focusWindow(id)
  if (focused) hidePanel()
  return focused
}

/** WM_CLOSE, posted rather than sent, so an app arguing with its user cannot hold the
 *  launcher open behind it. */
function close(id: number, title: string, ctx: CommandContext): void {
  if (!closeWindow(id)) {
    ctx.failed(`Windows wouldn't close ${title}`)
    return
  }
  hidePanel()
}

/** Display only — a message quoting the lower-cased transcript back reads as an error
 *  rather than an answer. Nothing is ever matched against this. */
function spoken(target: string): string {
  return target.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

/** "github dot com" is what dictating a URL sounds like; no app on the machine is called
 *  that, so this is safe to rewrite before the path/URL test sees it. */
function spokenUrl(target: string): string {
  return / dot /.test(target) ? target.replace(/\s+dot\s+/g, '.').replace(/\s+/g, '') : target
}
