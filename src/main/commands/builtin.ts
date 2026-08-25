/** The v1 commands, registered as data (PLAN.md §4).
 *
 *  §4 also lists `pause/play`, `next` and `previous`. Those are deliberately absent — they are
 *  `keybd_event` with the `VK_MEDIA_*` codes, which is chunk E's line in §8. A command that
 *  matches and then does nothing is worse than one that is not registered yet.
 *
 *  `close X` is not in §4's list at all. It was asked for after chunk D shipped, and it is
 *  exactly the shape §4 predicted: a pattern, a resolver and twenty lines.
 *
 *  **`switch to X` and `open X` do the same thing**, on purpose. §4 gives `open X` the ladder
 *  — live window, installed app, file path, URL — and stops `switch to X` at the first rung,
 *  which is defensible right up until someone says "switch to Spotify" with Spotify closed and
 *  is told it is not open, having watched "open Spotify" work a second earlier. The verbs are
 *  synonyms in the user's head, so they are synonyms here; only the confirmation differs. */

import { indexedApps } from '../app-index'
import { focusWindow } from '../focus'
import { launchApp, openDirect, resolveDirect } from '../launcher'
import { bestMatch } from '../search'
import { listWindows } from '../window-tracker'
import { closeWindow } from '../win32'
import { hidePanel } from '../windows'
import { CommandContext, register } from './registry'

/** "switch to chrome", "go back to code", "switch over to the terminal", "take me to slack".
 *  The optional words are the ones people actually say around the verb. */
const SWITCH =
  /^(?:switch|switched|change|swap|go|jump|flip|move|take me|bring me|head)(?:\s+(?:over|back|me))*\s+to\s+(?:the\s+)?(.+)$/

/** "open figma", "launch spotify", "start notion", "open github.com". */
const OPEN =
  /^(?:open|launch|start|run|bring up|pull up|show me|show|focus|activate)(?:\s+up)?\s+(?:the\s+)?(.+)$/

/** "close this window", "close it", "close this", "close the current window". */
const CLOSE_THIS =
  /^(?:close|quit|dismiss|kill)\s+(?:this|that|it|the|current)?\s*(?:window|app|thing)?$/

/** "close chrome", "close the outlook window". */
const CLOSE_NAMED = /^(?:close|quit|kill)\s+(?:the\s+)?(.+?)(?:\s+window)?$/

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

  // Before CLOSE_NAMED, which would otherwise read "close this window" as a window called
  // "this".
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
      const match = bestMatch(target, listWindows(), [])
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
  const open = bestMatch(target, listWindows(), [], strict)
  if (open?.window) {
    if (!focus(open.window.id)) ctx.failed(`Windows wouldn't switch to ${open.window.app}`)
    return
  }

  const installed = bestMatch(target, [], indexedApps(), strict)
  if (installed?.app) {
    // Acted on first and dismissed second, the opposite way round from a clicked row. A click
    // hides immediately because the user can see they clicked; a spoken command's only
    // feedback is the search bar, and hiding it first would take the failure message with it.
    // Explorer answers in tens of milliseconds either way.
    if (!(await launchApp(installed.app.id))) {
      ctx.failed(`${installed.app.name} wouldn't start`)
      return
    }
    hidePanel()
    return
  }

  // The last two rungs. Not offered to a bare target: "documents" should not open a folder
  // because a folder of that name happens to exist.
  if (!strict && resolveDirect(spokenUrl(target))) {
    if (!(await openDirect())) {
      ctx.failed(`I couldn't open ${target}`)
      return
    }
    hidePanel()
    return
  }

  ctx.failed(`I couldn't find ${spoken(target)}`)
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
