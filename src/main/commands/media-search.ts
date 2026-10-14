/** "play X" — Spotify and YouTube search. A search URI, nothing more: no OAuth, no
 *  tokens, no Web API. It shows results; it does not start them playing (starting a
 *  named track needs a playable id, which needs the Spotify Web API — ruled out
 *  permanently, and Premium-only besides). Ezzy takes you to the results; you press play. */

import { indexedApps } from '../app-index'
import { openProtocolUri, openUrlInWebApp } from '../launcher'
import { bestMatch } from '../search'
import { log } from '../verbose'
import { topVideoId } from '../youtube'
import { listWindows } from '../window-tracker'
import { hidePanel } from '../windows'
import { CommandContext, register } from './registry'

export type ResolveTarget = (target: string, ctx: CommandContext, strict?: boolean) => Promise<void>

/** `you ?tube` rather than `youtube`: whisper writes the brand as one word most of the
 *  time and "You Tube" some of the time. */
const YOUTUBE =
  /^(?:play|search|find|watch|listen\s+to|look\s+up)\s+(?:(?:on\s+)?you ?tube\s+(?:for\s+)?(.+)|(.+?)\s+on\s+you ?tube)$/

const SPOTIFY_SEARCH =
  /^(?:play|search|find|look\s+up|listen\s+to)\s+(?:(?:on\s+)?spotify\s+(?:for\s+)?(.+)|(.+?)\s+on\s+spotify)$/

/** The catch-all, no service named — the lookahead mirrors PLAY_PAUSE's tail in
 *  builtin.ts so it never swallows the media command. */
const SPOTIFY =
  /^play(?!(?:\s+(?:the|this|that))?(?:\s+(?:music|song|track|audio|video|media|playback|it))?$|\s*[/-]?\s*pause$)\s+(.+)$/

const PLAY_VERB = /^(?:play|watch|listen\s+to)\b/
const NOTHING_TO_PLAY = /^on\s+(?:spotify|you ?tube)$/

let lastRun: 'opened' | 'searched' = 'searched'
let lastYouTubeRun: 'played' | 'searched' = 'searched'

export function registerMediaSearchCommands(resolveTarget: ResolveTarget): void {
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
    startsPlayback: (groups) => PLAY_VERB.test(groups[0]),
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

      const id = PLAY_VERB.test(ctx.transcript) ? await topVideoId(q) : null
      lastYouTubeRun = id === null ? 'searched' : 'played'
      const url =
        id === null
          ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
          : `https://www.youtube.com/watch?v=${id}`

      if (await openUrlInWebApp('YouTube', url, `YouTube for ${q}`)) {
        hidePanel()
        return
      }

      if (!(await openProtocolUri('https', url, `YouTube for ${q}`))) {
        ctx.failed('I couldn’t open YouTube')
        return
      }
      hidePanel()
    }
  })

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
    // Only results open, but asking to play means switching — the old music stays off.
    startsPlayback: (groups) => PLAY_VERB.test(groups[0]),
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
    startsPlayback: () => true,
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

  if (
    await openProtocolUri('spotify', `spotify:search:${encoded}`, `Spotify search for ${query}`)
  ) {
    hidePanel()
    return
  }

  // No media key — it would go to whatever else owns the media session, pausing the
  // user's music to celebrate a page load.
  const web = `https://open.spotify.com/search/${encoded}`
  if (!(await openProtocolUri('https', web, 'the Spotify web player'))) {
    ctx.failed('I couldn’t open Spotify')
    return
  }
  hidePanel()
}

function query(groups: RegExpMatchArray): string {
  return (groups[1] ?? groups[2] ?? '').trim()
}

function spoken(text: string): string {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}
