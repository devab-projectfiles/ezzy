// Only networks Windows has already saved — Ezzy never handles a password, adds a profile,
// toggles the radio, or needs admin. Nothing from a transcript reaches a command line:
// `connectTo` is only ever given a name from `savedProfiles()`, passed to `execFile` as an
// argv element, so there is no shell to parse it.

import { execFile } from 'child_process'
import { log, since } from './verbose'

const NETSH_TIMEOUT_MS = 5_000
const CONNECT_TIMEOUT_MS = 8_000
const CONNECT_POLL_MS = 500

let profiles: string[] = []
let loaded = false

export async function savedProfiles(): Promise<string[]> {
  if (!loaded) await refreshProfiles()
  return profiles
}

export async function refreshProfiles(): Promise<void> {
  const startedAt = performance.now()
  const output = await netsh(['wlan', 'show', 'profiles'])
  loaded = true
  if (output === null) {
    profiles = []
    return
  }
  const found: string[] = []
  // Structure, not vocabulary: netsh's output is localised, so this reads an indented
  // "label : value" line rather than any translated label text.
  for (const line of output.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon === -1 || !/^\s/.test(line)) continue
    const value = line.slice(colon + 1).trim()
    if (value === '' || found.includes(value)) continue
    found.push(value)
  }
  profiles = found
  since(`wifi: ${profiles.length} saved networks`, startedAt)
}

export async function currentNetwork(): Promise<string | null> {
  const output = await netsh(['wlan', 'show', 'interfaces'])
  if (output === null) return null
  const found = /^[^\S\r\n]*SSID[^\S\r\n]*:[^\S\r\n]*(.+?)[^\S\r\n]*$/m.exec(output)
  return found ? found[1] : null
}

// The exit code alone says nothing: a radio that's off, a network out of range, a wrong key
// all return success and do nothing, so this polls the interface instead.
export async function connectTo(profile: string): Promise<boolean> {
  const startedAt = performance.now()
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

export function matchProfile(spoken: string, saved: string[]): string | null {
  const needle = simplify(spoken)
  if (needle === '') return null

  const exact = saved.filter((name) => simplify(name) === needle)
  if (exact.length === 1) return exact[0]

  const prefix = saved.filter((name) => simplify(name).startsWith(needle))
  if (prefix.length === 1) return prefix[0]

  const anywhere = saved.filter((name) => simplify(name).includes(needle))
  if (anywhere.length === 1) return anywhere[0]

  // More than one candidate is not a match — picking the first would be a coin toss.
  return null
}

function simplify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}
