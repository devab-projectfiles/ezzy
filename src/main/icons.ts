import { app } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { log, since } from './verbose'

// Reading an icon is never on the path to a usable panel: every consumer asks for the cached
// value synchronously, gets undefined on a miss, and draws the outline glyph; the fetch lands
// later and the list re-publishes.
const icons = new Map<string, string>()
const missing = new Set<string>()
const inFlight = new Map<string, Promise<void>>()
let dirty = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

const SCAN_CONCURRENCY = 8
const SAVE_DEBOUNCE_MS = 2_000

function cacheFilePath(): string {
  return join(app.getPath('userData'), 'icon-cache.json')
}

export async function loadIconCache(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(cacheFilePath(), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null) return
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && value.startsWith('data:image/')) icons.set(path, value)
    }
    log(`icon cache: ${icons.size} icons`)
  } catch {
    // Absent on first run, which is not an error.
  }
}

// Synchronous by design: called while assembling a panel payload, which must never wait
// on the shell.
export function cachedIcon(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return icons.get(path)
}

export function requestIcon(path: string, onReady?: () => void): Promise<void> {
  if (icons.has(path) || missing.has(path)) return Promise.resolve()
  const existing = inFlight.get(path)
  if (existing) return existing
  const read = app
    .getFileIcon(path, { size: 'normal' })
    .then((image) => {
      if (image.isEmpty()) {
        missing.add(path)
        return
      }
      icons.set(path, image.toDataURL())
      dirty = true
      scheduleSave()
      onReady?.()
    })
    .catch(() => {
      missing.add(path)
    })
    .finally(() => {
      inFlight.delete(path)
    })
  inFlight.set(path, read)
  return read
}

// Takes the items rather than the paths and works out each path inside the pool: for a
// shortcut that step is a ~26ms synchronous COM call, and doing all of them up front once
// blocked the main thread for two seconds.
export async function requestIcons<T>(
  items: T[],
  pathFor: (item: T) => string | null,
  onReady?: () => void
): Promise<void> {
  if (items.length === 0) return
  const startedAt = performance.now()
  let next = 0
  let read = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = items[next++]
      if (item === undefined) return
      const path = pathFor(item)
      if (path === null || icons.has(path) || missing.has(path)) continue
      read++
      await requestIcon(path)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, items.length) }, () => worker())
  )
  if (read === 0) return
  since(`icons: ${read} read (${missing.size} without one)`, startedAt)
  onReady?.()
}

function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void saveIconCache()
  }, SAVE_DEBOUNCE_MS)
}

async function saveIconCache(): Promise<void> {
  if (!dirty) return
  dirty = false
  try {
    await writeFile(cacheFilePath(), JSON.stringify(Object.fromEntries(icons)), 'utf8')
  } catch (err) {
    console.error('[ezzy] could not write the icon cache:', err)
  }
}
