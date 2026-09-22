/** Starting things. Three ways in: an indexed app, a file path, a URL. Focusing a live
 *  window is a fourth and lives in focus.ts instead. All three here go through Explorer. */

import { execFile } from 'child_process'
import { existsSync, statSync } from 'fs'
import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { dirname, isAbsolute, join, normalize } from 'path'
import { shell } from 'electron'
import { DirectTarget } from '../shared/types'
import { findApp } from './app-index'
import { log } from './verbose'

/** Not `shell.openPath`/`shell.openExternal` — both call ShellExecute in our own
 *  process, which passes our dev environment (NODE_ENV etc.) to the child and has broken
 *  other Electron apps that branch on it. `explorer.exe` forwards to the shell process
 *  already running and the app inherits its clean environment instead. */
function handOff(what: string, label: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile('explorer.exe', [what], { windowsHide: true })
    child.once('error', (err) => {
      console.error(`[ezzy] could not open ${label}:`, err)
      resolve(false)
    })
    child.once('spawn', () => {
      log(`opened ${label}`)
      resolve(true)
    })
  })
}

export async function launchApp(id: string): Promise<boolean> {
  const entry = findApp(id)
  if (!entry) {
    console.error(`[ezzy] refused to launch an unknown app: ${id}`)
    return false
  }
  const what =
    entry.launch.kind === 'shortcut' ? entry.launch.path : `shell:AppsFolder\\${entry.launch.appId}`
  return handOff(what, entry.name)
}

export async function openMicrophoneSettings(): Promise<boolean> {
  return handOff('ms-settings:privacy-microphone', 'microphone settings')
}

/** Not for search URLs — Explorer silently drops any URI carrying a query string; see
 *  `openProtocolUri`. */
export async function openShellTarget(uri: string, label: string): Promise<boolean> {
  return handOff(uri, label)
}

/** Open a URL inside an installed browser app window rather than as a tab. The browser
 *  is supposed to route its own installed-app links but does not reliably do so, so this
 *  asks for the app window directly via `--app=<url>`. Chrome-family only. */
export async function openUrlInWebApp(
  appName: string,
  url: string,
  label: string
): Promise<boolean> {
  const app = await findWebApp(appName)
  if (app === null) return false
  const args = app.profile === null ? [] : [`--profile-directory=${app.profile}`]
  args.push(`--app=${url}`)
  return new Promise((resolve) => {
    const child = execFile(app.exe, args, { windowsHide: true, env: shellEnvironment() })
    child.once('error', (err) => {
      console.error(`[ezzy] could not open ${label} in its app window:`, err)
      resolve(false)
    })
    child.once('spawn', () => {
      log(`opened ${label} in the ${appName} app window`)
      resolve(true)
    })
  })
}

interface WebApp {
  exe: string
  profile: string | null
  shortcut: string
}

/** Checked against its shortcut on every use, never cached beyond that — `--app=` opens
 *  app mode for any URL, so a stale entry would silently keep working after an uninstall. */
const webApps = new Map<string, WebApp>()

async function findWebApp(appName: string): Promise<WebApp | null> {
  const cached = webApps.get(appName)
  if (cached && existsSync(cached.shortcut)) return cached
  if (cached) {
    log(`the ${appName} app is gone; its shortcut no longer exists`)
    webApps.delete(appName)
  }

  const roots = [
    join(process.env['APPDATA'] ?? '', 'Microsoft\\Windows\\Start Menu\\Programs\\Chrome Apps'),
    join(process.env['APPDATA'] ?? '', 'Microsoft\\Windows\\Start Menu\\Programs')
  ]
  let found: WebApp | null = null

  for (const root of roots) {
    let entries: string[] = []
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.lnk')) continue
      if (!entry.slice(0, -4).toLowerCase().includes(appName.toLowerCase())) continue
      try {
        const link = shell.readShortcutLink(join(root, entry))
        if (!link.args?.includes('--app-id=')) continue
        const profile = /--profile-directory="?([^"\s]+)"?/.exec(link.args ?? '')
        found = {
          exe: join(dirname(link.target), 'chrome.exe'),
          profile: profile ? profile[1] : null,
          shortcut: join(root, entry)
        }
        break
      } catch {
        // Not a shell link we can read.
      }
    }
    if (found) break
  }

  if (found === null) {
    log(`no installed web app found for "${appName}"`)
    return null
  }
  webApps.set(appName, found)
  return found
}

