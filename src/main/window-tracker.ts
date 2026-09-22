/** The live window list and its MRU order. Maintained by subscription, never polling —
 *  one EnumWindows sweep seeds the cache at startup, SetWinEventHook keeps it current. */

import { basename } from 'path'
import { EzzyWindow } from '../shared/types'
import { cachedIcon, requestIcon } from './icons'
import { log, since } from './verbose'
import {
  EVENT_OBJECT_CLOAKED,
  EVENT_OBJECT_CREATE,
  EVENT_OBJECT_DESTROY,
  EVENT_OBJECT_HIDE,
  EVENT_OBJECT_NAMECHANGE,
  EVENT_OBJECT_SHOW,
  EVENT_OBJECT_UNCLOAKED,
  EVENT_SYSTEM_FOREGROUND,
  GA_ROOTOWNER,
  Hwnd,
  OBJID_WINDOW,
  WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW,
  WS_EX_TRANSPARENT,
  WinEventHook,
  enumerateTopLevelWindows,
  findHostedChildProcessId,
  getAncestor,
  getExStyle,
  getForegroundWindow,
  getLastActivePopup,
  getProcessImagePath,
  getShellWindow,
  getWindowProcessId,
  getWindowRect,
  getWindowTitle,
  isCloaked,
  isWindow,
  isWindowVisible,
  subscribeWinEvent
} from './win32'

interface TrackedWindow {
  id: Hwnd
  title: string
  app: string
  exePath: string | null
}

const cache = new Map<Hwnd, TrackedWindow>()
let mru: Hwnd[] = []
let hooks: WinEventHook[] = []
let listeners: Array<(windows: EzzyWindow[]) => void> = []
let notifyTimer: ReturnType<typeof setTimeout> | null = null
let shellWindow: Hwnd = 0

interface ProcessInfo {
  name: string
  path: string | null
}
const processInfo = new Map<number, ProcessInfo>()

const CREATE_SETTLE_MS = 180
const NOTIFY_DEBOUNCE_MS = 60

export function startTracking(): void {
  const startedAt = performance.now()
  shellWindow = getShellWindow()
  seedFromSweep()

  subscribe(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND)
  subscribe(EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE)
  subscribe(EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE)
  subscribe(EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED)

  if (hooks.length === 0) {
    console.error('[ezzy] no WinEvent hooks registered — the window list will not update')
  }
  since(`window tracking started (${cache.size} windows, ${hooks.length} hooks)`, startedAt)
}

export function stopTracking(): void {
  for (const hook of hooks) hook.unhook()
  hooks = []
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
}

export function restartTracking(): void {
  stopTracking()
  cache.clear()
  mru = []
  processInfo.clear()
  startTracking()
  log('window tracking rebuilt after resume')
  notify()
}

function subscribe(min: number, max: number): void {
  const hook = subscribeWinEvent(min, max, handleEvent)
  if (hook) hooks.push(hook)
  else console.error(`[ezzy] SetWinEventHook failed for range ${min}-${max}`)
}

function handleEvent(event: number, hwnd: Hwnd, idObject: number, idChild: number): void {
  if (idObject !== OBJID_WINDOW || idChild !== 0 || hwnd === 0) return

  switch (event) {
    case EVENT_SYSTEM_FOREGROUND:
      promote(hwnd)
      return
    case EVENT_OBJECT_DESTROY:
    case EVENT_OBJECT_HIDE:
    case EVENT_OBJECT_CLOAKED:
      forget(hwnd)
      return
    case EVENT_OBJECT_CREATE:
      reconsider(hwnd)
      setTimeout(() => reconsider(hwnd), CREATE_SETTLE_MS)
      return
    case EVENT_OBJECT_SHOW:
    case EVENT_OBJECT_UNCLOAKED:
    case EVENT_OBJECT_NAMECHANGE:
      reconsider(hwnd)
      return
    default:
  }
}

function reconsider(hwnd: Hwnd): void {
  if (!isSwitchable(hwnd)) {
    forget(hwnd)
    return
  }
  const title = getWindowTitle(hwnd)
  const existing = cache.get(hwnd)
  if (existing && existing.title === title) return

  cache.set(hwnd, existing ? { ...existing, title } : { id: hwnd, title, ...describeProcess(hwnd) })
  if (!existing) {
    mru = [hwnd, ...mru.filter((id) => id !== hwnd)]
  }
  notify()
}

function forget(hwnd: Hwnd): void {
  if (!cache.delete(hwnd)) return
  mru = mru.filter((id) => id !== hwnd)
  notify()
}

function promote(hwnd: Hwnd): void {
  if (!isSwitchable(hwnd)) return
  if (mru[0] === hwnd) return
  if (!cache.has(hwnd)) reconsider(hwnd)
  if (!cache.has(hwnd)) return
  mru = [hwnd, ...mru.filter((id) => id !== hwnd)]
  log(`foreground: ${cache.get(hwnd)?.title ?? hwnd}`)
  notify()
}

