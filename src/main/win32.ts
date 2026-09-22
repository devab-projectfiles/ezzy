/** The Win32 calls this app needs, bound through koffi. Window handles cross as
 *  `uintptr_t` — they carry only 32 significant bits on Windows, so they arrive as
 *  ordinary safe integers usable as Map keys and sent over IPC as plain numbers. */

import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const dwmapi = koffi.load('dwmapi.dll')
const powrprof = koffi.load('powrprof.dll')

export type Hwnd = number

export const GWL_EXSTYLE = -20
export const WS_EX_TOOLWINDOW = 0x0000_0080
export const WS_EX_NOACTIVATE = 0x0800_0000
export const WS_EX_TRANSPARENT = 0x0000_0020
export const GA_ROOTOWNER = 3
export const DWMWA_CLOAKED = 14
export const SW_RESTORE = 9
export const WM_CLOSE = 0x0010
export const WM_APPCOMMAND = 0x0319
export const APPCOMMAND_MEDIA_PLAY_PAUSE = 14
export const APPCOMMAND_MEDIA_NEXTTRACK = 11
export const APPCOMMAND_MEDIA_PREVIOUSTRACK = 12
export const APPCOMMAND_MEDIA_PLAY = 46
export const APPCOMMAND_MEDIA_PAUSE = 47

export const EVENT_SYSTEM_FOREGROUND = 0x0003
export const EVENT_OBJECT_CREATE = 0x8000
export const EVENT_OBJECT_DESTROY = 0x8001
export const EVENT_OBJECT_SHOW = 0x8002
export const EVENT_OBJECT_HIDE = 0x8003
export const EVENT_OBJECT_NAMECHANGE = 0x800c
export const EVENT_OBJECT_CLOAKED = 0x8017
export const EVENT_OBJECT_UNCLOAKED = 0x8018

export const OBJID_WINDOW = 0
export const CHILDID_SELF = 0
export const WINEVENT_OUTOFCONTEXT = 0x0000

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_EXTENDEDKEY = 0x0001
const VK_MENU = 0x12

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
  PostMessageW: user32.func(
    'bool __stdcall PostMessageW(uintptr_t hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)'
  ),
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
  GetAsyncKeyState: user32.func('int16_t __stdcall GetAsyncKeyState(int vk)'),
  GetCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
  OpenProcess: kernel32.func(
    'uintptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'
  ),
  CloseHandle: kernel32.func('bool __stdcall CloseHandle(uintptr_t handle)'),
  QueryFullProcessImageNameW: kernel32.func(
    'bool __stdcall QueryFullProcessImageNameW(uintptr_t proc, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'
  ),
  SetSuspendState: powrprof.func(
    'bool __stdcall SetSuspendState(bool hibernate, bool force, bool wakeupEventsDisabled)'
  ),
  DwmGetWindowAttribute: dwmapi.func(
    'int32_t __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32_t attr, _Out_ int32_t *value, uint32_t size)'
  )
}

export function isWindow(hwnd: Hwnd): boolean {
  return fn.IsWindow(hwnd)
}

export function isWindowVisible(hwnd: Hwnd): boolean {
  return fn.IsWindowVisible(hwnd)
}

export function isIconic(hwnd: Hwnd): boolean {
  return fn.IsIconic(hwnd)
}

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

/** PROCESS_QUERY_LIMITED_INFORMATION works without elevation. */
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

/** Used once, to seed the cache at startup — WinEvent hooks keep it current after that. */
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

/** A UWP window belongs to ApplicationFrameHost.exe; the app itself is a child window. */
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

export function closeWindow(hwnd: Hwnd): boolean {
  return fn.PostMessageW(hwnd, WM_CLOSE, 0, 0)
}

export function postAppCommand(hwnd: Hwnd, command: number): boolean {
  return fn.PostMessageW(hwnd, WM_APPCOMMAND, hwnd, command << 16)
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

export function tapAltKey(): void {
  fn.keybd_event(VK_MENU, 0, 0, 0)
  fn.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
}

export function tapExtendedKey(vk: number): void {
  fn.keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY, 0)
  fn.keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0)
}

export function isKeyDown(vk: number): boolean {
  return (fn.GetAsyncKeyState(vk) & 0x8000) !== 0
}

export function suspend(hibernate: boolean): boolean {
  return fn.SetSuspendState(hibernate, false, false)
}

export type WinEventCallback = (
  event: number,
  hwnd: Hwnd,
  idObject: number,
  idChild: number
) => void

export interface WinEventHook {
  unhook(): void
}

export function subscribeWinEvent(
  min: number,
  max: number,
  callback: WinEventCallback
): WinEventHook | null {
  const pointer = koffi.register(
    (_hook: number, event: number, hwnd: Hwnd, idObject: number, idChild: number): void => {
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
