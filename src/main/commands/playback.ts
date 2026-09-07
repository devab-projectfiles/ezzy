/** Play/pause aimed at a named player, rather than at the machine.
 *
 *  A bare media key is addressed to nothing: Windows hands it to whichever app most recently
 *  owned the media session. That is the right answer for "next track" and the wrong one for
 *  "play music" — with Spotify sitting paused and a browser video watched since, the key went
 *  to the browser, and the music the user asked for stayed paused. Reported from real use.
 *
 *  So the recipient is chosen here and the command is posted to that window (see `playPauseIn`
 *  in media-keys.ts). Two rules, and between them they cover everything:
 *
 *   * **"play music" picks the player.** A dedicated music application if one is running,
 *     Spotify if not, and only then the bare media key — which is where a browser video ends
 *     up, and where it should, since nothing else was open to claim it.
 *   * **Naming the service overrides that.** "play spotify" reaches Spotify even while a
 *     music player is running, and "play youtube" reaches the video even while Spotify is.
 *     Naming it is the user saying which one they meant, and there is no other way for them
 *     to say it.
 *
 *  Neither of these searches or opens anything. Starting something NEW is the job of the
 *  commands in media-search.ts, and this file only ever resumes what is already there — the
 *  one exception being a named service with no window at all, which falls back to the
 *  launcher rather than failing at a user who plainly wants that app in front of them. */

import { MediaAction, mediaIn } from '../media-keys'
import { log } from '../verbose'
import { EzzyWindow } from '../../shared/types'
import { listWindows } from '../window-tracker'
import { hidePanel } from '../windows'
import { register } from './registry'
import { ResolveTarget } from './media-search'

/** Applications that exist to play audio, matched against the owning executable's name as the
 *  window tracker prettifies it — `Spotify.exe` arrives here as "Spotify", `AIMP.exe` as
 *  "Aimp", `Music.UI.exe` as "Music.UI".
 *
 *  A closed list, the same choice `system.ts` makes about settings pages and for the same
 *  reason: a fuzzy match against every running window would eventually decide that something
 *  is close enough to a media player and swallow a command meant for the music. A name that is
 *  not on this list simply is not a music player as far as Ezzy is concerned, and the bare
 *  media key still reaches it — which is exactly the behaviour that was there before. */
const PLAYERS = new Set([
  'microsoft.media.player',
  'wmplayer',
  'music.ui',
  'applemusic',
  'itunes',
  'vlc',
  'musicbee',
  'foobar2000',
  'winamp',
  'aimp',
  'mediamonkey',
  'tidal',
  'deezer'
])

/** Second in line behind the list above, and deliberately not in it. Spotify is the fallback
 *  the user asked for — "if the music player app isn't running, then Spotify" — and it is also
 *  the one they can name to jump the queue. Being its own rung is what makes both true. */
const SPOTIFY = 'spotify'

/** How a YouTube window is recognised. There is no YouTube process: it is a browser tab or an
 *  installed web app window, and in both cases the only thing that identifies it is the title
 *  the page put there. Browsers append their own name, so this is a substring test rather than
 *  an equality one. */
const YOUTUBE_TITLE = /youtube/i

export type Service = 'spotify' | 'youtube'

/** How each one is written when it is said back. The generic title-casing the other command
 *  files use would produce "Youtube", and a confirmation that misspells the thing it has just
 *  done reads as Ezzy having misheard. */
const DISPLAY: Record<Service, string> = { spotify: 'Spotify', youtube: 'YouTube' }

/** "play spotify", "pause the youtube video", "play music on spotify".
 *
 *  Two shapes, because both are said. "play spotify" is the service as the object; "play the
 *  music on spotify" puts it on the end, which is also the shape `spotify-search` takes for a
 *  real query — so this pattern has to be considered first, or "play music on spotify" is
 *  searched for as if "music" were a band.
 *
 *  `pose` is here for the same reason it is in PLAY_PAUSE: it is what whisper writes for
 *  "pause" spoken in an Ethiopian accent, and it is not a word any of these commands would
 *  otherwise mean. */
const PLAYBACK =
  /^(play|pause|pose|resume|unpause|stop)(?:\s+(?:the|my))?\s+(?:(spotify|you ?tube)(?:\s+(?:music|song|track|audio|video|playback|player))?|(?:the\s+)?(?:music|song|track|audio|video|playback)\s+on\s+(spotify|you ?tube))$/

/** Which verbs mean stop. The rest mean start; there is no third case. */
const PAUSE_VERB = new Set(['pause', 'pose', 'stop'])

/** "next song on spotify", "skip this on youtube", "previous track on spotify".
 *
 *  Only the "on <service>" shape. "next spotify" is not something anyone says, and a pattern
 *  that accepted it would be one more way for a bare "next" to be misread. Without a service
 *  named, `next-track` in builtin.ts handles it and picks the player the same way "play music"
 *  does — so the two halves of skipping behave alike. */
const SKIP_IN =
  /^(next|skip|forward|previous|prev|back|last|go\s+back)(?:\s+(?:the|this|that))?(?:\s+(?:track|song|one|video|episode))?\s+on\s+(spotify|you ?tube)$/

