/** The v1 commands, registered as data (PLAN.md §4).
 *
 *  §4's `pause/play`, `next` and `previous` arrived with chunk E, which is where §8 puts the
 *  `VK_MEDIA_*` codes they need. They are the shape §4 promised: a pattern, one call, and a
 *  sentence to say afterwards.
 *
 *  `close X`, `close all windows` and the three power commands are not in §4's list at all.
 *  They were asked for after chunk D shipped, and they are exactly the shape §4 predicted: a
 *  pattern, a resolver and twenty lines.
 *
 *  **`switch to X` and `open X` do the same thing**, on purpose. §4 gives `open X` the ladder
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
 *  verbs without shadowing them. */
const PLAY_PAUSE =
  /^(?:(play|pause|resume|unpause)|play\s*[/-]?\s*pause|toggle)(?:\s+(?:the|this|that))?(?:\s+(?:music|song|track|audio|video|media|playback|it))?$/

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

export function registerBuiltinCommands(): void {
  // The three that cannot be undone, first in the list. Each matches a whole utterance and
  // nothing else, so they shadow nothing — while the other way round, "go to sleep" was being
  // read by `switch to` as a request to switch to something called "sleep".
  register({
    id: 'sleep',
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
    match: /^hibernate(?:\s+the)?(?:\s+(?:pc|computer|laptop|machine|system))?$/,
    describe: () => 'Hibernating',
    run: async (_groups, ctx) => {
      hidePanel()
      if (!hibernateMachine()) ctx.failed('Windows wouldn’t hibernate')
    }
  })

  register({
    id: 'shut-down',
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
    match: PLAY_PAUSE,
    // One key toggles both, so the verb the user chose is the only evidence of which one they
    // meant. Echoing it back is honest — Ezzy genuinely does not know whether anything was
    // playing — and it reads as an answer rather than as a shrug.
    describe: (groups) =>
      groups[1] === 'pause' ? 'Pausing' : groups[1] ? 'Playing' : 'Play/pause',
    run: async () => {
      playPause()
      hidePanel()
    }
  })

  register({
    id: 'next-track',
    match: NEXT_TRACK,
    describe: () => 'Next track',
    run: async () => {
      nextTrack()
      hidePanel()
    }
  })

  register({
    id: 'previous-track',
    match: PREVIOUS_TRACK,
    describe: () => 'Previous track',
    run: async () => {
      previousTrack()
      hidePanel()
    }
  })

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

  register({
    id: 'switch-to',
    match: SWITCH,
    describe: (groups) => `Switching to ${spoken(groups[1])}`,
    run: (groups, ctx) => goTo(groups[1], ctx)
  })

  register({
    id: 'open',
    match: OPEN,
    describe: (groups) => `Opening ${spoken(groups[1])}`,
    run: (groups, ctx) => goTo(groups[1], ctx)
  })

  register({
    id: 'close-all',
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
    match: BARE,
    describe: (groups) => `Opening ${spoken(groups[1])}`,
    run: async (groups, ctx) => {
      const target = groups[1]
      if (target.split(/\s+/).length > BARE_MAX_WORDS) {
        ctx.failed(`I didn't understand "${target}"`)
        return
      }
      await goTo(target, ctx, true)
    }
  })
}

/** §4's ladder: live window, installed app, file path, URL.
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
