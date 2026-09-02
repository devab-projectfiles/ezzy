/** Starting things (PLAN.md §4, `launcher.ts`; §8 chunk C).
 *
 *  Three ways in, in the order §4 gives for resolving `open X`: an indexed app, a file path,
 *  a URL. Focusing a live window is the fourth and it is the one thing not here — that is
 *  `focus.ts`, because it is a different problem with a different failure mode.
 *
 *  All three go through Explorer, and that is the whole design of this file. See `handOff`. */

import { execFile } from 'child_process'
import { statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, normalize } from 'path'
import { DirectTarget } from '../shared/types'
import { findApp } from './app-index'
import { log } from './verbose'

/** Hand one thing to the Windows shell to open: a shortcut, a folder, a file, an
 *  `https://` URL, or a `shell:AppsFolder\<AppID>` for a Store app.
 *
 *  **Why Explorer and not `shell.openPath` / `shell.openExternal`.** Both of those call
 *  ShellExecute inside our own process, and ShellExecute passes the *caller's* environment
 *  block to the child. Ezzy's environment is not a neutral one: in dev, electron-vite sets
 *  `NODE_ENV=development` and `ELECTRON_RENDERER_URL=http://localhost:5173` in the main
 *  process, and those get inherited by everything Ezzy starts. Roughly half of this
 *  machine's Start Menu is Electron apps, and an Electron app that branches on `NODE_ENV`
 *  then tries to load a dev server that is not there.
 *
 *  Measured on Cluely, 2026-08-24: launched by `shell.openPath` it came up as a blank white
 *  1199x786 window and never created its overlay at all; launched through Explorer — from a
 *  shell where `NODE_ENV` and `ELECTRON_RENDERER_URL` were deliberately set — it came up
 *  correctly, overlay and all. It looked for a while like Ezzy was suppressing another app's
 *  overlay by z-order or by its window hooks. It was not. It was this.
 *
 *  `explorer.exe` is already running, so a second one forwards the request to the existing
 *  shell process and exits; the app is started by Explorer and inherits Explorer's clean
 *  user environment. This is what the Start Menu itself does, which is why launching from
 *  Windows search always worked.
 *
 *  The argument is passed as an argv element rather than a command line, so nothing here is
 *  ever parsed by a shell. Callers must have validated it first — `findApp` resolves ids
 *  against the index and `resolveDirect` only ever produces an `http(s)` URL or a path that
 *  exists.
 *
 *  The cost: Explorer detaches immediately and its exit code says nothing about whether the
 *  app started, so a clean spawn is as much confirmation as there is to have. That is worse
 *  than `openPath`, which returns an error string — but a launcher that silently breaks the
 *  apps it launches is worse still. */
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

/** Launch an indexed app by the id the renderer sent back. The id is resolved against the
 *  index rather than used as a path, so an id that did not come from us launches nothing. */
export async function launchApp(id: string): Promise<boolean> {
  const entry = findApp(id)
  if (!entry) {
    console.error(`[ezzy] refused to launch an unknown app: ${id}`)
    return false
  }
  // A Store app has no file to open: it lives in a shell namespace, and `shell:AppsFolder\`
  // is the documented way in. Explorer is what resolves that namespace, which is the other
  // reason everything goes through it here.
  const what =
    entry.launch.kind === 'shortcut' ? entry.launch.path : `shell:AppsFolder\\${entry.launch.appId}`
  return handOff(what, entry.name)
}

/** Windows' microphone privacy page. Through Explorer like everything else here — a
 *  `ms-settings:` URI is a shell namespace target, which is exactly what Explorer resolves,
 *  and it keeps the Settings app off our environment block. */
export async function openMicrophoneSettings(): Promise<boolean> {
  return handOff('ms-settings:privacy-microphone', 'microphone settings')
}

/** Open a URI through the handler its scheme is registered to — `spotify:search:…`, or a
 *  search URL that has to reach the default browser intact (FEATURE-media-search.md).
 *
 *  **Explorer cannot deliver either of those, and both were measured.**
 *
 *  - A custom scheme: handed `spotify:search:…` Explorer exits 1 and nothing happens, checked
 *    against a running Spotify whose search never changed. `ms-settings:display` through the
 *    same call opens Settings, so this is the scheme, not the mechanism.
 *  - **A URL with a query string.** `https://example.com/` opens a tab;
 *    `https://example.com/?q=x` opens nothing at all. Explorer takes its argument as a shell
 *    path, and `?` is not legal in one. Every search URL in this app is a query string, so
 *    `handOff` is simply not available to them — note that `openDirect`'s URL rung has the
 *    same limitation, which is out of scope here but is not a difference in intent.
 *
 *  ShellExecute does deliver it, which is what `shell.openExternal` would use — and that is
 *  the one thing this file exists to avoid, because ShellExecute hands the child OUR
 *  environment. So we do what Windows would have done, ourselves: read the handler the scheme
 *  is registered to and run it, with the dev variables stripped out. Verified: Spotify
 *  navigated to a two-word search with its query intact.
 *
 *  Returns false when nothing is registered for the scheme, which is also the answer to "is
 *  that app installed" — the caller falls back to the web on the same signal. */
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
      // Every handler spells its argument differently — Spotify wants `--protocol-uri="%1"`,
      // others just `"%1"`. Substituting into the registered template rather than hardcoding
      // one app's flag is what keeps this working across an update that changes it.
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

