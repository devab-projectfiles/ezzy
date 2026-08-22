/** The Win32 calls chunk B needs, bound through koffi (PLAN.md §3).
 *
 *  Everything here is a thin, typed wrapper over user32/kernel32/dwmapi — no policy and no
 *  caching. The rules about *which* windows count live in window-tracker.ts, and the
 *  foreground dance lives in focus.ts.
 *
 *  HWNDs, HANDLEs and thread ids cross as `uintptr_t`. Window handles carry only 32
 *  significant bits on Windows, so they arrive as ordinary safe integers and can be
 *  compared, used as Map keys and sent over IPC as plain numbers. */

import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const dwmapi = koffi.load('dwmapi.dll')
const gdi32 = koffi.load('gdi32.dll')

/** A window handle. Zero is the null handle, which every call below treats as "no window". */
export type Hwnd = number

// ------------------------------------------------------------------ constants

export const GWL_EXSTYLE = -20
export const WS_EX_TOOLWINDOW = 0x0000_0080
export const WS_EX_NOACTIVATE = 0x0800_0000

/** GetAncestor flags. */
export const GA_ROOTOWNER = 3

/** DwmGetWindowAttribute: UWP parks suspended apps as cloaked windows, which are invisible
 *  but still pass every IsWindowVisible check (§5). */
export const DWMWA_CLOAKED = 14

export const SW_RESTORE = 9

/** The WinEvents we subscribe to. §5: subscribe, never poll EnumWindows. */
export const EVENT_SYSTEM_FOREGROUND = 0x0003
export const EVENT_OBJECT_CREATE = 0x8000
export const EVENT_OBJECT_DESTROY = 0x8001
export const EVENT_OBJECT_SHOW = 0x8002
export const EVENT_OBJECT_HIDE = 0x8003
export const EVENT_OBJECT_NAMECHANGE = 0x800c
export const EVENT_OBJECT_CLOAKED = 0x8017
export const EVENT_OBJECT_UNCLOAKED = 0x8018

/** The event refers to the window itself, not to a control or caret inside it. */
export const OBJID_WINDOW = 0
export const CHILDID_SELF = 0

/** Out-of-context hooks are delivered as ordinary messages on the thread that registered
 *  them, so that thread has to be pumping messages. Electron's main thread runs a Windows
 *  message loop, which is what makes this work at all — an in-context hook would need a DLL
 *  injected into every process on the machine. */
export const WINEVENT_OUTOFCONTEXT = 0x0000

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** keybd_event flags, for the synthetic ALT in focus.ts. */
const KEYEVENTF_KEYUP = 0x0002
const VK_MENU = 0x12

// ------------------------------------------------------------------- bindings

// Registered by name in koffi's type table; the prototypes below refer to it as 'RECT'.
koffi.struct('RECT', {
  left: 'int32_t',
  top: 'int32_t',
  right: 'int32_t',
  bottom: 'int32_t'
})

const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(uintptr_t hwnd, intptr_t lp)')
const WinEventProc = koffi.proto(
  'void __stdcall WinEventProc(uintptr_t hook, uint32_t event, uintptr_t hwnd, int32_t idObject, int32_t idChild, uint32_t thread, uint32_t time)'
)

const fn = {
  EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lp)'),
  EnumChildWindows: user32.func(
    'bool __stdcall EnumChildWindows(uintptr_t parent, EnumWindowsProc *cb, intptr_t lp)'
  ),
  IsWindow: user32.func('bool __stdcall IsWindow(uintptr_t hwnd)'),
  IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(uintptr_t hwnd)'),
  IsIconic: user32.func('bool __stdcall IsIconic(uintptr_t hwnd)'),
  GetWindowTextW: user32.func(
    'int __stdcall GetWindowTextW(uintptr_t hwnd, _Out_ uint16_t *buf, int max)'
  ),
  GetWindowRect: user32.func('bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ RECT *rect)'),
  GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)'),
  GetWindowThreadProcessId: user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)'
  ),
  GetAncestor: user32.func('uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32_t flags)'),
  GetLastActivePopup: user32.func('uintptr_t __stdcall GetLastActivePopup(uintptr_t hwnd)'),
  GetShellWindow: user32.func('uintptr_t __stdcall GetShellWindow()'),
  GetForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
  SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(uintptr_t hwnd)'),
  BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(uintptr_t hwnd)'),
  ShowWindow: user32.func('bool __stdcall ShowWindow(uintptr_t hwnd, int cmd)'),
  AttachThreadInput: user32.func(
    'bool __stdcall AttachThreadInput(uint32_t attach, uint32_t attachTo, bool join)'
  ),
  AllowSetForegroundWindow: user32.func('bool __stdcall AllowSetForegroundWindow(uint32_t pid)'),
  keybd_event: user32.func(
    'void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)'
  ),
  SetWinEventHook: user32.func(
    'uintptr_t __stdcall SetWinEventHook(uint32_t min, uint32_t max, uintptr_t module, WinEventProc *cb, uint32_t pid, uint32_t thread, uint32_t flags)'
  ),
  UnhookWinEvent: user32.func('bool __stdcall UnhookWinEvent(uintptr_t hook)'),
  GetCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
  OpenProcess: kernel32.func(
    'uintptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'
  ),
  CloseHandle: kernel32.func('bool __stdcall CloseHandle(uintptr_t handle)'),
  QueryFullProcessImageNameW: kernel32.func(
    'bool __stdcall QueryFullProcessImageNameW(uintptr_t proc, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'
  ),
  DwmGetWindowAttribute: dwmapi.func(
    'int32_t __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32_t attr, _Out_ int32_t *value, uint32_t size)'
  ),
  SetWindowRgn: user32.func(
    'int __stdcall SetWindowRgn(uintptr_t hwnd, uintptr_t region, bool redraw)'
  ),
  CreateRoundRectRgn: gdi32.func(
    'uintptr_t __stdcall CreateRoundRectRgn(int l, int t, int r, int b, int w, int h)'
  ),
  DeleteObject: gdi32.func('bool __stdcall DeleteObject(uintptr_t object)')
}

