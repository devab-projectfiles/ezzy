/** The v1 commands, registered as data.
 *
 *  the `pause/play`, `next` and `previous` arrived with chunk E, which is where the plan puts the
 *  `VK_MEDIA_*` codes they need. They are the shape the plan promised: a pattern, one call, and a
 *  sentence to say afterwards.
 *
 *  `close X`, `close all windows` and the three power commands are not in the list at all.
 *  They were asked for after chunk D shipped, and they are exactly the shape the plan predicted: a
 *  pattern, a resolver and twenty lines.
 *
 *  **`switch to X` and `open X` do the same thing**, on purpose. The plan gives `open X` the ladder
 *  — live window, installed app, file path, URL — and stops `switch to X` at the first rung,
 *  which is defensible right up until someone says "switch to Spotify" with Spotify closed and
 *  is told it is not open, having watched "open Spotify" work a second earlier. The verbs are
 *  synonyms in the user's head, so they are synonyms here; only the confirmation differs. */

import { indexedApps } from '../app-index'
import { focusWindow } from '../focus'
import { launchApp, openDirect, resolveDirect } from '../launcher'
import { nextTrack, playPause, previousTrack } from '../media-keys'
import { hibernateMachine, shutDownMachine, sleepMachine } from '../power'
import { bestMatch, spokenVariants } from '../search'
import { listWindows } from '../window-tracker'
import { closeWindow } from '../win32'
import { hidePanel } from '../windows'
import { log } from '../verbose'
import { registerMediaSearchCommands } from './media-search'
import { mediaToPlayer, registerPlaybackCommands } from './playback'
import { registerSystemCommands } from './system'
import { CommandContext, register } from './registry'

/** "switch to chrome", "go back to code", "switch over to the terminal", "take me to slack".
 *  The optional words are the ones people actually say around the verb. */
const SWITCH =
  /^(?:switch|switched|change|swap|go|jump|flip|move|take me|bring me|head)(?:\s+(?:over|back|me))*\s+to\s+(?:the\s+)?(.+)$/

/** "open figma", "launch spotify", "start notion", "open github.com", "play spotify".
 *
 *  `play` is in this list because it is also in PLAY_PAUSE: a verb that works the media keys
 *  when it is said on its own still has to reach the launcher when an app name follows it, or
 *  adding the media commands would have quietly taken "play spotify" away. PLAY_PAUSE is
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
 *  Anchored to the whole utterance and allowing only a handful of objects after the verb, so
 *  that "play spotify" and "start notion" fall through to OPEN rather than being answered by
 *  toggling whatever happens to be playing. That is the only reason these can sit above the
 *  verbs without shadowing them.
 *
 *  **"pose" is "pause".** Spoken in an Ethiopian accent the two are the same word, and whisper
 *  writes down the one it hears — so "pose the music" arrived, matched nothing, and was
 *  answered with "I didn't understand". This is not a mis-transcription to be corrected
 *  upstream: it is a correct transcription of how the word is said here, and the command is
 *  what has to accept it. Nothing on a Start Menu is called Pose, so the alternative costs
 *  nothing. It is the one word normalisation could not fix either — rewriting "pose" globally
 *  would break the day someone installs an app by that name. */
const PLAY_PAUSE =
  /^(?:(play|pause|pose|resume|unpause|stop)|play\s*[/-]?\s*pause|toggle)(?:\s+(?:the|this|that))?(?:\s+(?:music|song|track|audio|video|media|playback|it))?$/

/** The verbs above that mean stop, "pose" among them.
 *
 *  "stop" is here because it was missing and nothing said so: "stop the music" matched no
 *  media command, fell all the way through to `bare-target`, and was answered with "I couldn't
 *  find Stop The Music". It is the same word `playback.ts` already accepts in "stop spotify",
 *  so the two halves of stopping now agree. */
const PAUSING = new Set(['pause', 'pose', 'stop'])

/** "next", "next track", "skip", "skip this song". */
const NEXT_TRACK = /^(?:next|skip|forward)(?:\s+(?:the|this|that))?(?:\s+(?:track|song|one|it))?$/

/** "previous", "previous track", "go back", "last song". "go back" only matches on its own —
 *  "go back to code" is SWITCH, which needs the "to". */
const PREVIOUS_TRACK =
  /^(?:previous|prev|back|go back|last)(?:\s+(?:the|this|that))?(?:\s+(?:track|song|one))?$/

/** A bare name, with no verb in front of it: "chrome", "antigravity".
 *
 *  This is what stops a clipped first word from becoming a dead end. The microphone takes a
 *  moment to open, people start talking before it does, and "open antigravity" arrives as
 *  "antigravity" — which used to be answered with "I don't know how to antigravity" even
 *  though the app was sitting right there in the index.
 *
 *  Capped at four words and matched strictly (see `bestMatch`), because this pattern also
 *  catches everything whisper invents out of silence, and a hallucinated sentence must not
 *  launch anything. */