/** The command line a scheme opens with, resolved the way Windows resolves it, or null if
 *  nothing is registered.
 *
 *  **UserChoice first, and that is not a detail.** `HKCR\https` is the machine-wide fallback — on
 *  this machine it names Edge — while the browser the user actually picked lives in their own
 *  UserChoice key as a ProgId (`ChromeHTML`). Going straight to HKCR launched a browser the
 *  user does not use, which then opened no window at all. A launcher that ignores your default
 *  browser is worse than one that cannot open the link.
 *
 *  A custom scheme like `spotify:` normally has no UserChoice entry and falls through to the
 *  scheme's own key, which is where its installer put it. */
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
      // Bounded: a wedged `reg` must not hold a voice command open. The answer costs ~20ms.
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

/** Our environment with the variables electron-vite and Electron add to it removed.
 *
 *  This is the same bug the note on `handOff` is about, met from the other side: Explorer gets
 *  us a clean environment for free, and spawning a handler ourselves does not. `NODE_ENV` and
 *  `ELECTRON_RENDERER_URL` are what broke another Electron app when it inherited them, and
 *  `ELECTRON_RUN_AS_NODE` makes an Electron child boot as bare Node with no window at all. */
function shellEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env['NODE_ENV']
  delete env['ELECTRON_RENDERER_URL']
  delete env['ELECTRON_RUN_AS_NODE']
  return env
}

/** A registered command line split into argv, respecting double quotes. `"C:\u2026\Spotify.exe"
 *  --protocol-uri="%1"` becomes two elements, the second still carrying its `%1` — the quotes
 *  are the registry's own escaping and `execFile` does its own, so they come off here. */
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

/** What `resolveDirect` worked out, kept so the renderer can ask to open "the direct row"
 *  without naming a target — nothing it sends can widen this into "open any path". */
interface ResolvedDirect {
  target: DirectTarget
  /** The absolute path or the fully-qualified URL actually handed to the shell. */
  resolved: string
}

let current: ResolvedDirect | null = null

/** Bare hostnames worth offering as a URL. Deliberately a shape test rather than a TLD list:
 *  a two-plus-letter last label with no spaces is what people type when they mean a website,
 *  and anything else falls through to being an ordinary search term. */
const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i

/** Windows path shapes: a drive letter, a UNC root, a `~` home reference, or `%VAR%`. */
const DRIVE_PATH = /^[a-z]:[\\/]/i
const UNC_PATH = /^\\\\[^\\]/
const HOME_PATH = /^~[\\/]/
const ENV_PATH = /^%[^%]+%/

/** Decide whether the query names something directly. Called on every keystroke, so the one
 *  filesystem call it can make is a single `stat` — well inside §7's 16ms.
 *
 *  Returns null far more often than not, and that is the point: this is a fallback for when
 *  the index has nothing, not a competitor to it. */
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
      // A scheme alone is not a URL — "http://" on its own parses in some runtimes and
      // opens a browser on nothing.
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
    // Sync on purpose: one stat per keystroke is microseconds, and making it async would
    // mean the row appearing a frame after the rest of the results.
    statSync(full)
    return full
  } catch {
    // Half-typed paths are the common case here, not an error worth reporting.
    return null
  }
}

/** Open whatever `resolveDirect` last worked out.
 *
 *  A URL goes through Explorer too, for the same reason as an app: the default browser may
 *  not be running yet, and if it is an Electron one — this machine has Comet installed —
 *  then `shell.openExternal` would start it with Ezzy's environment and break it exactly the
 *  way it broke Cluely. `asUrl` only ever produces an `http(s)` URL, so nothing else can
 *  reach Explorer through here. */
export async function openDirect(): Promise<boolean> {
  const direct = current
  if (!direct) return false
  return handOff(direct.resolved, direct.resolved)
}
