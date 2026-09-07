/** "play X" — Spotify and YouTube search (FEATURE-media-search.md).
 *
 *  Three commands, registered as data, exactly the case the plan says the registry exists
 *  for. Nothing here is an integration: the plan lists per-app APIs as a permanent non-goal, and
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
 *  id is the Spotify Web API — which the plan rules out permanently, and which is Premium-only for
 *  playback anyway. So the honest scope is: Ezzy takes you to the results, you press play. The
 *  confirmation says exactly that.
 *
 *  **Order matters twice**, and only one of the two is in the feature note:
 *
 *  1. Anything that NAMES a service before the bare `play (.+)`, or the catch-all swallows
 *     "play X on youtube" and "play X on spotify". The note says so for YouTube; the same
 *     applies to Spotify's own search verbs.
 *  2. These two go in the middle of the builtin set, not before it. `play/pause` must keep
 *     "play", "play the music" and "play pause"; `bare-target` must NOT get "play daft punk",
 *     which it would read as an app called that. builtin.ts registers this file at the one
 *     point that satisfies both — see the call site there. */

import { indexedApps } from '../app-index'
import { openProtocolUri, openUrlInWebApp } from '../launcher'
import { bestMatch } from '../search'
import { log } from '../verbose'
import { topVideoId } from '../youtube'
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
 *  of each. Whichever alternative matched, the query is the group that is not undefined.
 *
 *  `you ?tube` rather than `youtube`, because this is matched against a transcript: whisper
 *  writes the brand as one word most of the time and as "You Tube" some of the time, and the
 *  difference between those two is the difference between a search and "I didn't understand
 *  that". the rule for app names — always fuzzy, never exact — applies to the one word in
 *  this pattern that a human actually says out loud. */
const YOUTUBE =
  /^(?:play|search|find|watch|look\s+up)\s+(?:(?:on\s+)?you ?tube\s+(?:for\s+)?(.+)|(.+?)\s+on\s+you ?tube)$/

/** "search spotify for daft punk", "play lofi on spotify", "listen to miles davis on spotify".
 *
 *  The same two shapes as YOUTUBE, for the same reason: naming the service is the user saying
 *  which one they mean, whichever way round they say it. Naming it is also what makes this
 *  unambiguously a search — "play spotify" is the app, "play something on spotify" is a
 *  search for something — so this command never consults the launcher the way `spotify-play`
 *  below has to. */
const SPOTIFY_SEARCH =
  /^(?:play|search|find|look\s+up|listen\s+to)\s+(?:(?:on\s+)?spotify\s+(?:for\s+)?(.+)|(.+?)\s+on\s+spotify)$/

/** "play bohemian rhapsody" — the catch-all, with no service named.
 *
 *  The lookahead is the whole reason `play/pause` survives this file. Registration order puts
 *  the media keys first, so this pattern never sees "play the music" — but it would see it if
 *  anyone ever moved the registration, and a catch-all that quietly ate the media command
 *  would be a bad way to find that out. Belt and braces, deliberately: the alternatives mirror
 *  PLAY_PAUSE's own tail in builtin.ts. */
const SPOTIFY =
  /^play(?!(?:\s+(?:the|this|that))?(?:\s+(?:music|song|track|audio|video|media|playback|it))?$|\s*[/-]?\s*pause$)\s+(.+)$/

/** Which verbs mean "start it" as opposed to "show me".
 *
 *  Both belong on YouTube and the user is the one who says which they meant: "play the first
 *  one" and "let me look at the list" are different requests, and answering the second with
 *  the first is the same class of surprise as a search that hijacks the music. Tested against
 *  `ctx.transcript` — the normalised text this command matched — rather than captured in the
 *  pattern, which would renumber the groups two commands share. */
const PLAY_VERB = /^(?:play|watch|listen\s+to)\b/

/** "play on spotify" with nothing in between. SPOTIFY_SEARCH refuses it — it has no query to
 *  capture — so it reaches the catch-all, where `(.+)` happily takes the leftovers. */
const NOTHING_TO_PLAY = /^on\s+(?:spotify|you ?tube)$/

/** What the last `spotify-play` run actually did, so the confirmation can say the true one.
 *
 *  A module-scoped value read by `describe` is not a thing to do lightly, but the registry
 *  calls `describe` immediately after the same command's `run` resolves, on the same turn and
 *  one command at a time — so it cannot be read out of order. The alternative is one sentence
 *  covering two outcomes, and the outcomes are genuinely different: one opened an app, the
 *  other put a list of search results on screen. */
