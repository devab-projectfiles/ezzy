/** The v1 commands, registered as data (PLAN.md §4).
 *
 *  Two of them: `switch to X` and `open X`. §4 also lists `pause/play`, `next` and
 *  `previous`, and those are deliberately absent — they are `keybd_event` with the `VK_MEDIA_*`
 *  codes, which is chunk E's line in §8. A command that matches and then does nothing is worse
 *  than one that is not registered yet, so they wait for the module that can carry them out.
 *
 *  The resolution order inside `open X` is §4's, exactly: live window, installed app, file
 *  path, URL. `switch to X` stops at the first of those, because switching to something that
 *  is not running is not switching. */

import { indexedApps } from '../app-index'
import { focusWindow } from '../focus'
import { launchApp, openDirect, resolveDirect } from '../launcher'
import { bestMatch } from '../search'
import { listWindows } from '../window-tracker'
import { hidePanel } from '../windows'
import { register } from './registry'

/** "switch to chrome", "go back to code", "switch over to the terminal". The optional words
 *  are the ones people actually say around the verb; the capture is everything after them. */
const SWITCH = /^(?:switch|change|go|jump|flip)(?:\s+(?:over|back))*\s+to\s+(?:the\s+)?(.+)$/

/** "open figma", "launch spotify", "start notion", "open github.com". */
const OPEN = /^(?:open|launch|start|run|bring up|show me|show)(?:\s+up)?\s+(?:the\s+)?(.+)$/

export function registerBuiltinCommands(): void {
  register({
    id: 'switch-to',
    match: SWITCH,
    describe: (groups) => `Switching to ${spoken(groups[1])}`,
    run: async (groups, ctx) => {
      const target = groups[1]
      // Windows only, and no app list at all: "switch to" means something already open.
      const match = bestMatch(target, listWindows(), [])
      if (!match?.window) {
        ctx.failed(`I don't see ${spoken(target)} open`)
        return
      }
      if (!focus(match.window.id)) ctx.failed(`Windows wouldn't switch to ${match.window.app}`)
    }
  })

  register({
    id: 'open',
    match: OPEN,
    describe: (groups) => `Opening ${spoken(groups[1])}`,
    run: async (groups, ctx) => {
      const target = groups[1]
      // §4's order, and the two lists are searched in turn rather than ranked together for
      // exactly this reason: measured, one combined ranking gave "open notepad" to the app
      // index — an exact name match outscores a window whose title only mentions it — and
      // started a second Notepad next to the one already open. Opening what is already open
      // means going to it.
      const open = bestMatch(target, listWindows(), [])
      if (open?.window) {
        if (!focus(open.window.id)) ctx.failed(`Windows wouldn't switch to ${open.window.app}`)
        return
      }
      const installed = bestMatch(target, [], indexedApps())
      if (installed?.app) {
        hidePanel()
        if (!(await launchApp(installed.app.id))) ctx.failed(`${installed.app.name} wouldn't start`)
        return
      }
      // Neither list has it, so the last two rungs of §4's ladder: a path that exists, or a
      // URL. Spoken hostnames arrive as "github.com" or "github dot com".
      if (resolveDirect(spokenUrl(target))) {
        hidePanel()
        if (!(await openDirect())) ctx.failed(`I couldn't open ${target}`)
        return
      }
      ctx.failed(`I couldn't find ${spoken(target)}`)
    }
  })
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
