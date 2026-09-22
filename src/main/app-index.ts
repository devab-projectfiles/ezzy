/** The installed-app index: the two Start Menu trees as `.lnk` shortcuts, plus
 *  `Get-StartApps` for Store/UWP apps with no shortcut on disk. */

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

export type AppLaunch = { kind: 'shortcut'; path: string } | { kind: 'appsFolder'; appId: string }

export interface IndexedApp {
  id: string
  name: string
  launch: AppLaunch
  iconPath: string | null
  aliases: string[]
}

let apps: IndexedApp[] = []
let aliases: Record<string, string[]> = {}
let listeners: Array<() => void> = []

const NOISE_PREFIX =
  /^(uninstall|install |remove |readme|read me|documentation|release notes|website|home page|visit |licence|license|changelog|what's new|troubleshoot|register |activate |repair |modify )/i

const NOISE_SUFFIX =
  /( help| manual| documentation| tools| console| command prompt| setup| uninstaller| readme| website| on the web| home page|\(64-bit\)|\(32-bit\))$/i

const NOISE_EXACT = /^(help|support|administrative tools|windows tools|command prompt|run)$/i

/** A browser writes an installed web app's shortcut from the page `<title>`, so a colon
 *  in the title lands on disk as a double space. Cutting there recovers the actual name
 *  ("Skool" out of a 46-character tagline whisper could never match). */
function brandOf(name: string): string {
  const brand = name.split(/\s{2,}/)[0].trim()
  return brand === '' ? name.trim() : brand
}

function isNoise(name: string): boolean {
  return NOISE_PREFIX.test(name) || NOISE_SUFFIX.test(name) || NOISE_EXACT.test(name)
}

function isUninstaller(shortcut: string): boolean {
  try {
    const target = shell.readShortcutLink(shortcut).target
    const uninstaller = target !== undefined && UNINSTALLER_EXE.test(basename(target))
    if (uninstaller) log(`skipping ${basename(shortcut)}: it points at ${basename(target)}`)
    return uninstaller
  } catch {
    return false
  }
}

const UNINSTALLER_EXE = /^(unins\d*|uninst(all)?|setup|remove)\.exe$/i

const SKIP_DIRECTORIES =
  /^(startup|administrative tools|windows administrative tools|windows system|windows tools|accessibility|windows powershell|windows accessories|maintenance)$/i

const MAX_DEPTH = 5
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

export async function startAppIndex(): Promise<void> {
  aliases = getConfig().aliases
  await loadCache()
  await refreshAppIndex()
}

async function loadCache(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(cacheFilePath(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return
    apps = withCustom(
      raw.filter(isIndexedApp).map((entry) => ({ ...entry, aliases: aliases[entry.id] ?? [] }))
    )
    log(`app index: ${apps.length} apps from cache`)
    if (apps.length > 0) notify()
  } catch {
    // No cache on first run.
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

  void requestIcons([...found.values()], iconPathFor, () => {
    notify()
    void saveCache()
  })

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

async function saveCache(): Promise<void> {
  try {
    await writeFile(cacheFilePath(), JSON.stringify(apps), 'utf8')
  } catch (err) {
    console.error('[ezzy] could not write the app index cache:', err)
  }
}

function publish(found: Map<string, IndexedApp>): void {
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

/** `app.getFileIcon` on a `.lnk` returns the generic shortcut document, so the link is
 *  read instead for an explicit icon file or the target executable. */
function iconPathFor(entry: IndexedApp): string | null {
  if (entry.iconPath !== null) return entry.iconPath
  if (entry.launch.kind !== 'shortcut') return null
  const shortcut = entry.launch.path
  entry.iconPath = shortcut
  try {
    const link = shell.readShortcutLink(shortcut)
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
      const name = typeof row?.Name === 'string' ? brandOf(row.Name) : ''
      const appId = typeof row?.AppID === 'string' ? row.AppID.trim() : ''
      if (name === '' || appId === '' || isNoise(name)) continue
      // Desktop apps appear here too with a shortcut path as the AppID — already in the
      // index from the file scan.
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

export function appsNotRunning(runningAppNames: string[]): IndexedApp[] {
  const running = runningAppNames.map(normalise).filter((name) => name.length >= 3)
  if (running.length === 0) return apps
  return apps.filter((entry) => {
    const name = normalise(entry.name)
    return !running.some((process) => name.includes(process) || process.includes(name))
  })
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function toEzzyApp(entry: IndexedApp): EzzyApp {
  const icon = cachedIcon(entry.iconPath)
  return icon === undefined
    ? { id: entry.id, name: entry.name }
    : { id: entry.id, name: entry.name, icon }
}

export function setAliases(next: Record<string, string[]>): void {
  aliases = next
  apps = apps.map((entry) => ({ ...entry, aliases: aliases[entry.id] ?? [] }))
  since(`app index: ${Object.keys(aliases).length} apps have extra names`, performance.now())
  for (const listener of listeners) listener()
}

export function appCatalogue(): AppInfo[] {
  return apps.map(({ id, name }) => ({
    id,
    name,
    aliases: aliases[id] ?? [],
    custom: id.startsWith(CUSTOM_PREFIX)
  }))
}

export const CUSTOM_PREFIX = 'custom:'

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

export function setCustomApps(): void {
  apps = withCustom(apps.filter((entry) => !entry.id.startsWith(CUSTOM_PREFIX)))
  apps.sort((a, b) => a.name.localeCompare(b.name))
  log(`app index: ${apps.length} apps, including hand-added ones`)
  notify()
}

export function indexedApps(): IndexedApp[] {
  return apps
}

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
