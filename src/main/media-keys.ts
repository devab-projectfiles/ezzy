/** The media keys, sent as `keybd_event` with the VK_MEDIA_* codes — the OS-level thing
 *  every player already listens for. Windows hands it to whichever app owns the current
 *  media session, so nothing here checks what is playing; the app that cares decides.
 *  `keybd_event` returns void, so the confirmation says what Ezzy did, not what happened. */

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

/** A media command addressed to ONE window, rather than to the machine — the bare keys
 *  above go to whoever most recently owned the media session, so with Spotify paused and
 *  a video watched since, "play music" resumed the video instead. WM_APPCOMMAND is the
 *  same command with a recipient on it.
 *
 *  Play and pause are separate here, where the recipient is known to honour them — on
 *  Spotify, 46 starts and 47 stops, each only its own half, which is what lets the
 *  confirmation be true rather than a guess (a toggle made "play music" answer "Playing"
 *  while it was actually pausing). The toggle stays for "toggle"/"play/pause", which
 *  genuinely mean either. Neither play/pause nor skip is reportable either way — the
 *  message is posted, and what the player made of it never comes back. */
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
