/** Bringing someone else's window to the front.
 *
 *  SetForegroundWindow silently fails for us — Windows only lets the process that
 *  already owns the foreground change it, and Ezzy's dot (`focusable: false`) never is.
 *
 *  The workaround, in order: (1) AttachThreadInput our thread to both the outgoing
 *  foreground window's thread and the target's — while threads share an input queue,
 *  Windows treats them as one actor and the restriction lifts; (2) if a full-screen or
 *  elevated app still refuses, tap a synthetic ALT (Windows counts it as user input and
 *  drops the foreground lock for a moment), then retry the attach.
 *
 *  Both attempts verify against GetForegroundWindow rather than the return value, since
 *  SetForegroundWindow returns true in cases where it only queued a flash. */

import { since } from './verbose'
import {
  Hwnd,
  SW_RESTORE,
  allowSetForegroundWindow,
  attachThreadInput,
  bringWindowToTop,
  currentThreadId,
  getForegroundWindow,
  getWindowThreadId,
  isIconic,
  isWindow,
  setForegroundWindow,
  showWindow,
  tapAltKey
} from './win32'

/** Passed to AllowSetForegroundWindow to mean "any process may take the foreground". We are
 *  giving away a privilege we are about to use ourselves, which is exactly the point: the
 *  target process may be the one that ends up making the call. */
const ASFW_ANY = 0xffff_ffff

export function focusWindow(hwnd: Hwnd): boolean {
  const startedAt = performance.now()
  if (!hwnd || !isWindow(hwnd)) return false

  // A minimised window cannot take the foreground; restore it first. This also un-minimises
  // as a side effect, which is what the user means by "switch to it".
  if (isIconic(hwnd)) showWindow(hwnd, SW_RESTORE)

  if (getForegroundWindow() === hwnd) {
    since('selection -> target window in front', startedAt)
    return true
  }

  if (attemptForeground(hwnd)) {
    since('selection -> target window in front', startedAt)
    return true
  }

  // Second attempt: convince Windows that user input just happened.
  tapAltKey()
  const ok = attemptForeground(hwnd)
  since('selection -> target window in front (alt fallback)', startedAt)
  return ok
}

/** One pass of the AttachThreadInput dance. Attaching is refcounted per thread pair, so
 *  every attach here is matched by a detach — including on the failure paths, or our input
 *  queue stays welded to another app's and Ezzy's own windows stop responding. */
function attemptForeground(hwnd: Hwnd): boolean {
  const ourThread = currentThreadId()
  const targetThread = getWindowThreadId(hwnd)
  const foreground = getForegroundWindow()
  const foregroundThread = foreground ? getWindowThreadId(foreground) : 0

  // Attaching a thread to itself fails and would leave an unbalanced detach behind.
  const attachTarget = targetThread !== 0 && targetThread !== ourThread
  const attachForeground =
    foregroundThread !== 0 && foregroundThread !== ourThread && foregroundThread !== targetThread

  if (attachTarget) attachThreadInput(ourThread, targetThread, true)
  if (attachForeground) attachThreadInput(ourThread, foregroundThread, true)

  try {
    allowSetForegroundWindow(ASFW_ANY)
    bringWindowToTop(hwnd)
    setForegroundWindow(hwnd)
  } finally {
    if (attachForeground) attachThreadInput(ourThread, foregroundThread, false)
    if (attachTarget) attachThreadInput(ourThread, targetThread, false)
  }

  return getForegroundWindow() === hwnd
}
