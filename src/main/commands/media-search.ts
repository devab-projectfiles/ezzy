/** "play X" — Spotify and YouTube search (FEATURE-media-search.md).
 *
 *  Two commands, registered as data, exactly the case PLAN.md §4 says the registry exists
 *  for. Nothing here is an integration: §1 lists per-app APIs as a permanent non-goal, and
 *  the feature note repeats it — no OAuth, no tokens, no Web API. A search URI, and that is
 *  the whole feature.
 *
 *  **Which means it shows results; it does not start them playing, and it must not pretend
 *  to.** The feature note ends "play daft punk opens Spotify on those results and music
 *  starts", with a `PLAY_PAUSE` after a 900ms wait to do the second half. That was built, and
 *  it was wrong in the way that matters: a media key is not addressed to anything. Windows
 *  hands it to whoever owns the current media session, so it resumes — or, if the user was
 *  already listening to something, PAUSES — the track that was already there, and never the
 *  artist that was just asked for. Reported from real use, and reproduced: after
 *  `spotify:search:daft punk` the client shows the results with nothing playing, and neither
 *  the media key nor Enter on the focused results page starts the top result.
 *
 *  Starting a NAMED track needs a playable id (`spotify:track:…`), and turning a name into an
 *  id is the Spotify Web API — which §1 rules out permanently, and which is Premium-only for
 *  playback anyway. So the honest scope is: Ezzy takes you to the results, you press play. The
 *  confirmation says exactly that.
 *
 *  **Order matters twice**, and only one of the two is in the feature note:
 *
 *  1. YouTube before Spotify, or `play (.+)` swallows "play X on youtube". The note says so.
 *  2. These two go in the middle of the builtin set, not before it. `play/pause` must keep
 *     "play", "play the music" and "play pause"; `bare-target` must NOT get "play daft punk",
 *     which it would read as an app called that. builtin.ts registers this file at the one
 *     point that satisfies both — see the call site there. */

import { indexedApps } from '../app-index'
import { openProtocolUri } from '../launcher'
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

/** What the last `spotify-play` run actually did, so the confirmation can say the true one.
 *
 *  A module-scoped value read by `describe` is not a thing to do lightly, but the registry
 *  calls `describe` immediately after the same command's `run` resolves, on the same turn and
 *  one command at a time — so it cannot be read out of order. The alternative is one sentence
 *  covering two outcomes, and the outcomes are genuinely different: one opened an app, the
 *  other put a list of search results on screen. */
let lastRun: 'opened' | 'searched' = 'searched'

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
    // "Playing X" was a lie in the case that matters. Ezzy can put Spotify on the search
    // results for a name; it cannot start that artist playing (see `playOnSpotify`), and a
    // confirmation that claims otherwise is worse than the limitation it hides.
    describe: (groups) =>
      lastRun === 'opened'
        ? `Opening ${spoken(groups[1].trim())}`
        : `Searching Spotify for ${spoken(groups[1].trim())}`,
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
        lastRun = 'opened'
        await resolveTarget(q, ctx, true)
        return
      }

      lastRun = 'searched'
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
