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