/** Which of those go backwards. */
const BACK_VERB = new Set(['previous', 'prev', 'back', 'last', 'go back'])

/** What the last run did, so the confirmation can say the true one. The registry calls
 *  `describe` immediately after the same command's `run` resolves, one command at a time, so
 *  it cannot be read out of order — the same arrangement, and the same reasoning, as
 *  `lastRun` in media-search.ts. */
let lastRun: 'controlled' | 'opened' = 'controlled'

export function registerPlaybackCommands(resolveTarget: ResolveTarget): void {
  register({
    id: 'playback-in',
    takesTarget: false,
    title: 'Play or pause one app',
    group: 'media',
    summary:
      'Aims playback at Spotify or YouTube by name, for when a music player is running but you want the other one. It only ever resumes or pauses what is already open - it never searches. Saying play spotify with Spotify closed still launches it.',
    examples: [
      'play spotify',
      'pause youtube',
      'pause the youtube video',
      'play the music on spotify'
    ],
    match: PLAYBACK,
    describe: (groups) => {
      const service = DISPLAY[serviceOf(groups)]
      if (lastRun === 'opened') return `Opening ${service}`
      return PAUSE_VERB.has(groups[1]) ? `Pausing ${service}` : `Playing ${service}`
    },
    run: async (groups, ctx) => {
      const service = serviceOf(groups)
      const target = service === 'youtube' ? youtubeWindow() : windowForApp(SPOTIFY)
      if (target) {
        lastRun = 'controlled'
        mediaIn(target.id, target.app, 'play-pause')
        hidePanel()
        return
      }

      // Nothing of that service is open. Pausing it is then a question with no subject, and
      // saying so is a better answer than starting the app the user wanted quietened.
      if (PAUSE_VERB.has(groups[1])) {
        ctx.failed(`${DISPLAY[service]} isn’t open`)
        return
      }

      // "play spotify" with Spotify closed has always launched Spotify, and it still does —
      // the ladder that knows how is handed in rather than reimplemented here, the same
      // arrangement media-search.ts uses and for the same reason.
      lastRun = 'opened'
      log(`playback: no ${service} window, falling back to opening it`)
      await resolveTarget(service, ctx, true)
    }
  })

  // Skipping a track in a named service. Unlike the command above this one never falls back to
  // the launcher: "next song on spotify" with Spotify closed is not a request to start it, it
  // is a request about music that is not playing.
  register({
    id: 'playback-skip-in',
    takesTarget: false,
    title: 'Skip in one app',
    group: 'media',
    summary:
      'Changes track inside Spotify or YouTube by name. Unlike play spotify this never launches anything: skipping in an app that is not running is not a request to start it.',
    examples: ['next song on spotify', 'skip on youtube', 'previous track on spotify'],
    match: SKIP_IN,
    describe: (groups) =>
      `${BACK_VERB.has(groups[1]) ? 'Previous' : 'Next'} track on ${DISPLAY[serviceOf(groups, 2)]}`,
    run: async (groups, ctx) => {
      const service = serviceOf(groups, 2)
      const target = service === 'youtube' ? youtubeWindow() : windowForApp(SPOTIFY)
      if (!target) {
        ctx.failed(`${DISPLAY[service]} isn’t open`)
        return
      }
      mediaIn(target.id, target.app, BACK_VERB.has(groups[1]) ? 'previous' : 'next')
      hidePanel()
    }
  })
}

/** Play/pause, next or previous, aimed at whatever "play music" would have picked — a
 *  dedicated player, then Spotify, and null when neither is running and the bare media key
 *  should have it after all. Returns what it did to, so the confirmation can name it. */
export function mediaToPlayer(action: MediaAction): string | null {
  const player = musicPlayerWindow()
  if (!player) return null
  mediaIn(player.id, player.app, action)
  return player.app
}

/** The service one of these patterns named. PLAYBACK has two shapes and so two groups it
 *  could be in; SKIP_IN has one. `first` says where to start looking. */
function serviceOf(groups: RegExpMatchArray, first = 2): Service {
  const named = groups[first] ?? groups[first + 1] ?? ''
  return /you ?tube/.test(named) ? 'youtube' : 'spotify'
}

/** The window "play music" should be addressed to, or null when nothing on this machine
 *  claims to be a music player and the bare media key should have it after all.
 *
 *  In most-recently-used order within each rung: two players running is a real situation, and
 *  the one the user touched last is the one they mean. */
export function musicPlayerWindow(): EzzyWindow | null {
  const open = listWindows()
  const dedicated = open.find((window) => PLAYERS.has(window.app.toLowerCase()))
  if (dedicated) return dedicated
  return open.find((window) => window.app.toLowerCase() === SPOTIFY) ?? null
}

function windowForApp(exe: string): EzzyWindow | null {
  return listWindows().find((window) => window.app.toLowerCase() === exe) ?? null
}

/** The front-most window with YouTube in its title — a tab, or the installed web app's own
 *  window, which is a browser process either way. */
function youtubeWindow(): EzzyWindow | null {
  return listWindows().find((window) => YOUTUBE_TITLE.test(window.title)) ?? null
}
