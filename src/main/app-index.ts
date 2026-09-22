/** The installed-app index. Two sources, since neither alone is complete:
 *
 *   * The two Start Menu trees, as `.lnk` shortcuts — where every desktop app puts itself.
 *   * `Get-StartApps`, for Store/UWP apps with no shortcut on disk, launched through
 *     `shell:AppsFolder\<AppID>` instead.
 *
 *  The shortcut scan runs first and wins ties — a few hundred `readdir` calls, finishing
 *  in milliseconds; the PowerShell call costs most of a second to spawn. */

import { app, shell } from 'electron'
import { execFile } from 'child_process'
import type { Dirent } from 'fs'
import { readFile, readdir, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { promisify } from 'util'
import { AppInfo, EzzyApp } from '../shared/types'
import { getConfig } from './config'
import { cachedIcon, requestIcons } from './icons'
import { log, since } from './verbose'

const run = promisify(execFile)

/** How an app is started. Held only in the main process — the renderer sees `id` and
 *  nothing else, so an id arriving over IPC can never be an arbitrary path to execute. */
export type AppLaunch = { kind: 'shortcut'; path: string } | { kind: 'appsFolder'; appId: string }

export interface IndexedApp {
  id: string
  name: string
  launch: AppLaunch
  /** The file to read the row's icon from — not the `.lnk` itself, which the shell hands
   *  back as a generic "shortcut" document. Resolved to the shortcut's own icon or its
   *  target executable, in the background icon pass rather than the scan (it is a
   *  synchronous COM call). Null for good for a Start Apps entry, which has no file. */
  iconPath: string | null
  /** Extra names the user has given this app, held on the entry so search.ts never has to
   *  know a config file exists — an alias reaches it as one more name. */
  aliases: string[]
}

let apps: IndexedApp[] = []
/** App id -> the names the user added, as of the last `setAliases`. */
let aliases: Record<string, string[]> = {}
let listeners: Array<() => void> = []

/** Shortcuts that are technically apps but that nobody means when they say "open X" — the
 *  Start Menu is full of these and they sort early, which without this filter puts
 *  "7-Zip Help" ahead of anything launchable. */
const NOISE_PREFIX =
  /^(uninstall|install |remove |readme|read me|documentation|release notes|website|home page|visit |licence|license|changelog|what's new|troubleshoot|register |activate |repair |modify )/i

const NOISE_SUFFIX =
  /( help| manual| documentation| tools| console| command prompt| setup| uninstaller| readme| website| on the web| home page|\(64-bit\)|\(32-bit\))$/i

/** Whole names that are pure plumbing whatever else is installed. "File Explorer" and
 *  "Control Panel" are deliberately not on this list — people ask for them by name. */
const NOISE_EXACT = /^(help|support|administrative tools|windows tools|command prompt|run)$/i

/** The name a shortcut is actually for, when its filename carries more than that.
 *
 *  A browser writes an installed web app's shortcut from the page `<title>`, so a colon in
 *  the title (which cannot go in a filename) lands on disk as a double space — "Skool
 *  Discover Communities or Create Your Own" instead of "Skool". That is unreachable by
 *  voice (nothing anyone says resembles a 46-character sentence) and only sometimes found
 *  by typing. Cutting at the double space is narrow on purpose — the signature of a
 *  character the filesystem refused, not a rule about long names. */
function brandOf(name: string): string {
  const brand = name.split(/\s{2,}/)[0].trim()
  return brand === '' ? name.trim() : brand
}

function isNoise(name: string): boolean {
  return NOISE_PREFIX.test(name) || NOISE_SUFFIX.test(name) || NOISE_EXACT.test(name)
}

/** An uninstaller wearing the application's name — the name filters above cannot catch a
 *  leftover shortcut like "Antigravity IDE" that actually points at `unins000.exe`.
 *  Reading the link costs real time in the scan (73ms -> 219ms here), which is a
 *  background pass nothing waits on; the alternative is voice commands that can run one. */
function isUninstaller(shortcut: string): boolean {
  try {
    const target = shell.readShortcutLink(shortcut).target
    const uninstaller = target !== undefined && UNINSTALLER_EXE.test(basename(target))
    if (uninstaller) log(`skipping ${basename(shortcut)}: it points at ${basename(target)}`)
    return uninstaller
  } catch {
    // Not a shell link we can read. The name filters have already had their say.
    return false
  }
}

/** `unins000.exe` is Inno Setup's, `uninstall.exe`/`uninst.exe` cover the rest. */
const UNINSTALLER_EXE = /^(unins\d*|uninst(all)?|setup|remove)\.exe$/i

/** Directories under the Start Menu that only ever hold plumbing. */
const SKIP_DIRECTORIES =
  /^(startup|administrative tools|windows administrative tools|windows system|windows tools|accessibility|windows powershell|windows accessories|maintenance)$/i

/** A scan walks a few hundred directories, so it must never block the hotkey path. Capped
 *  so a stray junction in the Start Menu tree cannot recurse forever. */
const MAX_DEPTH = 5

/** PowerShell start-up dominates this call — if it has not answered by now, the shortcut
 *  half of the index is still a perfectly usable app list. */
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

/** Cached to disk, refreshed on startup — read first so the first panel of a session has
 *  apps in it, then the rescan corrects it in the background. */
export async function startAppIndex(): Promise<void> {
  aliases = getConfig().aliases
  await loadCache()
  await refreshAppIndex()
}

async function loadCache(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(cacheFilePath(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return
    // Validated rather than trusted — this is a plain file on disk, and it carries launch
    // instructions. Aliases are filled in here too, since an older cache predates the
    // field and this also lets the user's names apply to a cold start.
    apps = withCustom(
      raw.filter(isIndexedApp).map((entry) => ({ ...entry, aliases: aliases[entry.id] ?? [] }))
    )
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

  // Not awaited before publishing above — the names are already usable, and this whole
  // batch re-publishes once at the end with icons attached.
  void requestIcons([...found.values()], iconPathFor, () => {
    notify()
    void saveCache()
  })

  // Arrives second and adds only what the shortcut scan did not have, so a slow or
  // failing PowerShell costs names nobody has installed rather than the index itself.
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

/** Written twice per refresh: once when the names are known, again once the icon pass has
 *  resolved every shortcut's target — the second write is what lets a warm start skip the
 *  COM calls entirely. */
async function saveCache(): Promise<void> {
  try {
    await writeFile(cacheFilePath(), JSON.stringify(apps), 'utf8')
  } catch (err) {
    console.error('[ezzy] could not write the app index cache:', err)
  }
}

function publish(found: Map<string, IndexedApp>): void {
  // Hand-added apps go in on every publish, or a rescan would drop them until settings
  // changed again.
  apps = withCustom([...found.values()]).sort((a, b) => a.name.localeCompare(b.name))
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
    const name = brandOf(basename(entry.name, extname(entry.name)))
    if (isNoise(name)) continue
    if (isUninstaller(full)) continue
    // Both Start Menu trees carry the same shortcuts for machine-wide installs; first wins.
    const key = name.toLowerCase()
    if (found.has(key)) continue
    found.set(key, {
      id: `lnk:${full}`,
      name,
      launch: { kind: 'shortcut', path: full },
      iconPath: null,
      aliases: aliases[`lnk:${full}`] ?? []
    })
  }
}

/** Where an entry's icon actually lives, resolved and remembered on first use.
 *  `app.getFileIcon` on a `.lnk` returns the generic shortcut document, so the link is
 *  read instead for an explicit icon file or the target executable. Falls back to the
 *  shortcut itself rather than to nothing. */
function iconPathFor(entry: IndexedApp): string | null {
  if (entry.iconPath !== null) return entry.iconPath
  if (entry.launch.kind !== 'shortcut') return null
  const shortcut = entry.launch.path
  entry.iconPath = shortcut
  try {
    const link = shell.readShortcutLink(shortcut)
    // An explicit icon is often a `.dll` or a multi-icon `.ico` addressed by index, which
    // getFileIcon cannot select from — only used when it is a file in its own right.
    if (link.icon && !link.iconIndex) entry.iconPath = link.icon
    else if (link.target) entry.iconPath = link.target
  } catch {
    // Not every `.lnk` is a shell link the API will parse.
  }
  return entry.iconPath
}

interface StartAppRow {
  Name?: unknown
  AppID?: unknown
}

/** UWP and anything else with no shortcut on disk. `-NoProfile` matters — a user profile
 *  script printing to stdout would corrupt the JSON. Forced to an array since
 *  ConvertTo-Json emits a bare object for a single-row pipeline. */
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
      // Through brandOf for the same reason as the shortcut scan — this list carries the
      // same web apps under the same page-title names.
      const name = typeof row?.Name === 'string' ? brandOf(row.Name) : ''
      const appId = typeof row?.AppID === 'string' ? row.AppID.trim() : ''
      if (name === '' || appId === '' || isNoise(name)) continue
      // Desktop apps appear here too with a shortcut path as the AppID — already in the
      // index from the file scan, and AppsFolder would lose the shortcut's arguments.
      if (appId.includes('\\') || appId.includes('/')) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        id: `app:${appId}`,
        name,
        launch: { kind: 'appsFolder', appId },
        iconPath: null,
        aliases: aliases[`app:${appId}`] ?? []
      })
    }
    since(`Get-StartApps: ${rows.length} entries`, startedAt)
    return rows
  } catch (err) {
    console.error('[ezzy] Get-StartApps failed, using the shortcut scan alone:', err)
    return []
  }
}

