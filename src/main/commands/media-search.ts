/** "play X" — Spotify and YouTube search (FEATURE-media-search.md).
 *
 *  Two commands, registered as data, exactly the case PLAN.md §4 says the registry exists
 *  for. Nothing here is an integration: §1 lists per-app APIs as a permanent non-goal, and
 *  the feature note repeats it — no OAuth, no tokens, no Web API. A search URI and, for
 *  Spotify, the same media key chunk E already sends. That is the whole feature.
 *
 *  **Order matters twice**, and only one of the two is in the feature note:
 *
 *  1. YouTube before Spotify, or `play (.+)` swallows "play X on youtube". The note says so.
 *  2. These two go in the middle of the builtin set, not before it. `play/pause` must keep
 *     "play", "play the music" and "play pause"; `bare-target` must NOT get "play daft punk",
 *     which it would read as an app called that. builtin.ts registers this file at the one
 *     point that satisfies both — see the call site there. */

import { indexedApps } from '../app-index'
import { getConfig } from '../config'
import { openProtocolUri } from '../launcher'
import { playPause } from '../media-keys'
import { bestMatch } from '../search'
import { log } from '../verbose'
import { listWindows } from '../window-tracker'
import { hidePanel } from '../windows'
import { CommandContext, register } from './registry'

/** The `open X` ladder — live window, installed app, path, URL — handed in rather than
 *  imported, so this file and builtin.ts do not become an import cycle. "play spotify" has to
 *  keep launching Spotify (see the note on OPEN in builtin.ts), and that ladder is where the
 *  behaviour already lives; reimplementing it here is how the two would drift apart. */
export type ResolveTarget = (target: string, ctx: CommandContext, strict?: boolean) => Promise<void>

/** "play X on youtube", "search youtube for X", "find me youtube rust tutorial".
 *
 *  Two shapes, because people say it both ways round and the feature note's own table has one
 *  of each. Whichever alternative matched, the query is the group that is not undefined. */
const YOUTUBE =
  /^(?:play|search|find|watch|look\s+up)\s+(?:(?:on\s+)?youtube\s+(?:for\s+)?(.+)|(.+?)\s+on\s+youtube)$/

/** "play bohemian rhapsody", "play lofi on spotify".
 *
 *  The lookahead is the whole reason `play/pause` survives this file. Registration order puts
 *  the media keys first, so this pattern never sees "play the music" — but it would see it if
 *  anyone ever moved the registration, and a catch-all that quietly ate the media command
 *  would be a bad way to find that out. Belt and braces, deliberately: the alternatives mirror
 *  PLAY_PAUSE's own tail in builtin.ts.
 *
 *  `on spotify` is captured rather than discarded, because saying it out loud is the user
 *  overriding the resolution below — "play spotify" means the app, "play X on spotify" always
 *  means the search. */
const SPOTIFY =
  /^play(?!(?:\s+(?:the|this|that))?(?:\s+(?:music|song|track|audio|video|media|playback|it))?$|\s*[/-]?\s*pause$)\s+(.+?)(?:\s+on\s+(spotify))?$/

/** "play on spotify" with nothing in between — the lazy capture takes the leftovers rather
 *  than matching the optional suffix, so the guard has to name them. */
const NOTHING_TO_PLAY = /^on\s+(?:spotify|youtube)$/

/** How long Spotify gets to come up and render results before the play key is sent. A guess,
 *  which is why it is `spotifyPlayDelayMs` in config.json rather than a number in this file:
 *  a cold start needs longer than an app that is already running, and nobody can tell from
 *  here which one this is. */
function playDelay(): number {
  return getConfig().spotifyPlayDelayMs
}

