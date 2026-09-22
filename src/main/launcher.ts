/** Starting things. Three ways in: an indexed app, a file path, a URL. Focusing a live
 *  window is a fourth and lives in focus.ts instead — a different problem, a different
 *  failure mode. All three here go through Explorer; see `handOff`. */

import { execFile } from 'child_process'
import { existsSync, statSync } from 'fs'
import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { dirname, isAbsolute, join, normalize } from 'path'
import { shell } from 'electron'
import { DirectTarget } from '../shared/types'
import { findApp } from './app-index'
import { log } from './verbose'

/** Hand one thing to the Windows shell to open: a shortcut, a folder, a file, an
 *  `https://` URL, or `shell:AppsFolder\<AppID>` for a Store app.
 *
 *  Not `shell.openPath` / `shell.openExternal` — both call ShellExecute in our own
 *  process, which passes OUR environment to the child. Ezzy's is not neutral: dev sets
 *  `NODE_ENV` and `ELECTRON_RENDERER_URL`, and about half this machine's Start Menu is
 *  Electron apps that branch on those. Measured on Cluely: launched via `shell.openPath`
 *  it came up as a blank window with no overlay at all; launched through Explorer (from a
 *  shell with those variables deliberately set) it came up correctly.
 *
 *  `explorer.exe` is already running, so a second one forwards the request to the
 *  existing shell process and exits — the app is started by Explorer and inherits its
 *  clean environment, the same as launching from Windows search does.
 *
 *  Passed as an argv element, never a command line, so nothing here is parsed by a shell —
 *  callers must have validated it first (`findApp` resolves against the index,
 *  `resolveDirect` only ever produces an `http(s)` URL or an existing path).
 *
 *  The cost: Explorer detaches immediately, so a clean spawn is the only confirmation
 *  there is — worse than `openPath`'s error string, but better than a launcher that
 *  silently breaks the apps it starts. */
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

/** Launch an indexed app by the id the renderer sent back — resolved against the index
 *  rather than used as a path, so an id that did not come from us launches nothing. */
export async function launchApp(id: string): Promise<boolean> {
  const entry = findApp(id)
  if (!entry) {
    console.error(`[ezzy] refused to launch an unknown app: ${id}`)
    return false
  }
  // A Store app has no file to open — `shell:AppsFolder\` is the documented way in, and
  // Explorer is what resolves that namespace.
  const what =
    entry.launch.kind === 'shortcut' ? entry.launch.path : `shell:AppsFolder\\${entry.launch.appId}`
  return handOff(what, entry.name)
}

/** Windows' microphone privacy page, through Explorer like everything else here. */
export async function openMicrophoneSettings(): Promise<boolean> {
  return handOff('ms-settings:privacy-microphone', 'microphone settings')
}

/** A shell target built in this codebase — an `ms-settings:` page, a flyout URI — through
 *  Explorer for the same reason as above.
 *
 *  Not for search URLs: Explorer silently drops any URI carrying a query string (see
 *  `openProtocolUri`). Everything passed here is a fixed URI with nothing of the user's in it. */
export async function openShellTarget(uri: string, label: string): Promise<boolean> {
  return handOff(uri, label)
}

/** Open a URL inside an installed browser app window rather than as a tab.
 *
 *  A Chrome/Edge "app" is a Start Menu shortcut launching the browser with `--app-id=…`,
 *  so the browser decides where a link opens — and on this machine, with "open supported
 *  links in this app" enabled, it does not act on it, since Chrome never recorded the app
 *  under `web_apps.web_app_ids`.
 *
 *  So this asks for the app window directly: `--app=<url>` opens one frameless window on
 *  exactly that URL, in the profile the shortcut names. Returns false when no such app is
 *  installed (the signal to open a tab instead). Chrome-family only — `--app=` is a
 *  Chromium flag. */
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
  /** chrome.exe, resolved from the shortcut's own launcher. */
  exe: string
  /** The browser profile the app was installed under, or null when it did not say. */
  profile: string | null
  /** The shortcut this came from — kept so the answer can be re-checked, not trusted. */
  shortcut: string
}

/** Remembered between commands but never trusted alone: `--app=<url>` is not "launch the
 *  installed app", it opens app mode for ANY url, so a stale entry would not fail after an
 *  uninstall — it would silently keep opening an app window for one that is gone. So the
 *  shortcut file is checked on every use, and a miss is never cached (a scan is two
 *  directory reads; caching "no app" would delay a fresh install until restart). */
const webApps = new Map<string, WebApp>()