/** Apps not currently running, given the window list's app names. Matched by normalised
 *  substring in either direction, since the two names rarely agree exactly ("Google
 *  Chrome" the shortcut, "chrome" the process). */
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

/** Strip an indexed app down to what the renderer is allowed to see, with whatever icon
 *  has been read so far. Store apps have no file to read one from, so they keep the
 *  outline glyph. */
export function toEzzyApp(entry: IndexedApp): EzzyApp {
  const icon = cachedIcon(entry.iconPath)
  return icon === undefined
    ? { id: entry.id, name: entry.name }
    : { id: entry.id, name: entry.name, icon }
}

/** Adopt the user's own names for things, in place and republished — usable in the next
 *  breath rather than after a five-second rescan. */
export function setAliases(next: Record<string, string[]>): void {
  aliases = next
  apps = apps.map((entry) => ({ ...entry, aliases: aliases[entry.id] ?? [] }))
  since(`app index: ${Object.keys(aliases).length} apps have extra names`, performance.now())
  for (const listener of listeners) listener()
}

/** Every app, with what the user calls it, for the settings window to list. */
export function appCatalogue(): AppInfo[] {
  return apps.map(({ id, name }) => ({
    id,
    name,
    aliases: aliases[id] ?? [],
    custom: id.startsWith(CUSTOM_PREFIX)
  }))
}