/** EnumWindows returns hundreds of windows nobody would call open: invisible shells,
 *  tool windows, and UWP apps suspended but still "visible" (cloaked by DWM). */
function isSwitchable(hwnd: Hwnd): boolean {
  if (hwnd === 0 || hwnd === shellWindow) return false
  if (!isWindow(hwnd) || !isWindowVisible(hwnd)) return false
  if (getWindowProcessId(hwnd) === process.pid) return false

  const style = getExStyle(hwnd)
  if (style & WS_EX_TOOLWINDOW) return false
  if (style & WS_EX_NOACTIVATE) return false
  // Click-through overlays (e.g. Cluely's) passed every other test here and sat in the
  // list with nothing for SetForegroundWindow to focus when clicked.
  if (style & WS_EX_TRANSPARENT) return false

  if (getWindowTitle(hwnd) === '') return false

  const rect = getWindowRect(hwnd)
  if (!rect || rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return false

  if (isCloaked(hwnd)) return false

  return isLastActivePopup(hwnd)
}

function isLastActivePopup(hwnd: Hwnd): boolean {
  let walk = getAncestor(hwnd, GA_ROOTOWNER)
  if (walk === 0) return true
  for (;;) {
    const next = getLastActivePopup(walk)
    if (isWindowVisible(next)) return next === hwnd
    if (next === walk) return walk === hwnd
    walk = next
  }
}

function describeProcess(hwnd: Hwnd): { app: string; exePath: string | null } {
  const info = processInfoFor(hwnd)
  if (info.path) void requestIcon(info.path, notify)
  return { app: info.name, exePath: info.path }
}

function processInfoFor(hwnd: Hwnd): ProcessInfo {
  let pid = getWindowProcessId(hwnd)
  if (pid === 0) return { name: '', path: null }

  const cached = processInfo.get(pid)
  if (cached !== undefined) return cached

  let path = getProcessImagePath(pid)
  if (path && basename(path).toLowerCase() === 'applicationframehost.exe') {
    const hosted = findHostedChildProcessId(hwnd, pid)
    if (hosted !== 0) {
      pid = hosted
      const hostedCache = processInfo.get(pid)
      if (hostedCache !== undefined) return hostedCache
      path = getProcessImagePath(pid)
    }
  }

  const info: ProcessInfo = { name: path ? prettifyExecutable(basename(path)) : '', path }
  processInfo.set(pid, info)
  return info
}

function prettifyExecutable(file: string): string {
  const stem = file.replace(/\.exe$/i, '')
  if (stem.length === 0) return ''
  const rest = stem === stem.toUpperCase() ? stem.slice(1).toLowerCase() : stem.slice(1)
  return stem[0].toUpperCase() + rest
}

function seedFromSweep(): void {
  for (const hwnd of enumerateTopLevelWindows()) {
    if (!isSwitchable(hwnd)) continue
    cache.set(hwnd, { id: hwnd, title: getWindowTitle(hwnd), ...describeProcess(hwnd) })
    mru.push(hwnd)
  }
  const foreground = getForegroundWindow()
  if (foreground && cache.has(foreground)) {
    mru = [foreground, ...mru.filter((id) => id !== foreground)]
  }
}

/** Re-tested against `isSwitchable` on the way out, not just the way in — a window can
 *  stop qualifying with no event to announce it. */
export function listWindows(): EzzyWindow[] {
  const startedAt = performance.now()
  const windows: EzzyWindow[] = []
  let dropped = 0
  for (const id of [...mru]) {
    const window = cache.get(id)
    if (!window) continue
    if (!isSwitchable(id)) {
      cache.delete(id)
      mru = mru.filter((entry) => entry !== id)
      dropped++
      continue
    }
    const icon = cachedIcon(window.exePath)
    windows.push(
      icon === undefined
        ? { id: window.id, title: window.title, app: window.app }
        : { id: window.id, title: window.title, app: window.app, icon }
    )
  }
  if (dropped > 0) {
    since(`window list: dropped ${dropped} that no longer qualify`, startedAt)
  }
  return windows
}

export function dropIfGone(hwnd: Hwnd): boolean {
  if (isWindow(hwnd)) return false
  forget(hwnd)
  log(`dropped a window that no longer exists: ${hwnd}`)
  return true
}

export function onWindowsChanged(listener: (windows: EzzyWindow[]) => void): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((entry) => entry !== listener)
  }
}

function notify(): void {
  if (notifyTimer !== null) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    const windows = listWindows()
    log(`window list: ${windows.length} windows [${windows.map((w) => w.title).join(' | ')}]`)
    for (const listener of listeners) listener(windows)
  }, NOTIFY_DEBOUNCE_MS)
}
