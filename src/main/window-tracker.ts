/** The live window list and its MRU order (PLAN.md §5, §8 chunk B).
 *
 *  The list is maintained by subscription, never by polling: one EnumWindows sweep seeds the
 *  cache at startup, and after that SetWinEventHook keeps it current. Opening the panel
 *  reads a variable — that is what makes the <50ms budget in §7 reachable at all.
 *
 *  Everything here runs on the main thread inside Windows' message dispatch, so the handlers
 *  are deliberately cheap: they touch one window, not the whole desktop. */

import { basename } from 'path'
import { EzzyWindow } from '../shared/types'
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
}

/** Handle -> window, for O(1) updates from the event handlers. */
const cache = new Map<Hwnd, TrackedWindow>()
/** Most-recently-foregrounded first. Holds handles only; the cache holds the data. */
let mru: Hwnd[] = []
let hooks: WinEventHook[] = []
let listeners: Array<(windows: EzzyWindow[]) => void> = []
let notifyTimer: ReturnType<typeof setTimeout> | null = null
let shellWindow: Hwnd = 0

/** Executable path per pid. Processes are long-lived relative to window events and this is
 *  the only call in the hot path that opens a handle, so it is worth caching. */
const processNames = new Map<number, string>()

/** A newly created window has no title and is not yet visible — the title arrives later, and
 *  for some apps so does the visibility. Rather than trusting EVENT_OBJECT_SHOW to follow,
 *  re-examine the window once more after this delay. */
const CREATE_SETTLE_MS = 180

/** NAMECHANGE fires on every browser tab switch and every editor keystroke that touches the
 *  title bar. Coalesce, or the renderer re-renders the whole list dozens of times a second. */
const NOTIFY_DEBOUNCE_MS = 60

export function startTracking(): void {
  const startedAt = performance.now()
  shellWindow = getShellWindow()
  seedFromSweep()

  // Split into narrow ranges rather than one wide one. A single 0x8000-0x8018 subscription
  // would also deliver EVENT_OBJECT_LOCATIONCHANGE, which fires for every pixel of every
  // window drag on the machine — thousands of callbacks for events we ignore.
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

/** §5: sleep does not kill the process, but it does leave the hook subscription stale and
 *  the list frozen at its pre-sleep state. Tear it all down and build it again on resume. */
export function restartTracking(): void {
  stopTracking()
  cache.clear()
  mru = []
  processNames.clear()
  startTracking()
  log('window tracking rebuilt after resume')
  notify()
}

function subscribe(min: number, max: number): void {
  const hook = subscribeWinEvent(min, max, handleEvent)
  if (hook) hooks.push(hook)
  else console.error(`[ezzy] SetWinEventHook failed for range ${min}-${max}`)
}

// ------------------------------------------------------------------ the handler

function handleEvent(event: number, hwnd: Hwnd, idObject: number, idChild: number): void {
  // Every event also fires for scrollbars, carets, menu items and list rows inside a window.
  // Only the window object itself is of any interest here.
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
      // The title and the visible style land after creation, so look once now and once
      // after the window has settled.
      reconsider(hwnd)
      setTimeout(() => reconsider(hwnd), CREATE_SETTLE_MS)
      return
    case EVENT_OBJECT_SHOW:
    case EVENT_OBJECT_UNCLOAKED:
    case EVENT_OBJECT_NAMECHANGE:
      // All three mean "this window may have changed"; one path handles adding it, updating
      // its title and dropping it again.
      reconsider(hwnd)
      return
    default:
  }
}

/** Re-derive one window's membership and data. This is the only way anything enters the
 *  cache after the initial sweep. */
function reconsider(hwnd: Hwnd): void {
  if (!isSwitchable(hwnd)) {
    forget(hwnd)
    return
  }
  const title = getWindowTitle(hwnd)
  const existing = cache.get(hwnd)
  if (existing && existing.title === title) return

  cache.set(hwnd, { id: hwnd, title, app: existing?.app ?? appNameFor(hwnd) })
  if (!existing) {
    // A brand new window belongs at the top: it is about to be focused, and if it is not,
    // the next foreground event will put the right window there anyway.
    mru = [hwnd, ...mru.filter((id) => id !== hwnd)]
  }
  notify()
}

function forget(hwnd: Hwnd): void {
  if (!cache.delete(hwnd)) return
  mru = mru.filter((id) => id !== hwnd)
  notify()
}

/** Move a window to the front of the MRU. Ezzy's own panel takes focus when it opens, so
 *  our windows are filtered out here — otherwise the panel would insert itself at the top of
 *  its own list and "switch back to the last thing" would mean switching back to Ezzy. */
