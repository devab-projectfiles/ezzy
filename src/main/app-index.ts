/** The installed-app index (PLAN.md §8 chunk C).
 *
 *  Two sources, because neither one is complete:
 *
 *   * The two Start Menu trees, as `.lnk` shortcuts. This is where every desktop app puts
 *     itself, it needs no COM and no elevation, and the shortcut file is what the shell
 *     itself is handed to launch the app with its intended working directory and arguments.
 *   * `Get-StartApps`, for everything with no shortcut on disk — Store and UWP apps, whose
 *     entries live in the AppsFolder shell namespace rather than in the file system. Those
 *     launch through `shell:AppsFolder\<AppID>` instead.
 *
 *  The shortcut scan runs first and wins ties. It is a few hundred `readdir` calls and
 *  finishes in milliseconds; the PowerShell call costs most of a second to spawn, so it is
 *  never what the first panel of a session waits on. */

import { app, shell } from 'electron'
import { execFile } from 'child_process'
import type { Dirent } from 'fs'
import { readFile, readdir, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { promisify } from 'util'
import { EzzyApp } from '../shared/types'
import { cachedIcon, requestIcons } from './icons'
import { log, since } from './verbose'

const run = promisify(execFile)

/** How an app is started. Held only in the main process: the renderer sees `id` and nothing
 *  else, so an id arriving over IPC can never be an arbitrary path to execute. */
export type AppLaunch = { kind: 'shortcut'; path: string } | { kind: 'appsFolder'; appId: string }

export interface IndexedApp {
  id: string
  name: string
  launch: AppLaunch
  /** The file to read the row's icon out of. Not the `.lnk` itself: the shell hands back the
   *  generic "shortcut" document for one of those, which looks like a missing icon rather
   *  than like the app. Resolved to the shortcut's own icon file, or its target executable.
   *
   *  Null until that resolution has happened — it is a synchronous COM call, so it is done
   *  in the background icon pass rather than in the scan — and null for good for a Start
   *  Apps entry, which has no file behind it at all. Resolved values ride the disk cache, so
   *  a warm start does none of this work again. */
  iconPath: string | null
}

let apps: IndexedApp[] = []
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

/** PowerShell start-up dominates this call. If it has not answered by now something is
 *  wrong with it, and the shortcut half of the index is a perfectly usable app list. */
const START_APPS_TIMEOUT_MS = 15_000

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
    // than trusting it into the renderer — and, now that it carries launch instructions,
    // rather than trusting it into the shell either.
    apps = raw.filter(isIndexedApp)
    log(`app index: ${apps.length} apps from cache`)
    if (apps.length > 0) notify()
  } catch {
    // No cache on first run, which is not an error.
  }
}

function isIndexedApp(value: unknown): value is IndexedApp {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as IndexedApp
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string') return false
  if (entry.iconPath !== null && typeof entry.iconPath !== 'string') return false
  const launch = entry.launch as AppLaunch | undefined
  if (typeof launch !== 'object' || launch === null) return false
  if (launch.kind === 'shortcut') return typeof launch.path === 'string'
  if (launch.kind === 'appsFolder') return typeof launch.appId === 'string'
  return false
}

export async function refreshAppIndex(): Promise<void> {
  const startedAt = performance.now()
  const found = new Map<string, IndexedApp>()
  for (const root of startMenuRoots()) {
    await collect(root, found, 0)
  }
  publish(found)
  since(`app index: ${found.size} shortcuts scanned`, startedAt)

  // Icons for the shortcuts just found. Deliberately not awaited before publishing above:
  // the names are what make the section usable, and they are already in the renderer's
  // hands. The whole batch re-publishes once at the end.
  void requestIcons([...found.values()], iconPathFor, () => {
    notify()
    void saveCache()
  })

  // The Store half. It arrives second and adds only what the shortcut scan did not have,
  // so a slow or failing PowerShell costs names nobody has installed rather than the index.
  const startApps = await collectStartApps()
  let added = 0
  for (const entry of startApps) {
    const key = entry.name.toLowerCase()
    if (found.has(key)) continue
    found.set(key, entry)
    added++
  }
  if (added > 0) publish(found)
  since(`app index: ${found.size} apps total (${added} from Get-StartApps)`, startedAt)
  await saveCache()
}

/** Written twice per refresh: once when the names are known, and again once the icon pass
 *  has resolved every shortcut's target — that second write is what makes a warm start skip
 *  the COM calls entirely. */
async function saveCache(): Promise<void> {
  try {
    await writeFile(cacheFilePath(), JSON.stringify(apps), 'utf8')
  } catch (err) {
    console.error('[ezzy] could not write the app index cache:', err)
  }
}

