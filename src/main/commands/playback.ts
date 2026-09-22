/** Play/pause aimed at a named player, rather than at the machine.
 *
 *  A bare media key goes to whichever app most recently owned the media session — right
 *  for "next track", wrong for "play music" when Spotify sits paused and a browser video
 *  was watched since. So the recipient is chosen here and posted to that window (see
 *  `playPauseIn` in media-keys.ts). Two rules cover everything:
 *
 *   * "play music" picks the player: a dedicated music app if running, Spotify if not,
 *     then the bare media key — where a browser video ends up, since nothing else claimed it.
 *   * Naming the service overrides that: "play spotify" reaches Spotify even while a music
 *     player is running, and "play youtube" reaches the video even while Spotify is.
 *
 *  Neither rule starts anything new — that is media-search.ts. The one exception is a
 *  named service with no window at all, which falls back to the launcher. */

import { MediaAction, mediaIn } from '../media-keys'
import { log } from '../verbose'
import { EzzyWindow } from '../../shared/types'
import { listWindows } from '../window-tracker'
import { hidePanel } from '../windows'
import { register } from './registry'
import { ResolveTarget } from './media-search'

/** Applications that exist to play audio, matched against the owning executable's name as
 *  the window tracker prettifies it (`Spotify.exe` -> "Spotify"). A closed list, the same
 *  choice system.ts makes about settings pages — a name not on it simply is not a music
 *  player as far as Ezzy is concerned, and the bare media key still reaches it. */
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

/** Second in line behind the list above, deliberately not in it — the fallback the user
 *  asked for, and also the one they can name to jump the queue. */
const SPOTIFY = 'spotify'

/** There is no YouTube process — it is a browser tab or an installed web app window, and
 *  the title is all that identifies it. A substring test since browsers append their own
 *  name too. */
const YOUTUBE_TITLE = /youtube/i

export type Service = 'spotify' | 'youtube'

/** Title-casing "youtube" the generic way other command files do would produce
 *  "Youtube", which reads as a misheard confirmation. */
const DISPLAY: Record<Service, string> = { spotify: 'Spotify', youtube: 'YouTube' }

/** "play spotify", "pause the youtube video", "play music on spotify" — two shapes, since
 *  both are said, and the "on spotify" one has to be considered before `spotify-search`'s
 *  pattern reads "music" as a band.
 *
 *  "pose" is "pause" in an Ethiopian accent, same as PLAY_PAUSE in builtin.ts. */
const PLAYBACK =
  /^(play|pause|pose|resume|unpause|stop)(?:\s+(?:the|my))?\s+(?:(spotify|you ?tube)(?:\s+(?:music|song|track|audio|video|playback|player))?|(?:the\s+)?(?:music|song|track|audio|video|playback)\s+on\s+(spotify|you ?tube))$/

/** Which verbs mean stop; the rest mean start. */
const PAUSE_VERB = new Set(['pause', 'pose', 'stop'])

/** "next song on spotify", "skip this on youtube", "previous track on spotify" — only the
 *  "on <service>" shape. Without a service named, next-track in builtin.ts handles it and
 *  picks the player the way "play music" does, so the two halves of skipping agree. */
const SKIP_IN =
  /^(next|skip|forward|previous|prev|back|last|go\s+back)(?:\s+(?:the|this|that))?(?:\s+(?:track|song|one|video|episode))?\s+on\s+(spotify|you ?tube)$/

/** Which of those go backwards. */
const BACK_VERB = new Set(['previous', 'prev', 'back', 'last', 'go back'])

/** What the last run did, read by `describe` right after `run` for the same command
 *  resolves — a whole sentence rather than a flag, since "play spotify" can come back as
 *  "Playing Spotify", "Spotify is already playing", or "Opening Spotify". */
let lastSaid = 'Play/pause'

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
    describe: () => lastSaid,
    run: async (groups, ctx) => {
      const service = serviceOf(groups)
      const target = service === 'youtube' ? youtubeWindow() : windowForApp(SPOTIFY)
      if (target) {
        const wanted = PAUSE_VERB.has(groups[1]) ? 'pause' : 'play'
        // Named by the service asked for, not the window's process — "pause youtube"
        // should not answer "Pausing Chrome".
        const did = playOrPause(target, wanted)
        lastSaid = did.said.replace(target.app, DISPLAY[service])
        hidePanel()
        return
      }

      // Nothing of that service is open — pausing it is a question with no subject.
      if (PAUSE_VERB.has(groups[1])) {
        ctx.failed(`${DISPLAY[service]} isn’t open`)
        return
      }

      // "play spotify" with Spotify closed launches it — the ladder that knows how is
      // handed in rather than reimplemented here, same as media-search.ts does.
      lastSaid = `Opening ${DISPLAY[service]}`
      log(`playback: no ${service} window, falling back to opening it`)
      await resolveTarget(service, ctx, true)
    }
  })

  // Unlike the command above, this one never falls back to the launcher: "next song on
  // spotify" with Spotify closed is not a request to start it.
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

