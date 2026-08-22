/** The installed-app index (PLAN.md §8 chunk C).
 *
 *  Windows keeps the authoritative list of "things a person would call an app" in the two
 *  Start Menu trees, as `.lnk` shortcuts. Scanning those is enough to name and launch every
 *  desktop app on the machine, and it needs no COM and no elevation — the shortcut file
 *  itself is what `shell.openPath` hands back to the shell.
 *
 *  Deliberately not here yet: icon extraction, `Get-StartApps` for UWP, and Fuse.js
 *  matching. Those are the rest of chunk C. */

import { app, shell } from 'electron'
import type { Dirent } from 'fs'
import { readFile, readdir, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { EzzyApp } from '../shared/types'
import { log, since } from './verbose'

let apps: EzzyApp[] = []
let listeners: Array<() => void> = []

/** Shortcuts that are technically apps but that nobody means when they say "open X".
 *
 *  The Start Menu is full of these and they sort early, so without the filter the section
 *  opens on "7-Zip Help" and "Administrative Tools" rather than on anything launchable. */
const NOISE_PREFIX =
  /^(uninstall|install |remove |readme|read me|documentation|release notes|website|home page|visit |licence|license|changelog|what's new|troubleshoot|register |activate |repair |modify )/i

const NOISE_SUFFIX =
  /( help| manual| documentation| tools| console| command prompt| setup| uninstaller| readme| website| on the web| home page|\(64-bit\)|\(32-bit\))$/i

/** Whole names that are pure plumbing whatever else is installed. */
const NOISE_EXACT =
  /^(help|support|administrative tools|windows tools|command prompt|file explorer|run|control panel)$/i

function isNoise(name: string): boolean {
  return NOISE_PREFIX.test(name) || NOISE_SUFFIX.test(name) || NOISE_EXACT.test(name)
}

/** Directories under the Start Menu that only ever hold plumbing. */
const SKIP_DIRECTORIES =
  /^(startup|administrative tools|windows administrative tools|windows system|windows tools|accessibility|windows powershell|windows accessories|maintenance)$/i

/** A scan walks a few hundred directories, so it must never block the hotkey path. Depth is
 *  capped because a stray junction in the Start Menu tree would otherwise recurse forever. */
const MAX_DEPTH = 5

function cacheFilePath(): string {
  return join(app.getPath('userData'), 'app-index.json')
}

function startMenuRoots(): string[] {
  const roots: string[] = []
  const programData = process.env['ProgramData']
  const appData = process.env['APPDATA']
  if (programData) roots.push(join(programData, 'Microsoft/Windows/Start Menu/Programs'))
  if (appData) roots.push(join(appData, 'Microsoft/Windows/Start Menu/Programs'))
  return roots
}

/** §8 chunk C: cached to disk, refreshed on startup. The cache is read first so the very
 *  first panel of a session has apps in it, then the rescan corrects it in the background. */
export async function startAppIndex(): Promise<void> {
  await loadCache()
  await refreshAppIndex()
}

async function loadCache(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(cacheFilePath(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return
    // The cache is a plain file on disk and can be edited or truncated; validate it rather
    // than trusting it into the renderer.
    apps = raw.filter(
      (entry): entry is EzzyApp =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as EzzyApp).id === 'string' &&
        typeof (entry as EzzyApp).name === 'string'
    )
    log(`app index: ${apps.length} apps from cache`)
    if (apps.length > 0) notify()
  } catch {
    // No cache on first run, which is not an error.
  }
}

export async function refreshAppIndex(): Promise<void> {
  const startedAt = performance.now()
  const found = new Map<string, EzzyApp>()
  for (const root of startMenuRoots()) {
    await collect(root, found, 0)
  }
  apps = [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  since(`app index: ${apps.length} apps scanned`, startedAt)
  notify()
  try {
    await writeFile(cacheFilePath(), JSON.stringify(apps), 'utf8')
  } catch (err) {
    console.error('[ezzy] could not write the app index cache:', err)
  }
}

async function collect(
  directory: string,
  found: Map<string, EzzyApp>,
  depth: number
): Promise<void> {
  if (depth > MAX_DEPTH) return
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    // Start Menu subtrees come and go with installs and some are simply unreadable.
    return
  }
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.test(entry.name)) continue
      await collect(full, found, depth + 1)
      continue
    }
    if (extname(entry.name).toLowerCase() !== '.lnk') continue
    const name = basename(entry.name, extname(entry.name))
    if (isNoise(name)) continue
    // Both Start Menu trees carry the same shortcuts for machine-wide installs; first wins.
    const key = name.toLowerCase()
    if (found.has(key)) continue
    found.set(key, { id: full, name })
  }
}

/** The apps that are not currently running, given the window list's app names.
 *
 *  Matching is by normalised substring in either direction, because the two names come from
 *  different places and rarely agree exactly: the shortcut says "Google Chrome", the process
 *  says "chrome"; the shortcut says "Visual Studio Code", the process says "Code". */
export function appsNotRunning(runningAppNames: string[]): EzzyApp[] {
  const running = runningAppNames
    .map(normalise)
    // Two characters matches far too much — "Ai" would hide every app with those letters.
    .filter((name) => name.length >= 3)
  if (running.length === 0) return apps
  return apps.filter((entry) => {
    const name = normalise(entry.name)
    return !running.some((process) => name.includes(process) || process.includes(name))
  })
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Launch through the shortcut rather than a resolved target: the `.lnk` carries the working
 *  directory and arguments the app was installed to expect, and the shell applies them. */
export async function launchApp(id: string): Promise<boolean> {
  // Only ever launch something the index actually produced — the id crosses IPC from the
  // renderer, and this keeps it from being an arbitrary path to execute.
  if (!apps.some((entry) => entry.id === id)) {
    console.error(`[ezzy] refused to launch an unknown app: ${id}`)
    return false
  }
  const error = await shell.openPath(id)
  if (error) {
    console.error(`[ezzy] could not launch ${id}: ${error}`)
    return false
  }
  log(`launched ${basename(id)}`)
  return true
}

export function onAppsChanged(listener: () => void): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((entry) => entry !== listener)
  }
}

function notify(): void {
  for (const listener of listeners) listener()
}
