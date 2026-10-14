/** Play/pause aimed at a named player, rather than at the machine — a bare media key
 *  goes to whoever most recently owned the media session, which is wrong for "play
 *  music" once Spotify is paused and a browser video has played since. */

import { MediaAction, mediaIn } from '../media-keys'
import { pausePlaying, resumePaused } from '../media-sessions'
import { log, since } from '../verbose'
import { EzzyWindow } from '../../shared/types'
import { listWindows } from '../window-tracker'
import { hidePanel } from '../windows'
import { register } from './registry'
import { ResolveTarget } from './media-search'

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

const SPOTIFY = 'spotify'
const YOUTUBE_TITLE = /youtube/i

export type Service = 'spotify' | 'youtube'

const DISPLAY: Record<Service, string> = { spotify: 'Spotify', youtube: 'YouTube' }

/** "pose" is "pause" in an Ethiopian accent, same as PLAY_PAUSE in builtin.ts. */
const PLAYBACK =
  /^(play|pause|pose|resume|unpause|stop)(?:\s+(?:the|my))?\s+(?:(spotify|you ?tube)(?:\s+(?:music|song|track|audio|video|playback|player))?|(?:the\s+)?(?:music|song|track|audio|video|playback)\s+on\s+(spotify|you ?tube))$/

const PAUSE_VERB = new Set(['pause', 'pose', 'stop'])

const SKIP_IN =
  /^(next|skip|forward|previous|prev|back|last|go\s+back)(?:\s+(?:the|this|that))?(?:\s+(?:track|song|one|video|episode))?\s+on\s+(spotify|you ?tube)$/

const BACK_VERB = new Set(['previous', 'prev', 'back', 'last', 'go back'])

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
    startsPlayback: (groups) => !PAUSE_VERB.has(groups[1]),
    describe: () => lastSaid,
    run: async (groups, ctx) => {
      const service = serviceOf(groups)
      const target = service === 'youtube' ? youtubeWindow() : windowForApp(SPOTIFY)
      if (target) {
        const wanted = PAUSE_VERB.has(groups[1]) ? 'pause' : 'play'
        const did = playOrPause(target, wanted)
        lastSaid = did.said.replace(target.app, DISPLAY[service])
        hidePanel()
        return
      }

      if (PAUSE_VERB.has(groups[1])) {
        ctx.failed(`${DISPLAY[service]} isn’t open`)
        return
      }

      lastSaid = `Opening ${DISPLAY[service]}`
      log(`playback: no ${service} window, falling back to opening it`)
      await resolveTarget(service, ctx, true)
    }
  })

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

/** Only Spotify — it writes the track into its title while playing and its plan name
 *  while not; other players (VLC's "VLC media player" idle) would misread. */
export type Playing = 'playing' | 'paused' | 'unknown'

const SPOTIFY_IDLE = new Set(['', 'free', 'premium'])

export function playbackState(window: EzzyWindow): Playing {
  if (window.app.toLowerCase() !== SPOTIFY) return 'unknown'
  const title = window.title.trim()
  if (!/^spotify\b/i.test(title)) return 'playing'
  return SPOTIFY_IDLE.has(title.slice('spotify'.length).trim().toLowerCase()) ? 'paused' : 'playing'
}

export function mediaToPlayer(action: MediaAction): string | null {
  const player = musicPlayerWindow()
  if (!player) return null
  mediaIn(player.id, player.app, action)
  return player.app
}

/** What a hold stopped: whatever the media-session helper paused, or — when it could not
 *  answer — the one Spotify window the title check found. */
type Ducked = 'sessions' | EzzyWindow | null

let ducking: Promise<Ducked> | null = null

/** Echo cancellation cannot substitute for this — measured, it still let the mic catch
 *  the music and cost 227ms more to open. Pauses everything Windows says is playing, so a
 *  YouTube video or a song in Media Player stops too; see media-sessions.ts. */
export function duckForListening(): void {
  if (ducking) return
  const startedAt = performance.now()
  ducking = pausePlaying().then((apps) => {
    if (apps === null) return duckSpotify()
    if (apps.length === 0) return null
    since(`voice: paused ${apps.join(', ')} so it can hear`, startedAt)
    return 'sessions'
  })
}

/** Settles once the music is back, so a command heard over it ("pause the music") acts on
 *  the player as it was before the hold instead of racing the resume. */
export function restoreAfterListening(): Promise<void> {
  const pending = ducking
  if (!pending) return Promise.resolve()
  ducking = null
  return pending.then(async (ducked) => {
    if (ducked === null) return
    if (ducked === 'sessions') {
      const apps = await resumePaused()
      log(`voice: started ${apps && apps.length > 0 ? apps.join(', ') : 'nothing'} again`)
      return
    }
    mediaIn(ducked.id, ducked.app, 'play')
    log(`voice: started ${ducked.app} again`)
  })
}

/** For a command that started something new: the paused music stays paused for good. The
 *  helper starts a fresh list on its next pause, so a later resume cannot bring it back. */
export function forgetPaused(): void {
  if (!ducking) return
  ducking = null
  log('voice: leaving the paused music off — the command started something else')
}

/** Without the helper (PowerShell blocked by policy), only a player whose state can be read
 *  is touched, and that is Spotify alone. */
function duckSpotify(): EzzyWindow | null {
  const player = windowForApp(SPOTIFY)
  if (!player || playbackState(player) !== 'playing') return null
  mediaIn(player.id, player.app, 'pause')
  log(`voice: paused ${player.app} so it can hear`)
  return player
}

export interface Did {
  said: string
  acted: boolean
}

export function playOrPause(window: EzzyWindow, wanted: 'play' | 'pause'): Did {
  const state = playbackState(window)
  const said = `${wanted === 'play' ? 'Playing' : 'Pausing'} ${window.app}`

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

function serviceOf(groups: RegExpMatchArray, first = 2): Service {
  const named = groups[first] ?? groups[first + 1] ?? ''
  return /you ?tube/.test(named) ? 'youtube' : 'spotify'
}

export function musicPlayerWindow(): EzzyWindow | null {
  const open = listWindows()
  const dedicated = open.find((window) => PLAYERS.has(window.app.toLowerCase()))
  if (dedicated) return dedicated
  return open.find((window) => window.app.toLowerCase() === SPOTIFY) ?? null
}

function windowForApp(exe: string): EzzyWindow | null {
  return listWindows().find((window) => window.app.toLowerCase() === exe) ?? null
}

function youtubeWindow(): EzzyWindow | null {
  return listWindows().find((window) => YOUTUBE_TITLE.test(window.title)) ?? null
}
