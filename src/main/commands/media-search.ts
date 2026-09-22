/** "play X" — Spotify and YouTube search. A search URI, nothing more: no OAuth, no
 *  tokens, no Web API.
 *
 *  It shows results; it does not start them playing, and must not pretend to. An earlier
 *  version fired a media key 900ms after opening the search, on the theory that would
 *  start the top result — but a media key is not addressed to anything, so Windows handed
 *  it to whatever already owned the media session and paused or resumed THAT instead.
 *  Starting a named track needs a playable id, which needs the Spotify Web API — ruled
 *  out permanently, and Premium-only besides. So Ezzy takes you to the results; you press
 *  play. The confirmation says exactly that.
 *
 *  Order matters twice:
 *
 *  1. Anything naming a service goes before the bare `play (.+)` catch-all, or it would
 *     swallow "play X on youtube" and "play X on spotify".
 *  2. These commands register in the middle of the builtin set — after the media keys, so
 *     "play the music" still reaches play/pause; before `bare-target`, which would
 *     otherwise read "play daft punk" as an app called that. See the call site in builtin.ts. */

import { indexedApps } from '../app-index'
import { openProtocolUri, openUrlInWebApp } from '../launcher'
import { bestMatch } from '../search'
import { log } from '../verbose'
import { topVideoId } from '../youtube'
import { listWindows } from '../window-tracker'
import { hidePanel } from '../windows'
import { CommandContext, register } from './registry'

/** The `open X` ladder, handed in rather than imported so this file and builtin.ts do not
 *  become an import cycle — "play spotify" still has to launch Spotify, and that ladder
 *  is where the behaviour already lives. */
export type ResolveTarget = (target: string, ctx: CommandContext, strict?: boolean) => Promise<void>

/** "play X on youtube", "search youtube for X", "find me youtube rust tutorial" — two
 *  shapes, since people say it both ways round.
 *
 *  `you ?tube` rather than `youtube`: whisper writes the brand as one word most of the
 *  time and "You Tube" some of the time, and this is the one word in the pattern a human
 *  actually says out loud, so it gets the same fuzzy treatment app names do. */
const YOUTUBE =
  /^(?:play|search|find|watch|look\s+up)\s+(?:(?:on\s+)?you ?tube\s+(?:for\s+)?(.+)|(.+?)\s+on\s+you ?tube)$/

/** "search spotify for daft punk", "play lofi on spotify", "listen to miles davis on
 *  spotify" — same two shapes as YOUTUBE. Naming the service also makes this
 *  unambiguously a search ("play spotify" is the app, "play X on spotify" is a search),
 *  so this never falls back to the launcher the way `spotify-play` below does. */
const SPOTIFY_SEARCH =
  /^(?:play|search|find|look\s+up|listen\s+to)\s+(?:(?:on\s+)?spotify\s+(?:for\s+)?(.+)|(.+?)\s+on\s+spotify)$/

/** "play bohemian rhapsody" — the catch-all, no service named. The lookahead mirrors
 *  PLAY_PAUSE's own tail in builtin.ts, so if registration order ever changes this still
 *  refuses to swallow the media command rather than eating it silently. */
const SPOTIFY =
  /^play(?!(?:\s+(?:the|this|that))?(?:\s+(?:music|song|track|audio|video|media|playback|it))?$|\s*[/-]?\s*pause$)\s+(.+)$/

/** Which verbs mean "start it" vs "show me" — both are legitimate on YouTube, and the
 *  user says which they meant. Tested against `ctx.transcript` rather than captured in
 *  the pattern, which would renumber groups two commands share. */
const PLAY_VERB = /^(?:play|watch|listen\s+to)\b/

/** "play on spotify" with nothing in between — SPOTIFY_SEARCH refuses it (no query to
 *  capture), so it reaches the catch-all instead, which happily takes the leftovers. */
const NOTHING_TO_PLAY = /^on\s+(?:spotify|you ?tube)$/

/** What the last spotify-play run actually did, read by `describe` right after `run`
 *  resolves for the same command — one opened an app, the other showed search results,
 *  and only `run` knows which. */
let lastRun: 'opened' | 'searched' = 'searched'

/** The same, for YouTube — whether the first result could be established at all decides
 *  this, so it cannot be known until the run is over. */
let lastYouTubeRun: 'played' | 'searched' = 'searched'

export function registerMediaSearchCommands(resolveTarget: ResolveTarget): void {
  // YouTube first — "play rust tutorial on youtube" matches both patterns, and the one
  // that names where to look is the one that meant it.
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

      // Only play/watch/listen-to go looking for a video — a search request skips the
      // extra second that finding one costs, so the phrasing that wants a list gets it
      // faster too. `topVideoId` answers null for every failure it can meet, so this is
      // the only branch point and there is no separate error path to handle.
      const id = PLAY_VERB.test(ctx.transcript) ? await topVideoId(q) : null
      lastYouTubeRun = id === null ? 'searched' : 'played'
      const url =
        id === null
          ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
          : `https://www.youtube.com/watch?v=${id}`

      // The installed YouTube app first, if there is one — it does not reliably claim
      // its own links on this machine, so Ezzy asks for the app window directly.
      if (await openUrlInWebApp('YouTube', url, `YouTube for ${q}`)) {
        hidePanel()
        return
      }

      // Otherwise a tab, through the browser's own registered handler rather than
      // Explorer, which drops any URL carrying a query string.
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
    // "Playing X" would be a lie in the case that matters — Ezzy can open Spotify on the
    // search results, not start the artist playing.
    describe: (groups) =>
      lastRun === 'opened'
        ? `Opening ${spoken(groups[1].trim())}`
        : `Searching Spotify for ${spoken(groups[1].trim())}`,
    run: async (groups, ctx) => {
      const q = groups[1].trim()
      if (q === '' || NOTHING_TO_PLAY.test(q)) {
        ctx.failed('Play what?')
        return
      }

      // "play spotify", "play vlc" — a name on this machine beats a search for it, or a
      // bare `play (.+)` catch-all would quietly take app launching away from the verb.
      // Asked strictly and against both lists together, since this is a yes/no about
      // whether the words name anything, not a choice of winner — the ladder picks that.
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

  // `openProtocolUri` reads the handler `spotify:` is registered to and runs it, so
  // false means nothing is registered — which is exactly "not installed".
  if (
    await openProtocolUri('spotify', `spotify:search:${encoded}`, `Spotify search for ${query}`)
  ) {
    hidePanel()
    return
  }

  // No Spotify on this machine: the web player, and NO media key — that key would go to
  // whatever else owns the media session, pausing the user's music to celebrate a page load.
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

/** Display only — the transcript arrives lower-cased, and quoting it back that way reads
 *  as a transcription error rather than an answer. Same treatment as `spoken` in builtin.ts. */
function spoken(text: string): string {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}