const BARE = /^([a-z0-9][a-z0-9 .+&'-]{1,40})$/
const BARE_MAX_WORDS = 4

/** What whisper writes when it is given a room rather than a sentence.
 *
 *  Whisper invents confident text out of silence, and the empty-transcript check
 *  catches the obvious half of that. This is the other half, found in use: a click of the mic
 *  in a quiet room came back as "The", `bare-target` took it as a name, fuzzy matching found
 *  something close enough, and Ezzy opened an app nobody asked for. Twice.
 *
 *  Only bare targets are filtered, and only these words. A verb vouches for an utterance being
 *  a command — "open the" is a user, "the" on its own is a microphone. Nothing on a Start Menu
 *  is called any of these, so refusing them costs nothing and stops the one failure that acts
 *  on its own rather than reporting itself. */
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
  // Two words that are not names, found by running the matcher over this machine's real index
  // rather than by imagining them. A bare "click" resolves to the Clock app, and a bare "go"
  // resolves to Google Chrome because "go" begins "Google" — both would have opened something
  // from a press with nothing said into it. "click" is the word left over when whisper only
  // gets the first of "Click the bell to see more of the video" out; `isSilenceArtefact`
  // catches that sentence whole, and this catches the fragment.
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

/** Which player the last `play-pause` was addressed to, so the confirmation can name it. Read
 *  by `describe` immediately after the same command's `run`, one command at a time — the same
 *  arrangement, and the same reasoning, as `lastRun` in media-search.ts. */
let playPauseTarget: string | null = null
/** The same, for `next-track` and `previous-track`. */
let skipTarget: string | null = null

export function registerBuiltinCommands(): void {
  // The three that cannot be undone, first in the list. Each matches a whole utterance and
  // nothing else, so they shadow nothing — while the other way round, "go to sleep" was being
  // read by `switch to` as a request to switch to something called "sleep".
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

  // The media keys, above the verbs for the same reason as the power commands: each matches a
  // whole utterance and nothing else, so they shadow nothing, while "next" left to fall
  // through would be read by `bare-target` as an app called Next.
  //
  // None of the three can fail. `keybd_event` returns nothing, Windows routes the key to
  // whichever app owns the current media session, and Ezzy is never told what happened to it —
  // so the confirmation says what Ezzy did, not what the music did.
  register({
    id: 'play-pause',
    takesTarget: false,
    title: 'Play or pause',
    group: 'media',
    summary:
      'Toggles playback. It picks who gets it: a dedicated music player if one is running, Spotify if not, and the plain media key only when neither is - which is where a browser video ends up. It says which app it reached.',
    examples: ['play music', 'pause the music', 'pause', 'stop the music', 'resume'],
    match: PLAY_PAUSE,
    // One key toggles both, so the verb the user chose is the only evidence of which one they
    // meant. Echoing it back is honest — Ezzy genuinely does not know whether anything was
    // playing — and it reads as an answer rather than as a shrug.
    //
    // The player IS named when there is one, and that is not decoration: the whole complaint
    // this addresses was that the command reached the wrong application, so which one it
    // reached is the useful half of the answer.
    describe: (groups) => {
      const verb = PAUSING.has(groups[1]) ? 'Pausing' : groups[1] ? 'Playing' : 'Play/pause'
      return playPauseTarget === null ? verb : `${verb} ${playPauseTarget}`
    },
    run: async () => {
      // A dedicated player if one is running, Spotify if not, and the bare media key only when
      // neither is — which is where a browser video is picked up, and the only case in which
      // Windows' own routing is still the right answer. See playback.ts.
      playPauseTarget = mediaToPlayer('play-pause')
      if (playPauseTarget === null) playPause()
      hidePanel()
    }
  })

  // Skipping picks its recipient exactly the way play/pause does, and it has to: a "next" that
  // went to a different application than the "play" a moment earlier would be worse than
  // either behaviour on its own. Say "next song on youtube" to override the choice.
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

  // Naming a service — "play spotify", "pause youtube" — before anything that could read the
  // name as something to search for or launch. `spotify-play` below would take "play spotify"
  // as an app to open, which is what it used to mean and is no longer what is wanted while
  // Spotify is already running; `spotify-search` would take "play the music on spotify" as a
  // search for a band called Music. Both are cases of the registry having no fall-through:
  // whoever matches first owns the utterance, so the more specific pattern has to be first.
  //
  // After `play-pause`, which matches only bare verbs and cannot see these.
  registerPlaybackCommands(goTo)

  // FEATURE-media-search.md's two commands go HERE, and the position is the whole of their
  // integration. After the media keys, so "play", "play the music" and "play pause" still
  // reach `play-pause` rather than searching Spotify for them. Before every pattern below,
  // because "play daft punk" would otherwise be read by `open` as an app called Daft Punk —
  // and if it somehow got past that, by `bare-target` as one.
  //
  // `goTo` is handed over rather than imported by that file, which keeps the two out of an
  // import cycle: "play spotify" still has to launch Spotify, and this is the ladder that
  // knows how (see the note on OPEN above).
  registerMediaSearchCommands(goTo)

  // FEATURE-system-commands.md, and it sits here for the same reason: `open bluetooth` has to
  // be considered before `open` reads "bluetooth" as an app to hunt for, and `connect to home`
  // before `bare-target` reads the whole phrase as one. Neither can shadow anything, because
  // both patterns name what they accept rather than taking `(.+)`.
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
      // Snapshotted before the first close, because closing a window changes the list.
      const open = listWindows()
      if (open.length === 0) {
        ctx.failed('There are no windows to close')
        return
      }
      // Every one of them is asked, not told: an app with unsaved work still gets to put its
      // dialog up, and if it refuses, it stays. Ezzy's own windows are not in this list.
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

  // Before CLOSE_NAMED, which would otherwise read "close this window" as a window called
  // "this" — and after CLOSE_ALL, which it would read as "close the window".
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
      // The front-most real window. Ezzy's own windows are filtered out of the tracker, so
      // this is never the panel the user is looking at.
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
        // Not "I didn't understand", which suggests the user said something Ezzy cannot do.
        // They almost certainly said nothing at all.
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

/** the ladder: live window, installed app, file path, URL.
 *
 *  The two lists are searched in turn rather than ranked together, and that order is load
 *  bearing: measured, one combined ranking gave "open notepad" to the app index — an exact
 *  name match outscores a window whose title only mentions it — and started a second Notepad
 *  beside the one already open. Opening what is already open means going to it. */
async function goTo(target: string, ctx: CommandContext, strict = false): Promise<void> {
  // The whole phrase first, then the same phrase without whatever whisper stuck on the end of
  // it. Each variant walks the full ladder before the next is tried, so a complete phrase that
  // names an app still beats a trimmed one that half-names a window.
  for (const phrase of spokenVariants(target, strict)) {
    if (await tryPhrase(phrase, ctx, strict)) return
  }
  ctx.failed(`I couldn't find ${spoken(target)}`)
}

/** One rung-by-rung attempt at one phrase. Returns false when nothing matched, which is the
 *  only case the caller retries — a match that then failed to open has already been reported. */
async function tryPhrase(target: string, ctx: CommandContext, strict: boolean): Promise<boolean> {
  const open = bestMatch(target, listWindows(), [], strict)
  if (open?.window) {
    if (!focus(open.window.id)) ctx.failed(`Windows wouldn't switch to ${open.window.app}`)
    return true
  }

  const installed = bestMatch(target, [], indexedApps(), strict)
  if (installed?.app) {
    // Acted on first and dismissed second, the opposite way round from a clicked row. A click
    // hides immediately because the user can see they clicked; a spoken command's only
    // feedback is the search bar, and hiding it first would take the failure message with it.
    // Explorer answers in tens of milliseconds either way.
    if (!(await launchApp(installed.app.id))) {
      ctx.failed(`${installed.app.name} wouldn't start`)
      return true
    }
    hidePanel()
    return true
  }

  // The last two rungs. Not offered to a bare target: "documents" should not open a folder
  // because a folder of that name happens to exist.
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

/** Focus, then dismiss — the order ipc.ts uses for a clicked row, and for the same reason:
 *  the search bar is the foreground window at this moment, which is what makes
 *  SetForegroundWindow legal for us. Hiding first hands the foreground back to the OS and puts
 *  focus.ts on its fallback path for nothing. */
function focus(id: number): boolean {
  const focused = focusWindow(id)
  if (focused) hidePanel()
  return focused
}

/** WM_CLOSE, which is what the title-bar X does — the app may still put up "save your
 *  changes?" and it may still refuse. Nothing here waits to find out: the message is posted,
 *  not sent, so an app arguing with its user cannot hold the launcher open behind it. */
function close(id: number, title: string, ctx: CommandContext): void {
  if (!closeWindow(id)) {
    ctx.failed(`Windows wouldn't close ${title}`)
    return
  }
  hidePanel()
}

/** The transcript is normalised to lower case before it is matched, and a message that quotes
 *  it back reads as a transcription error rather than as an answer — "I don't see figma open".
 *  Only for display; nothing is ever matched against this. */
function spoken(target: string): string {
  return target.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

/** "github dot com" is what dictating a URL sounds like. Whisper writes the word out, and no
 *  application on the machine is called that, so this is safe to rewrite before the path and
 *  URL test sees it. */
function spokenUrl(target: string): string {
  return / dot /.test(target) ? target.replace(/\s+dot\s+/g, '.').replace(/\s+/g, '') : target
}