// --------------------------------------------------------------------- window

export function isWindow(hwnd: Hwnd): boolean {
  return fn.IsWindow(hwnd)
}

export function isWindowVisible(hwnd: Hwnd): boolean {
  return fn.IsWindowVisible(hwnd)
}

export function isIconic(hwnd: Hwnd): boolean {
  return fn.IsIconic(hwnd)
}

/** Titles are read into one reused buffer rather than being sized with GetWindowTextLengthW
 *  first: that would double the cross-process calls per window for a limit no real window
 *  reaches. Reuse is safe because every caller decodes before the next call. */
const titleBuffer = new Uint16Array(512)

export function getWindowTitle(hwnd: Hwnd): string {
  const length = fn.GetWindowTextW(hwnd, titleBuffer, titleBuffer.length)
  if (length <= 0) return ''
  return Buffer.from(titleBuffer.buffer, 0, length * 2).toString('utf16le')
}

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export function getWindowRect(hwnd: Hwnd): Rect | null {
  const rect = {} as Rect
  if (!fn.GetWindowRect(hwnd, rect)) return null
  return rect
}

export function getExStyle(hwnd: Hwnd): number {
  return Number(fn.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
}

export function getAncestor(hwnd: Hwnd, flags: number): Hwnd {
  return fn.GetAncestor(hwnd, flags)
}

export function getLastActivePopup(hwnd: Hwnd): Hwnd {
  return fn.GetLastActivePopup(hwnd)
}

export function getShellWindow(): Hwnd {
  return fn.GetShellWindow()
}

/** True when DWM is hiding the window — how UWP parks a suspended app (§5). A non-zero
 *  HRESULT means the attribute is unsupported, which is not the same as "cloaked". */
export function isCloaked(hwnd: Hwnd): boolean {
  const out = [0]
  if (fn.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out, 4) !== 0) return false
  return out[0] !== 0
}

const pidOut = [0]

export function getWindowProcessId(hwnd: Hwnd): number {
  fn.GetWindowThreadProcessId(hwnd, pidOut)
  return pidOut[0]
}

export function getWindowThreadId(hwnd: Hwnd): number {
  return fn.GetWindowThreadProcessId(hwnd, pidOut)
}

/** Full path of a process's executable, or null when it is protected or already gone.
 *  PROCESS_QUERY_LIMITED_INFORMATION is the access right that works without elevation,
 *  which matters because plenty of ordinary windows belong to processes we cannot open. */
export function getProcessImagePath(pid: number): string | null {
  const handle = fn.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return null
  try {
    const buffer = new Uint16Array(1024)
    const size = [buffer.length]
    if (!fn.QueryFullProcessImageNameW(handle, 0, buffer, size)) return null
    return Buffer.from(buffer.buffer, 0, size[0] * 2).toString('utf16le')
  } finally {
    fn.CloseHandle(handle)
  }
}

/** A full sweep of top-level windows. Used exactly once, to seed the cache at startup —
 *  after that the WinEvent hooks keep it current. §5: never poll this. */
