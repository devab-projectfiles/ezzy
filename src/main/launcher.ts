/** Starting things (PLAN.md §4, `launcher.ts`; §8 chunk C).
 *
 *  Three ways in, in the order §4 gives for resolving `open X`: an indexed app, a file path,
 *  a URL. Focusing a live window is the fourth and it is the one thing not here — that is
 *  `focus.ts`, because it is a different problem with a different failure mode.
 *
 *  Everything below goes through the shell rather than `spawn`. A `.lnk` carries the working
 *  directory and the arguments the app was installed to expect and the shell applies them;
 *  a Store app has no executable to spawn at all. */

import { shell } from 'electron'
import { execFile } from 'child_process'
import { statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, normalize } from 'path'
import { DirectTarget } from '../shared/types'
import { findApp } from './app-index'
import { log } from './verbose'

/** Launch an indexed app by the id the renderer sent back. The id is resolved against the
 *  index rather than used as a path, so an id that did not come from us launches nothing. */
export async function launchApp(id: string): Promise<boolean> {
  const entry = findApp(id)
  if (!entry) {
    console.error(`[ezzy] refused to launch an unknown app: ${id}`)
    return false
  }
  if (entry.launch.kind === 'shortcut') {
    const error = await shell.openPath(entry.launch.path)
    if (error) {
      console.error(`[ezzy] could not launch ${entry.name}: ${error}`)
      return false
    }
    log(`launched ${entry.name}`)
    return true
  }
  return launchFromAppsFolder(entry.name, entry.launch.appId)
}

/** Store and UWP apps live in a shell namespace, not the file system, so there is no path to
 *  open — `shell:AppsFolder\<AppID>` is the documented way in.
 *
 *  Neither `shell.openExternal` nor `shell.openPath` will take it: measured, openExternal on
 *  a `shell:` URI fails with ERROR_PATH_NOT_FOUND (0x3). Explorer is what resolves that
 *  namespace, so it is handed the string directly — as an argv element, not a command line,
 *  so an AppID never goes near a shell to be parsed.
 *
 *  Explorer detaches immediately and its own exit code says nothing about whether the app
 *  started, so a clean spawn is as much confirmation as there is to have here. */
function launchFromAppsFolder(name: string, appId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile('explorer.exe', [`shell:AppsFolder\\${appId}`], { windowsHide: true })
    child.once('error', (err) => {
      console.error(`[ezzy] could not launch ${name}:`, err)
      resolve(false)
    })
    child.once('spawn', () => {
      log(`launched ${name} (AppsFolder)`)
      resolve(true)
    })
  })
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

/** Open whatever `resolveDirect` last worked out. */
export async function openDirect(): Promise<boolean> {
  const direct = current
  if (!direct) return false
  if (direct.target.kind === 'url') {
    try {
      await shell.openExternal(direct.resolved)
      log(`opened ${direct.resolved}`)
      return true
    } catch (err) {
      console.error(`[ezzy] could not open ${direct.resolved}:`, err)
      return false
    }
  }
  const error = await shell.openPath(direct.resolved)
  if (error) {
    console.error(`[ezzy] could not open ${direct.resolved}: ${error}`)
    return false
  }
  log(`opened ${direct.resolved}`)
  return true
}
