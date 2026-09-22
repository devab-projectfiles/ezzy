/** The v1 commands, registered as data. `switch to X` and `open X` do the same thing,
 *  on purpose — the verbs are synonyms in the user's head. */

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

const SWITCH =
  /^(?:switch|switched|change|swap|go|jump|flip|move|take me|bring me|head)(?:\s+(?:over|back|me))*\s+to\s+(?:the\s+)?(.+)$/

const OPEN =
  /^(?:open|launch|start|run|play|bring up|pull up|show me|show|focus|activate)(?:\s+up)?\s+(?:the\s+)?(.+)$/

const CLOSE_ALL = /^(?:close|quit|kill)\s+(?:all|every)\s*(?:the\s+)?(?:windows?|thing|things)?$/

const CLOSE_THIS =
  /^(?:close|quit|dismiss|kill)\s+(?:this|that|it|the|current)?\s*(?:window|app|thing)?$/

const CLOSE_NAMED = /^(?:close|quit|kill)\s+(?:the\s+)?(.+?)(?:\s+window)?$/

/** "pose" is "pause" spoken in an Ethiopian accent — the command accepts it rather than
 *  rewriting it upstream, since a global rewrite would break an app called Pose. */
const PLAY_PAUSE =
  /^(?:(play|pause|pose|resume|unpause|stop)|play\s*[/-]?\s*pause|toggle)(?:\s+(?:the|this|that))?(?:\s+(?:music|song|track|audio|video|media|playback|it))?$/

const PAUSING = new Set(['pause', 'pose', 'stop'])

const NEXT_TRACK = /^(?:next|skip|forward)(?:\s+(?:the|this|that))?(?:\s+(?:track|song|one|it))?$/

const PREVIOUS_TRACK =
  /^(?:previous|prev|back|go back|last)(?:\s+(?:the|this|that))?(?:\s+(?:track|song|one))?$/

/** A bare name, no verb — catches a first word the microphone clips off. Matched
 *  strictly, since it also catches whatever whisper invents out of silence. */
const BARE = /^([a-z0-9][a-z0-9 .+&'-]{1,40})$/
const BARE_MAX_WORDS = 4

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

let playPauseSaid = 'Play/pause'

function wantedHalf(verb: string | undefined): 'play' | 'pause' | null {
  if (verb === undefined) return null
  return PAUSING.has(verb) ? 'pause' : 'play'
}
let skipTarget: string | null = null

export function registerBuiltinCommands(): void {
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

  registerPlaybackCommands(goTo)
  registerMediaSearchCommands(goTo)
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

async function goTo(target: string, ctx: CommandContext, strict = false): Promise<void> {
  for (const phrase of spokenVariants(target, strict)) {
    if (await tryPhrase(phrase, ctx, strict)) return
  }
  ctx.failed(`I couldn't find ${spoken(target)}`)
}

async function tryPhrase(target: string, ctx: CommandContext, strict: boolean): Promise<boolean> {
  const open = bestMatch(target, listWindows(), [], strict)
  if (open?.window) {
    if (!focus(open.window.id)) ctx.failed(`Windows wouldn't switch to ${open.window.app}`)
    return true
  }

  const installed = bestMatch(target, [], indexedApps(), strict)
  if (installed?.app) {
    if (!(await launchApp(installed.app.id))) {
      ctx.failed(`${installed.app.name} wouldn't start`)
      return true
    }
    hidePanel()
    return true
  }

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

function focus(id: number): boolean {
  const focused = focusWindow(id)
  if (focused) hidePanel()
  return focused
}

function close(id: number, title: string, ctx: CommandContext): void {
  if (!closeWindow(id)) {
    ctx.failed(`Windows wouldn't close ${title}`)
    return
  }
  hidePanel()
}

function spoken(target: string): string {
  return target.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

function spokenUrl(target: string): string {
  return / dot /.test(target) ? target.replace(/\s+dot\s+/g, '.').replace(/\s+/g, '') : target
}