export function registerMediaSearchCommands(resolveTarget: ResolveTarget): void {
  // YouTube first. "play rust tutorial on youtube" matches both patterns, and the one that
  // names where to look is the one that meant it.
  register({
    id: 'youtube-search',
    match: YOUTUBE,
    describe: (groups) => `Searching YouTube for ${spoken(query(groups))}`,
    run: async (groups, ctx) => {
      const q = query(groups)
      if (q === '') {
        ctx.failed('Search YouTube for what?')
        return
      }
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
      // Through the browser's own registered handler, not Explorer: Explorer drops any URL
      // carrying a query string, and a search URL is nothing but query string. See
      // `openProtocolUri`.
      if (!(await openProtocolUri('https', url, `YouTube search for ${q}`))) {
        ctx.failed('I couldn’t open YouTube')
        return
      }
      hidePanel()
    }
  })

  register({
    id: 'spotify-play',
    match: SPOTIFY,
    // One sentence for both outcomes, and it is true of both: the app came up either way. A
    // message that distinguished them would have to be decided in `run` and read back here,
    // and "Playing Spotify" is not worth a piece of state between the two.
    describe: (groups) => `Playing ${spoken(groups[1].trim())}`,
    run: async (groups, ctx) => {
      const q = groups[1].trim()
      // §4's note asks for an explicit empty guard rather than trusting `(.+?)`.
      if (q === '' || NOTHING_TO_PLAY.test(q)) {
        ctx.failed('Play what?')
        return
      }

      // "play spotify", "play vlc" — a name on this machine beats a search for that name.
      // Without this, adding a `play (.+)` catch-all would quietly take app launching away
      // from the verb, which is the exact trap builtin.ts's OPEN comment was written about.
      //
      // Asked strictly, and combining the two lists rather than walking them in turn, because
      // this is a yes/no about whether the words name anything — not a choice of winner. The
      // ladder picks that, the same way it does for "open X".
      if (groups[2] === undefined && bestMatch(q, listWindows(), indexedApps(), true)) {
        log(`media-search: "${q}" names something on this machine, opening it instead`)
        await resolveTarget(q, ctx, true)
        return
      }

      await playOnSpotify(q, ctx)
    }
  })
}

async function playOnSpotify(query: string, ctx: CommandContext): Promise<void> {
  const encoded = encodeURIComponent(query)

  // The feature note reaches for `shell.openExternal` in a try/catch, treating a throw as
  // "Spotify is not installed". Neither half survives contact with this codebase or with
  // Windows: this app opens nothing through `openExternal` (launcher.ts explains why), and
  // the question it is trying to answer is better asked outright. `openProtocolUri` reads the
  // handler `spotify:` is registered to and runs it — so false means nothing is registered,
  // which is exactly "not installed", with no exception to interpret.
  if (
    await openProtocolUri('spotify', `spotify:search:${encoded}`, `Spotify search for ${query}`)
  ) {
    hidePanel()
    // Scheduled, not awaited. §7 is explicit that nothing may sit between the user finishing
    // their sentence and the thing happening — and `runCommand` does not resolve until `run`
    // does, so awaiting this would hold the spoken confirmation and the pill for the better
    // part of a second, and spend most of the 1200ms voice budget on a timer.
    const delay = playDelay()
    setTimeout(() => {
      log(`media-search: play key ${delay}ms after opening Spotify`)
      playPause()
    }, delay)
    return
  }

  // No Spotify on this machine: the web player, and NO media key. That split is the point.
  // PLAY_PAUSE goes to whatever owns the machine's media session, which here is some other
  // app entirely — Ezzy would pause the user's music to celebrate opening a web page.
  const web = `https://open.spotify.com/search/${encoded}`
  if (!(await openProtocolUri('https', web, 'the Spotify web player'))) {
    ctx.failed('I couldn’t open Spotify')
    return
  }
  hidePanel()
}

/** Whichever half of YOUTUBE matched. */
function query(groups: RegExpMatchArray): string {
  return (groups[1] ?? groups[2] ?? '').trim()
}

/** The transcript arrives lower-cased, and a confirmation that quotes it back that way reads
 *  as a transcription error rather than as an answer. Display only — the same reason and the
 *  same treatment as `spoken` in builtin.ts. */
function spoken(text: string): string {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}
