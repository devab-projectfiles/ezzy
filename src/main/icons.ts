/** Icons for the panel's rows.
 *
 *  The shell already knows what every `.lnk` and every `.exe` looks like, and Electron
 *  exposes that through `app.getFileIcon` — so nothing here parses an ICO, an PE resource
 *  section or an AppxManifest. What it does instead is keep the answers, because reading a
 *  few hundred of them costs seconds on a cold machine and nothing at all on a warm one.
 *
 *  Two rules shape the rest of this file:
 *   * Reading an icon is never on the path to a usable panel. Every consumer asks for the
 *     cached value synchronously, gets `undefined` on a miss, and draws the outline glyph.
 *     The fetch lands later and the list re-publishes.
 *   * The data URLs cross IPC on every keystroke, so the number of rows is capped upstream
 *     (MAX_APP_ROWS) rather than the icons being made small here. */

import { app } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { log, since } from './verbose'

/** Absolute file path -> PNG data URL. */
const icons = new Map<string, string>()
/** Paths the shell had nothing for. Remembered so a miss is not retried on every publish. */
const missing = new Set<string>()
/** In-flight reads, so two rows naming the same executable share one call. */
const inFlight = new Map<string, Promise<void>>()
let dirty = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** getFileIcon crosses into the shell for every call. Eight at a time keeps a first-run
 *  scan of a few hundred shortcuts off the main thread's back without serialising it. */
const SCAN_CONCURRENCY = 8

/** Writing the cache after every icon would mean a few hundred writes during a first scan. */
const SAVE_DEBOUNCE_MS = 2_000

function cacheFilePath(): string {
  return join(app.getPath('userData'), 'icon-cache.json')
}

export async function loadIconCache(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(cacheFilePath(), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null) return
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      // A file on disk that anything could have edited — only take what is the right shape.
      if (typeof value === 'string' && value.startsWith('data:image/')) icons.set(path, value)
    }
    log(`icon cache: ${icons.size} icons`)
  } catch {
    // Absent on first run, which is not an error.
  }
}

/** The cached icon, or undefined. Synchronous by design: this is called while assembling a
 *  panel payload, and the panel must never wait on the shell. */
export function cachedIcon(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return icons.get(path)
}

/** Read one icon if it is not already known. Resolves when the cache has been updated —
 *  or immediately, if there is nothing to do. `onReady` fires only when something changed,
 *  so a caller can re-publish its list without checking. */
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
      // A shortcut that points at something uninstalled, or a path we may not read. The
      // row keeps its glyph; there is nothing to report.
      missing.add(path)
    })
    .finally(() => {
      inFlight.delete(path)
    })
  inFlight.set(path, read)
  return read
}

/** Read a whole batch, bounded. Used after an app-index scan, where the list is long and
 *  the result is wanted eventually rather than now. `onReady` fires once at the end.
 *
 *  Takes the items rather than the paths, and works out the path inside the pool, because
 *  for a shortcut that step is itself expensive: resolving one is a synchronous COM call
 *  measured at ~26ms, and doing all of them up front blocked the main thread for two
 *  seconds — long enough for the hotkey to feel stuck if it were pressed in that window.
 *  In here each one sits between two awaits instead, so nothing waits on more than one. */
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

/** Trailing, not leading: a first scan reads a few hundred icons over twenty seconds, and a
 *  leading debounce would write the whole growing file ten times on the way through. */
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