export function enumerateTopLevelWindows(): Hwnd[] {
  const found: Hwnd[] = []
  const callback = koffi.register((hwnd: Hwnd): boolean => {
    found.push(hwnd)
    return true
  }, koffi.pointer(EnumWindowsProc))
  try {
    fn.EnumWindows(callback, 0)
  } finally {
    koffi.unregister(callback)
  }
  return found
}

/** The first child window belonging to a different process than `hwnd`.
 *
 *  UWP apps are hosted: the window you see belongs to ApplicationFrameHost.exe, and the app
 *  that owns it — Calculator, Settings, Store — sits in a child window underneath. Without
 *  this every Store app in the list would be subtitled "Application Frame Host". */
export function findHostedChildProcessId(hwnd: Hwnd, hostPid: number): number {
  let found = 0
  const callback = koffi.register((child: Hwnd): boolean => {
    const pid = getWindowProcessId(child)
    if (pid !== 0 && pid !== hostPid) {
      found = pid
      return false
    }
    return true
  }, koffi.pointer(EnumWindowsProc))
  try {
    fn.EnumChildWindows(hwnd, callback, 0)
  } finally {
    koffi.unregister(callback)
  }
  return found
}

/** Clip a window to a rounded rectangle, in PHYSICAL pixels.
 *
 *  §6 asks for a 27px pill and 24px corners, and with `backgroundMaterial: 'acrylic'` neither
 *  can come from CSS: DWM paints the material behind the page, so a CSS border-radius rounds
 *  the content and leaves the material filling the square underneath. DWM's own rounding is a
 *  fixed ~8px and is not adjustable. The window region is the only thing that clips the
 *  material itself.
 *
 *  The cost is that a region is not anti-aliased — the curve is a hard pixel staircase. That
 *  is the price of real acrylic over a transparent window, which is the trade §6 made. */
export function setRoundedRegion(hwnd: Hwnd, width: number, height: number, radius: number): void {
  // CreateRoundRectRgn takes the ellipse's full width and height, not its radius, and its
  // right/bottom bounds are exclusive.
  const region = fn.CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2)
  if (!region) return
  // On success the system owns the region and it must not be deleted; on failure it would
  // leak unless we delete it ourselves.
  if (fn.SetWindowRgn(hwnd, region, true) === 0) fn.DeleteObject(region)
}

// ------------------------------------------------------------------ foreground

export function getForegroundWindow(): Hwnd {
  return fn.GetForegroundWindow()
}

export function setForegroundWindow(hwnd: Hwnd): boolean {
  return fn.SetForegroundWindow(hwnd)
}

export function bringWindowToTop(hwnd: Hwnd): boolean {
  return fn.BringWindowToTop(hwnd)
}

export function showWindow(hwnd: Hwnd, command: number): boolean {
  return fn.ShowWindow(hwnd, command)
}

export function attachThreadInput(attach: number, attachTo: number, join: boolean): boolean {
  return fn.AttachThreadInput(attach, attachTo, join)
}

export function allowSetForegroundWindow(pid: number): boolean {
  return fn.AllowSetForegroundWindow(pid)
}

export function currentThreadId(): number {
  return fn.GetCurrentThreadId()
}

/** A synthetic ALT press. Windows treats it as user input, which releases the foreground
 *  lock for a moment — the fallback half of the workaround in focus.ts. */
export function tapAltKey(): void {
  fn.keybd_event(VK_MENU, 0, 0, 0)
  fn.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
}

// ----------------------------------------------------------------- win events

export type WinEventCallback = (
  event: number,
  hwnd: Hwnd,
  idObject: number,
  idChild: number
) => void

export interface WinEventHook {
  unhook(): void
}

/** Subscribe to a WinEvent range. The koffi callback is registered rather than transient, so
 *  it outlives this call and stays valid until unhook(); letting it be collected would leave
 *  Windows calling into freed memory. Returns null if Windows refuses the hook. */
export function subscribeWinEvent(
  min: number,
  max: number,
  callback: WinEventCallback
): WinEventHook | null {
  const pointer = koffi.register(
    (_hook: number, event: number, hwnd: Hwnd, idObject: number, idChild: number): void => {
      // This runs inside Windows' message dispatch on the main thread. An exception thrown
      // here would unwind through native frames, so nothing is allowed to escape.
      try {
        callback(event, hwnd, idObject, idChild)
      } catch (err) {
        console.error('[ezzy] win event handler threw:', err)
      }
    },
    koffi.pointer(WinEventProc)
  )

  const handle = fn.SetWinEventHook(min, max, 0, pointer, 0, 0, WINEVENT_OUTOFCONTEXT)
  if (!handle) {
    koffi.unregister(pointer)
    return null
  }
  return {
    unhook(): void {
      fn.UnhookWinEvent(handle)
      koffi.unregister(pointer)
    }
  }
}
