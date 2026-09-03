/** Saved WiFi networks, through `netsh` (FEATURE-system-commands.md).
 *
 *  **The scope limit is the design.** Only networks Windows has already saved: Ezzy never
 *  handles a password, never adds a profile, never toggles the radio, and never needs admin.
 *  Everything here is something the user could type themselves.
 *
 *  **Nothing from a transcript reaches a command line.** `connectTo` is only ever given a name
 *  that came out of `savedProfiles()`, and the arguments go to `execFile` as argv elements, so
 *  there is no shell to parse them. A misheard SSID can fail to match; it cannot become a
 *  command.
 *
 *  **`netsh` output is localised, so nothing here reads a word of it.** The labels on the left
 *  of the colon are translated on a non-English Windows, and matching "All User Profile" would
 *  silently return zero networks on one. The structure is not translated: a profile line is an
 *  indented `label : value`, so the value is what follows the first colon. `SSID` and `BSSID`
 *  are acronyms that survive translation, and the anchor tells them apart. */

import { execFile } from 'child_process'
import { log, since } from './verbose'

/** netsh answers in well under a second; anything longer is a wedged adapter, and a voice
 *  command must not wait on one. */
const NETSH_TIMEOUT_MS = 5_000

/** How long to wait for an association after asking for one. The feature note measures a
 *  connect at 2-5s, and `netsh` returns 0 for "request accepted" rather than "connected" — so
 *  success is confirmed by watching, not by the exit code. */
const CONNECT_TIMEOUT_MS = 8_000
const CONNECT_POLL_MS = 500

let profiles: string[] = []
let loaded = false

/** The saved networks, from the cache after the first call.
 *
 *  Read on first use rather than at startup: this is a feature many sessions never touch, and
 *  §7's cold-start budget should not include a process spawn for one of them. The cost lands
 *  on the first "connect to …" instead, once. */
export async function savedProfiles(): Promise<string[]> {
  if (!loaded) await refreshProfiles()
  return profiles
}

/** Re-read them. Called after a name fails to match, because the likeliest reason for that is
 *  a network saved since Ezzy started. */
export async function refreshProfiles(): Promise<void> {
  const startedAt = performance.now()
  const output = await netsh(['wlan', 'show', 'profiles'])
  loaded = true
  if (output === null) {
    profiles = []
    return
  }
  const found: string[] = []
  for (const line of output.split(/\r?\n/)) {
    // Structure, not vocabulary: an indented "label : value". A section heading ends at its
    // colon and leaves nothing behind it, so it drops out here rather than being named.
    const colon = line.indexOf(':')
    if (colon === -1 || !/^\s/.test(line)) continue
    const value = line.slice(colon + 1).trim()
    if (value === '' || found.includes(value)) continue
    found.push(value)
  }
  profiles = found
  since(`wifi: ${profiles.length} saved networks`, startedAt)
}

/** The network currently joined, or null when the adapter is not associated with one.
 *
 *  Anchored so `BSSID` cannot answer for `SSID`. When nothing is connected the line is absent
 *  entirely, which is why its absence is the answer rather than a state word that would have
 *  to be read in the user's language. */
export async function currentNetwork(): Promise<string | null> {
  const output = await netsh(['wlan', 'show', 'interfaces'])
  if (output === null) return null
  const found = /^[^\S\r\n]*SSID[^\S\r\n]*:[^\S\r\n]*(.+?)[^\S\r\n]*$/m.exec(output)
  return found ? found[1] : null
}

/** Join a saved network and wait to see it happen.
 *
 *  `netsh` exits 0 for "request accepted", so the exit code says nothing about whether the
 *  machine actually associated — a radio that is off, a network out of range and a wrong key
 *  all return success and then quietly do nothing. Polling the interface is the only honest
 *  answer, and it is also what makes "it did not work" reportable instead of silent. */
export async function connectTo(profile: string): Promise<boolean> {
  const startedAt = performance.now()
  // `name=` as one argv element: no quoting, no shell, and the value came from netsh itself.
  const accepted = await netsh(['wlan', 'connect', `name=${profile}`])
  if (accepted === null) return false

  const deadline = Date.now() + CONNECT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(CONNECT_POLL_MS)
    if ((await currentNetwork()) === profile) {
      since(`wifi: connected to ${profile}`, startedAt)
      return true
    }
  }
  log(`wifi: asked for ${profile} but never associated`)
  return false
}

function netsh(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('netsh', args, { windowsHide: true, timeout: NETSH_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        console.error(`[ezzy] netsh ${args.join(' ')} failed:`, error.message)
        resolve(null)
        return
      }
      resolve(stdout)
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Which saved network a spoken name means, or null.
 *
 *  Exported for its own sake: §10 puts resolution in the layer worth testing, and this is the
 *  part of the feature that decides what the machine connects to.
 *
 *  Deliberately generous in the middle and strict at the edges. Network names are not words —
 *  "Galaxy A20s1370p", "AAU-SFA-Student" — and whisper renders them as whatever it can, so a
 *  user saying "galaxy" has to reach a name they would never dictate in full. What it must not
 *  do is guess: an ambiguous name is answered by opening the network list, because connecting
 *  to a neighbour's saved network is a real failure and a silent one. */
export function matchProfile(spoken: string, saved: string[]): string | null {
  const needle = simplify(spoken)
  if (needle === '') return null

  const exact = saved.filter((name) => simplify(name) === needle)
  if (exact.length === 1) return exact[0]

  const prefix = saved.filter((name) => simplify(name).startsWith(needle))
  if (prefix.length === 1) return prefix[0]

  const anywhere = saved.filter((name) => simplify(name).includes(needle))
  if (anywhere.length === 1) return anywhere[0]

  // More than one candidate is not a match. "aau" names six networks here, and picking the
  // first would be a coin toss with the user's connection.
  return null
}

/** Down to the letters and digits both sides have in common. Hyphens, underscores and spaces
 *  are things a speaker never says and whisper never writes the same way twice. */
function simplify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}