function promote(hwnd: Hwnd): void {
  if (!isSwitchable(hwnd)) return
  if (mru[0] === hwnd) return
  if (!cache.has(hwnd)) reconsider(hwnd)
  if (!cache.has(hwnd)) return
  mru = [hwnd, ...mru.filter((id) => id !== hwnd)]
  log(`foreground: ${cache.get(hwnd)?.title ?? hwnd}`)
  notify()
}

// ------------------------------------------------------------------- filtering

/** §5's filter, plus the owner walk Alt-Tab itself uses.
 *
 *  EnumWindows returns hundreds of windows that no user would call open: invisible shells,
 *  tool windows, message-only windows, and — the one that catches everybody — UWP apps that
 *  are suspended but still "visible", parked by DWM in a cloaked state. */
function isSwitchable(hwnd: Hwnd): boolean {
  if (hwnd === 0 || hwnd === shellWindow) return false
  if (!isWindow(hwnd) || !isWindowVisible(hwnd)) return false

  // Ezzy's own dot and panel. They are skipTaskbar and the dot is unfocusable, but the panel
  // is a real focusable window and would otherwise appear in its own list.
  if (getWindowProcessId(hwnd) === process.pid) return false

  const style = getExStyle(hwnd)
  if (style & WS_EX_TOOLWINDOW) return false
  if (style & WS_EX_NOACTIVATE) return false

  if (getWindowTitle(hwnd) === '') return false

  const rect = getWindowRect(hwnd)
  if (!rect || rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return false

  if (isCloaked(hwnd)) return false

  return isLastActivePopup(hwnd)
}

/** The owner walk: from a window's root owner, follow the active-popup chain to the window
 *  the user would actually be switched to. Only that one belongs in the list — this is what
 *  keeps a modal dialog from appearing alongside the parent window it has taken over. */
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

/** The subtitle for a row (§6): the owning application, not the window title. */
function appNameFor(hwnd: Hwnd): string {
  let pid = getWindowProcessId(hwnd)
  if (pid === 0) return ''

  const cached = processNames.get(pid)
  if (cached !== undefined) return cached

  let path = getProcessImagePath(pid)
  // A UWP window belongs to its host process; the app itself is in a child window.
  if (path && basename(path).toLowerCase() === 'applicationframehost.exe') {
    const hosted = findHostedChildProcessId(hwnd, pid)
    if (hosted !== 0) {
      pid = hosted
      const hostedCache = processNames.get(pid)
      if (hostedCache !== undefined) return hostedCache
      path = getProcessImagePath(pid)
    }
  }

  const name = path ? prettifyExecutable(basename(path)) : ''
  processNames.set(pid, name)
  return name
}

/** `chrome.exe` -> `Chrome`, `WINWORD.EXE` -> `Winword`, `CalculatorApp.exe` unchanged.
 *  Deliberately dumb: the real display names live in the Start Menu index, which is chunk
 *  C's job. This only has to stop the subtitle looking like a file listing. */
function prettifyExecutable(file: string): string {
  const stem = file.replace(/\.exe$/i, '')
  if (stem.length === 0) return ''
  // An all-caps stem is a shouty legacy name and reads better folded down; anything else
  // already carries its own casing and only needs its first letter raised.
  const rest = stem === stem.toUpperCase() ? stem.slice(1).toLowerCase() : stem.slice(1)
  return stem[0].toUpperCase() + rest
}

// -------------------------------------------------------------------- the list

function seedFromSweep(): void {
  // EnumWindows returns windows in Z-order, top first, which is the closest thing to an MRU
  // that exists before we have seen a single foreground event.
  for (const hwnd of enumerateTopLevelWindows()) {
    if (!isSwitchable(hwnd)) continue
    cache.set(hwnd, { id: hwnd, title: getWindowTitle(hwnd), app: appNameFor(hwnd) })
    mru.push(hwnd)
  }
  const foreground = getForegroundWindow()
  if (foreground && cache.has(foreground)) {
    mru = [foreground, ...mru.filter((id) => id !== foreground)]
  }
}

/** The cached list, MRU-ordered. Reading this is what the hotkey path does — no OS calls. */
export function listWindows(): EzzyWindow[] {
  const windows: EzzyWindow[] = []
  for (const id of mru) {
    const window = cache.get(id)
    if (window) windows.push({ ...window })
  }
  return windows
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
    log(`window list: ${windows.length} windows`)
    for (const listener of listeners) listener(windows)
  }, NOTIFY_DEBOUNCE_MS)
}
