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

/** Exactly what the last run did, in the words to say back. The registry calls `describe`
 *  immediately after the same command's `run` resolves, one command at a time, so it cannot be
 *  read out of order — the same arrangement, and the same reasoning, as `lastRun` in
 *  media-search.ts.
 *
 *  A whole sentence rather than a flag, because what happened is no longer a function of what
 *  was said: "play spotify" can come back as "Playing Spotify", as "Spotify is already
 *  playing", or as "Opening Spotify", and only `run` knows which. */
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
    // Same as `play-pause` in builtin.ts: what happened rather than what was asked for. The
    // sentence is built in `run`, because with a toggle the two were not the same event.
    describe: () => lastSaid,
    run: async (groups, ctx) => {
      const service = serviceOf(groups)
      const target = service === 'youtube' ? youtubeWindow() : windowForApp(SPOTIFY)
      if (target) {
        const wanted = PAUSE_VERB.has(groups[1]) ? 'pause' : 'play'
        // Named by the service the user asked for rather than by the window's process, or
        // "pause youtube" would answer "Pausing Chrome" — true, and not what was asked about.
        const did = playOrPause(target, wanted)
        lastSaid = did.said.replace(target.app, DISPLAY[service])
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
      lastSaid = `Opening ${DISPLAY[service]}`
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

/** What a player is doing, when it can be told from the outside.
 *
 *  Spotify writes the track into its own window title while it plays and its plan name —
 *  "Spotify Free", "Spotify Premium", or just "Spotify" — while it does not. Measured on this
 *  machine: paused it read "Spotify Free", and a moment after being started, "J. Cole - Run A
 *  Train (with Future)".
 *
 *  Only Spotify. Other players put other things in their titles — VLC sits at "VLC media
 *  player" when idle, which this rule would read as a track — so everything else is `unknown`
 *  and gets the older behaviour rather than a confident wrong answer. */
export type Playing = 'playing' | 'paused' | 'unknown'

/** What is left of a Spotify title once its own name is taken off, for the states that are not
 *  a track. Lower-cased before comparison. */
const SPOTIFY_IDLE = new Set(['', 'free', 'premium'])

export function playbackState(window: EzzyWindow): Playing {
  if (window.app.toLowerCase() !== SPOTIFY) return 'unknown'
  const title = window.title.trim()
  if (!/^spotify\b/i.test(title)) return 'playing'
  return SPOTIFY_IDLE.has(title.slice('spotify'.length).trim().toLowerCase()) ? 'paused' : 'playing'
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

/** The player Ezzy paused so it could hear, or null when it has not paused anything. */
let ducked: EzzyWindow | null = null

/** Quiet the music for as long as Ezzy is listening.
 *
 *  Echo cancellation cannot do this — measured, twice: with it on the microphone still caught
 *  the music and whisper turned it into a command nobody gave, and the device took 227ms
 *  longer to open. Chromium cancels against what IT renders and Spotify is another process,
 *  so there is nothing to subtract. See the note in recorder.ts.
 *
 *  So the music stops instead, for the couple of seconds the recording lasts. Only a player
 *  whose state can actually be read is touched, which today means Spotify: pausing something
 *  that only MIGHT be playing would leave it stopped afterwards, and a launcher that silently
 *  stops your music is worse than one that mishears a command. */
export function duckForListening(): void {
  if (ducked) return
  const player = musicPlayerWindow()
  if (!player || playbackState(player) !== 'playing') return
  mediaIn(player.id, player.app, 'pause')
  ducked = player
  log(`voice: paused ${player.app} so it can hear`)
}

/** Start it again. Called when the recording ends rather than when the command finishes, so
 *  the gap is the length of the recording and not of the transcription that follows it — and
 *  so a media command runs against the state the user could actually see. */
export function restoreAfterListening(): void {
  const player = ducked
  if (!player) return
  ducked = null
  mediaIn(player.id, player.app, 'play')
  log(`voice: started ${player.app} again`)
}

/** What happened, said in the words of what actually happened.
 *
 *  This is the whole of the fix for a confirmation that used to repeat the request back: with
 *  a toggle, "play music" while music was playing paused it and Ezzy said "Playing". Now the
 *  half that was asked for is the half that is sent, and where the player's state can be read
 *  the answer knows whether there was anything to do at all. */
export interface Did {
  said: string
  /** False when nothing needed doing, so nothing was sent. */
  acted: boolean
}

export function playOrPause(window: EzzyWindow, wanted: 'play' | 'pause'): Did {
  const state = playbackState(window)
  const said = `${wanted === 'play' ? 'Playing' : 'Pausing'} ${window.app}`

  // A recipient whose state cannot be read gets the toggle, not the half that was asked for.
  // Spotify was measured honouring 46 and 47 separately; nothing else here has been, and a
  // "pause" that silently does nothing is worse than one that toggles. Verified against a
  // browser: sending 47 to a Chrome window playing a video did not stop it. Since the state
  // is unknown either way, the sentence is the user's own verb, exactly as it was before.
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
