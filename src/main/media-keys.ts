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

import { tapExtendedKey } from './win32'
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

export function nextTrack(): void {
  log('media: next track')
  tapExtendedKey(VK_MEDIA_NEXT_TRACK)
}

export function previousTrack(): void {
  log('media: previous track')
  tapExtendedKey(VK_MEDIA_PREV_TRACK)
}