/** Marks an entry as one the user added, as part of the id so nothing has to be looked up
 *  to know where it came from. */
export const CUSTOM_PREFIX = 'custom:'

/** Fold the hand-added applications into the index. Added last and only when nothing
 *  already there has that id — a real Start Menu entry always wins, since it carries a
 *  resolvable icon. */
function withCustom(found: IndexedApp[]): IndexedApp[] {
  const custom = getConfig().customApps.map((entry): IndexedApp => ({
    id: `${CUSTOM_PREFIX}${entry.id}`,
    name: entry.name,
    launch: { kind: 'shortcut', path: entry.path },
    iconPath: entry.path,
    aliases: aliases[`${CUSTOM_PREFIX}${entry.id}`] ?? []
  }))
  const known = new Set(found.map((entry) => entry.id))
  return [...found, ...custom.filter((entry) => !known.has(entry.id))]
}

/** Re-fold them after the user adds or removes one, without a rescan. */
export function setCustomApps(): void {
  apps = withCustom(apps.filter((entry) => !entry.id.startsWith(CUSTOM_PREFIX)))
  apps.sort((a, b) => a.name.localeCompare(b.name))
  log(`app index: ${apps.length} apps, including hand-added ones`)
  notify()
}

export function indexedApps(): IndexedApp[] {
  return apps
}

/** Resolve an id from the renderer. Undefined for anything the index did not produce —
 *  the only check standing between an IPC message and the shell. */
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