/** What a player is doing, when it can be told from the outside. Only Spotify: it writes
 *  the track into its title while playing and its plan name ("Spotify Free", "Spotify
 *  Premium") while not — other players put other things there (VLC idles at "VLC media
 *  player", which this rule would misread as a track), so everything else is `unknown`. */
export type Playing = 'playing' | 'paused' | 'unknown'

/** What is left of a Spotify title once its own name is removed, for the non-track states. */
const SPOTIFY_IDLE = new Set(['', 'free', 'premium'])

export function playbackState(window: EzzyWindow): Playing {
  if (window.app.toLowerCase() !== SPOTIFY) return 'unknown'
  const title = window.title.trim()
  if (!/^spotify\b/i.test(title)) return 'playing'
  return SPOTIFY_IDLE.has(title.slice('spotify'.length).trim().toLowerCase()) ? 'paused' : 'playing'
}

/** Play/pause, next or previous, aimed at whatever "play music" would have picked — null
 *  when neither a dedicated player nor Spotify is running and the bare media key should
 *  have it after all. Returns what it did to, so the confirmation can name it. */
export function mediaToPlayer(action: MediaAction): string | null {
  const player = musicPlayerWindow()
  if (!player) return null
  mediaIn(player.id, player.app, action)
  return player.app
}

/** The player Ezzy paused so it could hear, or null when it has not paused anything. */
let ducked: EzzyWindow | null = null

/** Quiet the music for as long as Ezzy is listening. Echo cancellation cannot do this
 *  (measured twice — the mic still caught the music, and the device took 227ms longer to
 *  open; see recorder.ts), so the music stops instead. Only a player whose state can
 *  actually be read is touched (today, Spotify) — pausing something that only MIGHT be
 *  playing would leave it stopped afterwards. */
export function duckForListening(): void {
  if (ducked) return
  const player = musicPlayerWindow()
  if (!player || playbackState(player) !== 'playing') return
  mediaIn(player.id, player.app, 'pause')
  ducked = player
  log(`voice: paused ${player.app} so it can hear`)
}

/** Start it again. Called when the recording ends rather than when the command finishes,
 *  so the gap is the length of the recording, not the transcription after it. */
export function restoreAfterListening(): void {
  const player = ducked
  if (!player) return
  ducked = null
  mediaIn(player.id, player.app, 'play')
  log(`voice: started ${player.app} again`)
}

/** What happened, said in the words of what actually happened — the fix for a
 *  confirmation that used to repeat the request: with a toggle, "play music" while music
 *  was playing paused it, and Ezzy said "Playing". Now the half actually sent is the half
 *  said, and where the player's state can be read the answer knows if anything happened. */
export interface Did {
  said: string
  /** False when nothing needed doing, so nothing was sent. */
  acted: boolean
}

export function playOrPause(window: EzzyWindow, wanted: 'play' | 'pause'): Did {
  const state = playbackState(window)
  const said = `${wanted === 'play' ? 'Playing' : 'Pausing'} ${window.app}`

  // A recipient whose state cannot be read gets the toggle, not the half asked for —
  // Spotify honours play/pause separately; nothing else here has been verified to, and
  // sending "pause" to something that silently ignores it is worse than a toggle.
  if (state === 'unknown') {
    mediaIn(window.id, window.app, 'play-pause')
    return { said, acted: true }
  }

  const already = wanted === 'play' ? 'playing' : 'paused'
  if (state === already) {
    return { said: `${window.app} is already ${already}`, acted: false }
  }
  mediaIn(window.id, window.app, wanted)
  return { said, acted: true }
}

/** The service one of these patterns named. PLAYBACK has two shapes and so two groups it
 *  could be in; SKIP_IN has one. `first` says where to start looking. */
function serviceOf(groups: RegExpMatchArray, first = 2): Service {
  const named = groups[first] ?? groups[first + 1] ?? ''
  return /you ?tube/.test(named) ? 'youtube' : 'spotify'
}

/** The window "play music" should be addressed to, or null when nothing claims to be a
 *  music player. Most-recently-used order within each rung, since two players running is
 *  a real situation and the one touched last is the one meant. */
export function musicPlayerWindow(): EzzyWindow | null {
  const open = listWindows()
  const dedicated = open.find((window) => PLAYERS.has(window.app.toLowerCase()))
  if (dedicated) return dedicated
  return open.find((window) => window.app.toLowerCase() === SPOTIFY) ?? null
}

function windowForApp(exe: string): EzzyWindow | null {
  return listWindows().find((window) => window.app.toLowerCase() === exe) ?? null
}

/** The front-most window with YouTube in its title — a tab or the web app's own window,
 *  a browser process either way. */
function youtubeWindow(): EzzyWindow | null {
  return listWindows().find((window) => YOUTUBE_TITLE.test(window.title)) ?? null
}