/** Explorer cannot deliver a custom scheme or a URL with a query string, so this reads
 *  the registered handler and runs it directly, with the dev environment stripped. */
export async function openProtocolUri(
  scheme: string,
  uri: string,
  label: string
): Promise<boolean> {
  const command = await registeredHandler(scheme)
  if (command === null) {
    log(`nothing is registered for ${scheme}:`)
    return false
  }
  const [exe, ...args] = tokenise(command)
  if (exe === undefined) return false
  return new Promise((resolve) => {
    const child = execFile(
      exe,
      args.map((arg) => arg.replace('%1', uri)),
      { windowsHide: true, env: shellEnvironment() }
    )
    child.once('error', (err) => {
      console.error(`[ezzy] could not open ${label}:`, err)
      resolve(false)
    })
    child.once('spawn', () => {
      log(`opened ${label} through the ${scheme}: handler`)
      resolve(true)
    })
  })
}

/** UserChoice first — `HKCR\https` is only the machine-wide fallback, not the browser
 *  the user actually picked. */
async function registeredHandler(scheme: string): Promise<string | null> {
  const progId = await registryValue(
    `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`,
    'ProgId'
  )
  const fromChoice =
    progId === null ? null : await registryValue(`HKCR\\${progId}\\shell\\open\\command`, null)
  return fromChoice ?? registryValue(`HKCR\\${scheme}\\shell\\open\\command`, null)
}

function registryValue(key: string, name: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', key, ...(name === null ? ['/ve'] : ['/v', name])],
      { windowsHide: true, timeout: 2_000 },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const line = stdout.split(/\r?\n/).find((text) => text.includes('REG_SZ'))
        const value = line?.slice(line.indexOf('REG_SZ') + 'REG_SZ'.length).trim()
        resolve(value !== undefined && value !== '' ? value : null)
      }
    )
  })
}

function shellEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env['NODE_ENV']
  delete env['ELECTRON_RENDERER_URL']
  delete env['ELECTRON_RUN_AS_NODE']
  return env
}

function tokenise(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (const character of command) {
    if (character === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && /\s/.test(character)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += character
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

// ------------------------------------------------------------- paths and URLs

interface ResolvedDirect {
  target: DirectTarget
  resolved: string
}

let current: ResolvedDirect | null = null

const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i
const DRIVE_PATH = /^[a-z]:[\\/]/i
const UNC_PATH = /^\\\\[^\\]/
const HOME_PATH = /^~[\\/]/
const ENV_PATH = /^%[^%]+%/

export function resolveDirect(query: string): DirectTarget | null {
  const text = query.trim()
  current = null
  if (text.length < 3) return null

  const url = asUrl(text)
  if (url) {
    current = { target: { kind: 'url', label: text, detail: 'Open link' }, resolved: url }
    return current.target
  }

  const path = asExistingPath(text)
  if (path) {
    current = { target: { kind: 'path', label: text, detail: path }, resolved: path }
    return current.target
  }

  return null
}

function asUrl(text: string): string | null {
  if (/\s/.test(text)) return null
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).hostname === '' ? null : text
    } catch {
      return null
    }
  }
  if (DRIVE_PATH.test(text)) return null
  if (BARE_HOST.test(text)) return `https://${text}`
  return null
}

function asExistingPath(text: string): string | null {
  let candidate = text
  if (HOME_PATH.test(candidate)) candidate = homedir() + candidate.slice(1)
  else if (ENV_PATH.test(candidate)) {
    candidate = candidate.replace(/%([^%]+)%/g, (whole, name: string) => {
      const value = process.env[name]
      return value === undefined ? whole : value
    })
  }
  if (!DRIVE_PATH.test(candidate) && !UNC_PATH.test(candidate)) return null
  const full = normalize(candidate)
  if (!isAbsolute(full)) return null
  try {
    statSync(full)
    return full
  } catch {
    return null
  }
}

export async function openDirect(): Promise<boolean> {
  const direct = current
  if (!direct) return false
  return handOff(direct.resolved, direct.resolved)
}