function publish(found: Map<string, IndexedApp>): void {
  apps = [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  notify()
}

async function collect(
  directory: string,
  found: Map<string, IndexedApp>,
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
    found.set(key, {
      id: `lnk:${full}`,
      name,
      launch: { kind: 'shortcut', path: full },
      iconPath: null
    })
  }
}

/** Where an entry's icon actually lives, resolving and remembering it on first use.
 *
 *  `app.getFileIcon` on a `.lnk` returns the generic shortcut document — measured, and it is
 *  what made every app row look like an unrecognised file while the window rows, which point
 *  at real executables, came out right. Reading the link gives either an explicit icon file
 *  the installer set or the target executable, and the shell knows both of those.
 *
 *  Falls back to the shortcut itself rather than to nothing: a generic icon is still better
 *  than a row that will keep asking for one it can never have. */
function iconPathFor(entry: IndexedApp): string | null {
  if (entry.iconPath !== null) return entry.iconPath
  if (entry.launch.kind !== 'shortcut') return null
  const shortcut = entry.launch.path
  entry.iconPath = shortcut
  try {
    const link = shell.readShortcutLink(shortcut)
    // An explicit icon is often a `.dll` or a multi-icon `.ico` addressed by index, which
    // getFileIcon cannot select from — so it is only used when it is a file in its own right.
    if (link.icon && !link.iconIndex) entry.iconPath = link.icon
    else if (link.target) entry.iconPath = link.target
  } catch {
    // Not every `.lnk` is a shell link the API will parse, and an installer can leave one
    // pointing at something uninstalled.
  }
  return entry.iconPath
}

interface StartAppRow {
  Name?: unknown
  AppID?: unknown
}

/** UWP and anything else with no shortcut on disk.
 *
 *  `-NoProfile` matters: a user profile script can print to stdout and would corrupt the
 *  JSON. The output is forced to an array because ConvertTo-Json emits a bare object when
 *  the pipeline has exactly one row, which is rare here but not impossible. */
async function collectStartApps(): Promise<IndexedApp[]> {
  const startedAt = performance.now()
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'ConvertTo-Json -Compress -InputObject @(Get-StartApps | Select-Object Name, AppID)'
      ],
      { timeout: START_APPS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    )
    const parsed = JSON.parse(stdout) as unknown
    if (!Array.isArray(parsed)) return []
    const rows: IndexedApp[] = []
    const seen = new Set<string>()
    for (const row of parsed as StartAppRow[]) {
      const name = typeof row?.Name === 'string' ? row.Name.trim() : ''
      const appId = typeof row?.AppID === 'string' ? row.AppID.trim() : ''
      if (name === '' || appId === '' || isNoise(name)) continue
      // Get-StartApps lists desktop apps too, with a shortcut path as the AppID. Those are
      // already in the index from the file scan, and going through AppsFolder for them
      // would lose the arguments the shortcut carries.
      if (appId.includes('\\') || appId.includes('/')) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({ id: `app:${appId}`, name, launch: { kind: 'appsFolder', appId }, iconPath: null })
    }
    since(`Get-StartApps: ${rows.length} entries`, startedAt)
    return rows
  } catch (err) {
    // A machine with PowerShell locked down still gets every desktop app from the file
    // scan, so this is a smaller index rather than a broken one.
    console.error('[ezzy] Get-StartApps failed, using the shortcut scan alone:', err)
    return []
  }
}

/** The apps that are not currently running, given the window list's app names.
 *
 *  Matching is by normalised substring in either direction, because the two names come from
 *  different places and rarely agree exactly: the shortcut says "Google Chrome", the process
 *  says "chrome"; the shortcut says "Visual Studio Code", the process says "Code". */
export function appsNotRunning(runningAppNames: string[]): IndexedApp[] {
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

/** Strip an indexed app down to what the renderer is allowed to see, and attach whatever
 *  icon has been read for it so far. Store apps have no file to read one from, so they keep
 *  the outline glyph. */
export function toEzzyApp(entry: IndexedApp): EzzyApp {
  const icon = cachedIcon(entry.iconPath)
  return icon === undefined
    ? { id: entry.id, name: entry.name }
    : { id: entry.id, name: entry.name, icon }
}

/** Resolve an id that came back from the renderer. Returns undefined for anything the index
 *  did not produce — which is the only check standing between an IPC message and the shell. */
export function findApp(id: string): IndexedApp | undefined {
  return apps.find((entry) => entry.id === id)
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
