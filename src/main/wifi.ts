/** Saved WiFi networks, through `netsh`.
 *
 *  The scope is the design: only networks Windows has already saved — Ezzy never handles
 *  a password, adds a profile, toggles the radio, or needs admin.
 *
 *  Nothing from a transcript reaches a command line. `connectTo` is only ever given a
 *  name that came out of `savedProfiles()`, and arguments go to `execFile` as argv
 *  elements, so there is no shell to parse them.
 *
 *  `netsh` output is localised, so nothing here reads a word of it — the labels are
 *  translated on a non-English Windows, but the structure is not: a profile line is an
 *  indented `label : value`, so the value is whatever follows the first colon. `SSID` and
 *  `BSSID` survive translation as acronyms, and the anchor tells them apart. */

import { execFile } from 'child_process'
import { log, since } from './verbose'

/** netsh answers in well under a second; anything longer is a wedged adapter, and a
 *  voice command must not wait on one. */
const NETSH_TIMEOUT_MS = 5_000

/** How long to wait for an association — `netsh` returns 0 for "request accepted"
 *  rather than "connected", so success is confirmed by watching, not the exit code. */
const CONNECT_TIMEOUT_MS = 8_000
const CONNECT_POLL_MS = 500

let profiles: string[] = []
let loaded = false

/** The saved networks, from the cache after the first call. Read on first use rather
 *  than at startup — most sessions never touch this, so the cost lands on the first
 *  "connect to …" instead. */
export async function savedProfiles(): Promise<string[]> {
  if (!loaded) await refreshProfiles()
  return profiles
}

/** Re-read them. Called after a name fails to match, since the likeliest reason is a
 *  network saved since Ezzy started. */
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
    // Structure, not vocabulary: an indented "label : value" — a section heading ends
    // at its colon with nothing behind it, so it drops out here rather than being named.
    const colon = line.indexOf(':')
    if (colon === -1 || !/^\s/.test(line)) continue
    const value = line.slice(colon + 1).trim()
    if (value === '' || found.includes(value)) continue
    found.push(value)
  }
  profiles = found
  since(`wifi: ${profiles.length} saved networks`, startedAt)
}

/** The network currently joined, or null. Anchored so `BSSID` cannot answer for `SSID`.
 *  When nothing is connected the line is absent entirely, so its absence is the answer. */
export async function currentNetwork(): Promise<string | null> {
  const output = await netsh(['wlan', 'show', 'interfaces'])
  if (output === null) return null
  const found = /^[^\S\r\n]*SSID[^\S\r\n]*:[^\S\r\n]*(.+?)[^\S\r\n]*$/m.exec(output)
  return found ? found[1] : null
}

/** Join a saved network and wait to see it happen — the exit code alone says nothing:
 *  a radio that is off, a network out of range, a wrong key all return success and do
 *  nothing. Polling the interface is the only honest answer. */
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

/** Which saved network a spoken name means, or null. Generous in the middle, strict at
 *  the edges — network names are not words ("Galaxy A20s1370p"), so a user saying
 *  "galaxy" has to reach a name they would never dictate in full, but an ambiguous name
 *  must not guess: it opens the network list instead, since connecting to the wrong
 *  saved network is a real and silent failure. */
export function matchProfile(spoken: string, saved: string[]): string | null {
  const needle = simplify(spoken)
  if (needle === '') return null

  const exact = saved.filter((name) => simplify(name) === needle)
  if (exact.length === 1) return exact[0]

  const prefix = saved.filter((name) => simplify(name).startsWith(needle))
  if (prefix.length === 1) return prefix[0]

  const anywhere = saved.filter((name) => simplify(name).includes(needle))
  if (anywhere.length === 1) return anywhere[0]

  // More than one candidate is not a match — picking the first would be a coin toss
  // with the user's connection.
  return null
}

/** Down to the letters and digits both sides have in common — hyphens, underscores and
 *  spaces are things a speaker never says and whisper never writes the same way twice. */
function simplify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}