/** The Start Menu shortcut a browser writes when a site is installed as an app. Read with
 *  `shell.readShortcutLink` rather than by parsing the .lnk binary — Electron already has
 *  it, and this file is Windows-only besides. */
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
        // Separates an installed web app from an ordinary browser shortcut.
        if (!link.args?.includes('--app-id=')) continue
        const profile = /--profile-directory="?([^"\s]+)"?/.exec(link.args ?? '')
        found = {
          // The shortcut points at chrome_proxy.exe (for its own taskbar identity); the
          // flags go to the browser beside it.
          exe: join(dirname(link.target), 'chrome.exe'),
          profile: profile ? profile[1] : null,
          shortcut: join(root, entry)
        }
        break
      } catch {
        // A shortcut that cannot be read is one we do not use.
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

/** Open a URI through the handler its scheme is registered to — `spotify:search:…`, or a
 *  search URL that has to reach the default browser intact.
 *
 *  Explorer cannot deliver either, both measured: a custom scheme like `spotify:` exits 1
 *  with nothing happening, and a URL with a query string opens nothing at all (Explorer
 *  takes its argument as a shell path, and `?` is not legal in one — `openDirect`'s URL
 *  rung has the same limitation).
 *
 *  ShellExecute does deliver it, which is what `shell.openExternal` would use — and
 *  handing the child our environment is the exact thing this file exists to avoid. So the
 *  handler is read from the registry and run directly, with the dev variables stripped.
 *
 *  Returns false when nothing is registered, which doubles as "is that app installed" —
 *  the caller falls back to the web on the same signal. */
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
      // Every handler spells its argument differently (Spotify wants
      // `--protocol-uri="%1"`, others just `"%1"`) — substituted into the registered
      // template rather than hardcoded, so an update that changes it still works.
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

/** The command line a scheme opens with, resolved the way Windows resolves it, or null.
 *
 *  UserChoice first: `HKCR\https` is only the machine-wide fallback, while the browser the
 *  user actually picked lives in their own UserChoice key as a ProgId — going straight to
 *  HKCR launched a browser they do not use, which opened no window at all. A custom scheme
 *  like `spotify:` normally has no UserChoice entry and falls through to its own key. */
async function registeredHandler(scheme: string): Promise<string | null> {
  const progId = await registryValue(
    `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`,
    'ProgId'
  )
  const fromChoice =
    progId === null ? null : await registryValue(`HKCR\\${progId}\\shell\\open\\command`, null)
  return fromChoice ?? registryValue(`HKCR\\${scheme}\\shell\\open\\command`, null)
}

/** One registry read. `null` for the name asks for the key's default value. */
function registryValue(key: string, name: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', key, ...(name === null ? ['/ve'] : ['/v', name])],
      // Bounded — a wedged `reg` must not hold a voice command open.
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

/** Our environment with the variables electron-vite and Electron add to it removed —
 *  Explorer gets us a clean one for free, spawning a handler ourselves does not.
 *  `ELECTRON_RUN_AS_NODE` makes an Electron child boot as bare Node with no window at all. */
function shellEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env['NODE_ENV']
  delete env['ELECTRON_RENDERER_URL']
  delete env['ELECTRON_RUN_AS_NODE']
  return env
}

/** A registered command line split into argv, respecting double quotes — the registry's
 *  own escaping, which `execFile` does not need since it does its own. */
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

/** What `resolveDirect` worked out, so the renderer can ask to open "the direct row"
 *  without naming a target — nothing it sends can widen this into "open any path". */
interface ResolvedDirect {
  target: DirectTarget
  /** The absolute path or fully-qualified URL actually handed to the shell. */
  resolved: string
}

let current: ResolvedDirect | null = null

/** Bare hostnames worth offering as a URL — a shape test, not a TLD list. */
const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i

/** Windows path shapes: a drive letter, a UNC root, a `~` home reference, or `%VAR%`. */
const DRIVE_PATH = /^[a-z]:[\\/]/i
const UNC_PATH = /^\\\\[^\\]/
const HOME_PATH = /^~[\\/]/
const ENV_PATH = /^%[^%]+%/

/** Decide whether the query names something directly. Called on every keystroke, so the
 *  one filesystem call it can make is a single `stat`, well inside the 16ms budget.
 *  Returns null far more often than not — a fallback for when the index has nothing. */
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
      // A scheme alone is not a URL — "http://" parses in some runtimes and opens a
      // browser on nothing.
      return new URL(text).hostname === '' ? null : text
    } catch {
      return null
    }
  }
  // A drive letter looks like a scheme to the shape test below, so paths get first refusal.
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
    // Sync on purpose — one stat per keystroke is microseconds, and async would mean the
    // row appearing a frame after the rest of the results.
    statSync(full)
    return full
  } catch {
    // Half-typed paths are the common case here, not an error worth reporting.
    return null
  }
}

/** Open whatever `resolveDirect` last worked out. A URL goes through Explorer too, for
 *  the same reason as an app — the default browser may not be running yet, and if it is
 *  an Electron one, `shell.openExternal` would start it with Ezzy's environment. `asUrl`
 *  only ever produces an `http(s)` URL, so nothing else can reach Explorer through here. */
export async function openDirect(): Promise<boolean> {
  const direct = current
  if (!direct) return false
  return handOff(direct.resolved, direct.resolved)
}
