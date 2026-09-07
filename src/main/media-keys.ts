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
  APPCOMMAND_MEDIA_PAUSE,
  APPCOMMAND_MEDIA_PLAY,
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
export type MediaAction = 'play' | 'pause' | 'play-pause' | 'next' | 'previous'

const APPCOMMAND: Record<MediaAction, number> = {
  play: APPCOMMAND_MEDIA_PLAY,
  pause: APPCOMMAND_MEDIA_PAUSE,
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
 *  **Play and pause are separate here, where the recipient is known to honour them.** The
 *  toggle was the only thing sent for a while, on the reasoning that a "play" which silently
 *  does nothing is worse than one which pauses something already playing. That reasoning was
 *  never measured, and it was wrong for the player this is mostly aimed at: on Spotify, 46
 *  starts and 47 stops, each doing only its own half.
 *
 *  It matters because a toggle makes the confirmation a guess. Saying "play music" while
 *  music was playing paused it and Ezzy said "Playing" — reported as a bug, and it was one.
 *  Sending the half that was asked for makes the sentence true by construction. The toggle is
 *  still here for "toggle" and "play/pause", which genuinely mean either.
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