let lastRun: 'opened' | 'searched' = 'searched'

/** The same, for YouTube: whether the last run started a video or only opened the results.
 *  Which of the two happens is decided by whether the first result could be established at
 *  all (see `topVideoId`), so it cannot be known until the run is over. */
let lastYouTubeRun: 'played' | 'searched' = 'searched'

export function registerMediaSearchCommands(resolveTarget: ResolveTarget): void {
  // YouTube first. "play rust tutorial on youtube" matches both patterns, and the one that
  // names where to look is the one that meant it.
  register({
    id: 'youtube-search',
    takesTarget: true,
    title: 'YouTube',
    group: 'media',
    summary:
      'The verb decides what happens. Play, watch and listen to find the first video and start it. Search, find and look up open the results instead, and skip the second it costs to find a video.',
    examples: [
      'play lofi beats on youtube',
      'watch bohemian rhapsody on youtube',
      'search youtube for rust tutorial'
    ],
    match: YOUTUBE,
    describe: (groups) =>
      lastYouTubeRun === 'played'
        ? `Playing ${spoken(query(groups))} on YouTube`
        : `Searching YouTube for ${spoken(query(groups))}`,
    run: async (groups, ctx) => {
      const q = query(groups)
      if (q === '') {
        ctx.failed('Search YouTube for what?')
        return
      }

      // Only "play"/"watch"/"listen to" go looking for a video. "search youtube for X" is a
      // request to SEE the results, and it also skips the second of latency that finding the
      // first video costs — so the phrasing that wants a list gets it faster, too.
      //
      // When we do look: `topVideoId` answers null for every failure it can meet, so this is
      // the only place the two outcomes differ and there is no error path to handle. Unlike
      // Spotify, YouTube plays straight from a URL once the video is named, which is the whole
      // reason this is possible here and not there.
      const id = PLAY_VERB.test(ctx.transcript) ? await topVideoId(q) : null
      lastYouTubeRun = id === null ? 'searched' : 'played'
      const url =
        id === null
          ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
          : `https://www.youtube.com/watch?v=${id}`

      // The installed YouTube app first, if there is one. It is supposed to claim its own
      // links and does not on this machine, with the setting on, so Ezzy asks for the app
      // window rather than hoping the browser routes a tab into it.
      if (await openUrlInWebApp('YouTube', url, `YouTube for ${q}`)) {
        hidePanel()
        return
      }

      // Otherwise a tab, through the browser's own registered handler rather than Explorer:
      // Explorer drops any URL carrying a query string, and both of these are query strings.
      if (!(await openProtocolUri('https', url, `YouTube for ${q}`))) {
        ctx.failed('I couldn’t open YouTube')
        return
      }
      hidePanel()
    }
  })

  // Explicitly Spotify, so it always searches: no launcher, no "did you mean the app".
  register({
    id: 'spotify-search',
    takesTarget: true,
    title: 'Spotify search',
    group: 'media',
    summary:
      'Opens Spotify on the results for what you asked for. It cannot start a named track playing - that needs the Spotify Web API, which Ezzy deliberately does not use.',
    examples: [
      'play daft punk on spotify',
      'search spotify for lofi',
      'listen to miles davis on spotify'
    ],
    match: SPOTIFY_SEARCH,
    describe: (groups) => `Searching Spotify for ${spoken(query(groups))}`,
    run: async (groups, ctx) => {
      const q = query(groups)
      if (q === '') {
        ctx.failed('Search Spotify for what?')
        return
      }
      await playOnSpotify(q, ctx)
    }
  })

  register({
    id: 'spotify-play',
    takesTarget: true,
    title: 'Play something',
    group: 'media',
    summary:
      'Searches Spotify for whatever follows the word play - unless those words name something installed on this machine, in which case it opens that instead.',
    examples: ['play daft punk', 'play bohemian rhapsody'],
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
      // the note asks for an explicit empty guard rather than trusting `(.+?)`.
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
      if (bestMatch(q, listWindows(), indexedApps(), true)) {
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

/** Whichever half of a two-shape pattern matched — YOUTUBE or SPOTIFY_SEARCH. */
function query(groups: RegExpMatchArray): string {
  return (groups[1] ?? groups[2] ?? '').trim()
}

/** The transcript arrives lower-cased, and a confirmation that quotes it back that way reads
 *  as a transcription error rather than as an answer. Display only — the same reason and the
 *  same treatment as `spoken` in builtin.ts. */
function spoken(text: string): string {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}
