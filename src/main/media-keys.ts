/** The media keys, sent as `keybd_event` with the VK_MEDIA_* codes.
 *
 *  There is no integration here and there is not meant to be — the plan lists per-app APIs as an
 *  explicit non-goal. A media key is the OS-level thing every player already listens for:
 *  Windows hands it to whichever app owns the current media session, so "next" reaches
 *  Spotify, or a YouTube tab, or whatever was playing last, without Ezzy knowing any of them
 *  exist. That is also why nothing here checks whether anything is playing — the key is fired
 *  the same way a keyboard would fire it, and the app that cares decides.
 *
 *  `keybd_event` returns void: there is no failure to report. The confirmation therefore says
 *  what Ezzy did, not what happened to the music. */

import {
  APPCOMMAND_MEDIA_NEXTTRACK,
  APPCOMMAND_MEDIA_PLAY_PAUSE,
  APPCOMMAND_MEDIA_PREVIOUSTRACK,
  Hwnd,
  postAppCommand,
  tapExtendedKey
} from './win32'
import { log } from './verbose'

const VK_MEDIA_NEXT_TRACK = 0xb0
const VK_MEDIA_PREV_TRACK = 0xb1
const VK_MEDIA_PLAY_PAUSE = 0xb3

/** Toggles: the same key both starts and stops, which is why the commands that use it echo
 *  the user's own verb rather than claiming to know which one just happened. */
export function playPause(): void {
  log('media: play/pause')
  tapExtendedKey(VK_MEDIA_PLAY_PAUSE)
}

/** The three media commands as one word each, since every caller wants to name what it is
 *  doing rather than which constant it is sending. */
export type MediaAction = 'play-pause' | 'next' | 'previous'

const APPCOMMAND: Record<MediaAction, number> = {
  'play-pause': APPCOMMAND_MEDIA_PLAY_PAUSE,
  next: APPCOMMAND_MEDIA_NEXTTRACK,
  previous: APPCOMMAND_MEDIA_PREVIOUSTRACK
}

/** A media command addressed to ONE window, rather than to the machine.
 *
 *  The bare keys above go wherever Windows decides, which is whichever app most recently owned
 *  the media session — so with Spotify paused and a video watched since, "play music" resumed
 *  the video and "next track" skipped it. WM_APPCOMMAND is the same command with a recipient
 *  on it: every player handles it, because it is what a media key becomes after Windows has
 *  picked who it is for.
 *
 *  Play/pause stays a toggle even here. APPCOMMAND_MEDIA_PLAY and APPCOMMAND_MEDIA_PAUSE
 *  exist and would say which was meant, but they are not honoured everywhere the toggle is,
 *  and a "play" that silently does nothing is a worse answer than a "play" that pauses
 *  something already playing. Ezzy cannot read what a player is doing, so the confirmation
 *  echoes the user's verb rather than claiming to know.
 *
 *  Skipping can genuinely do nothing — a single video with no playlist behind it has no next
 *  track — and that is not reportable either, for the same reason: the message is posted, and
 *  what the player made of it never comes back. */
export function mediaIn(hwnd: Hwnd, name: string, action: MediaAction): void {
  log(`media: ${action} -> ${name} (${hwnd})`)
  postAppCommand(hwnd, APPCOMMAND[action])
}

export function nextTrack(): void {
  log('media: next track')
  tapExtendedKey(VK_MEDIA_NEXT_TRACK)
}

export function previousTrack(): void {
  log('media: previous track')
  tapExtendedKey(VK_MEDIA_PREV_TRACK)
}
