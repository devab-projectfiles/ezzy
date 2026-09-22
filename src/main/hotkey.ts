import { globalShortcut, powerMonitor } from 'electron'
import { getConfig } from './config'
import { log } from './verbose'
import { isKeyDown } from './win32'

/** Alt+Space is the Windows system menu and other launchers claim it too. Whoever
 *  registers first wins, so a fixed default alone leaves Ezzy silently without a hotkey. */
const FALLBACKS = ['Alt+Space', 'Ctrl+Alt+Space', 'Alt+Shift+Space', 'Ctrl+Shift+Space']

export interface HotkeyResult {
  /** The accelerator actually in force, or null if every candidate was taken. */
  accelerator: string | null
  /** True when the configured hotkey was unavailable and a fallback took over. */
  usedFallback: boolean
}

let active: string | null = null
let trigger: () => void = () => {}
let hold: HoldHandlers | null = null
/** The virtual-key code of the active hotkey's main key, or null when we cannot work it out.
 *  Without it there is no push-to-talk on that accelerator — see `holdKeyOf`. */
let holdKey: number | null = null
/** Runs only between a press and its release. */
let holdPoll: ReturnType<typeof setInterval> | null = null
let holding = false

/** How long the hotkey has to be held before it means "listen" rather than "open the panel".
 *
 *  Long enough that a deliberate tap never records — a tap is 60-120ms — and short enough that
 *  the microphone is live before anyone finishes drawing breath. */
const HOLD_MS = 350

/** GetAsyncKeyState is one call into user32 and this only runs while the key is down, so the
 *  rate is set by how soon the release has to be noticed rather than by its cost. */
const HOLD_POLL_MS = 25

/** A press still unreleased after this long is a key event we missed, not a patient user —
 *  the same guard the drag has. Without it a lost release would leave the recorder running. */
const MAX_HOLD_MS = 30_000

export interface HoldHandlers {
  /** The hotkey has gone down, and it is not yet known whether this is a tap or a hold.
   *  Voice uses this to open the microphone early — see VoiceCapture. */
  onPress(): void
  /** The hotkey has been held past HOLD_MS. */
  onHold(): void
  /** It has come back up. Always called, whether or not the press became a hold, so the
   *  handler can throw away a recording that turned out to be a tap. `held` says which. */
  onRelease(held: boolean): void
}

/** Push-to-talk. The hotkey is the one key Ezzy already owns, so holding it is
 *  what starts listening; a tap still toggles the panel and never touches this path. */
export function watchHold(handlers: HoldHandlers): void {
  hold = handlers
}

export function activeHotkey(): string | null {
  return active
}

export function registerHotkey(onTrigger: () => void): HotkeyResult {
  trigger = onTrigger
  return apply()
}

/** Re-register against the config as it stands now. The result says whether the OS
 *  actually gave us what was asked for, so the settings window can report back — a
 *  hotkey another app already owns has to say so. */
export function reapplyHotkey(): HotkeyResult {
  return apply()
}

function apply(): HotkeyResult {
  globalShortcut.unregisterAll()
  active = null

  const preferred = getConfig().hotkey
  const candidates = [preferred, ...FALLBACKS.filter((key) => key !== preferred)]

  for (const accelerator of candidates) {
    if (!tryRegister(accelerator)) continue
    active = accelerator
    // Worked out once per registration rather than per press: it never changes while an
    // accelerator is in force, and it logs when it cannot be worked out.
    holdKey = holdKeyOf(accelerator)
    const usedFallback = accelerator !== preferred
    if (usedFallback) {
      console.warn(`[ezzy] "${preferred}" is unavailable, using "${accelerator}"`)
    } else {
      log(`hotkey registered: ${accelerator}`)
    }
    return { accelerator, usedFallback }
  }

  console.error(`[ezzy] no hotkey available; tried ${candidates.join(', ')}`)
  return { accelerator: null, usedFallback: false }
}

function tryRegister(accelerator: string): boolean {
  try {
    return globalShortcut.register(accelerator, onHotkey)
  } catch (err) {
    console.error(`[ezzy] "${accelerator}" is not a valid accelerator:`, err)
    return false
  }
}

/** One press of the hotkey.
 *
 *  Windows repeats WM_HOTKEY for as long as the key is held, and Electron passes every repeat
 *  through. Before push-to-talk that was invisible — holding Alt+Space flickered the panel
 *  open and shut, which nobody does on purpose. Now it would also re-trigger mid-utterance, so
 *  the repeats are dropped: the press is over when the key comes back up, not before. */
function onHotkey(): void {
  if (holdPoll) return
  // The microphone first, the panel second — opening the audio device already costs the
  // user words (225-960ms, recording nothing), and the panel show is a window show, a
  // bounds calculation and two IPC sends that would otherwise sit in front of it.
  if (holdKey !== null) hold?.onPress()
  trigger()
  if (holdKey === null) return
  watchTheKey(holdKey)
}

function watchTheKey(vk: number): void {
  const pressedAt = performance.now()
  holding = false
  holdPoll = setInterval(() => {
    const elapsed = performance.now() - pressedAt
    if (!isKeyDown(vk)) {
      endPress()
      return
    }
    if (elapsed > MAX_HOLD_MS) {
      log('hotkey held past its safety timeout, treating it as released')
      endPress()
      return
    }
    if (holding || elapsed < HOLD_MS || !hold) return
    holding = true
    hold.onHold()
  }, HOLD_POLL_MS)
}

function endPress(): void {
  if (holdPoll) clearInterval(holdPoll)
  holdPoll = null
  const wasHeld = holding
  holding = false
  hold?.onRelease(wasHeld)
}

/** Named keys Electron's accelerators use, mapped to the virtual-key codes GetAsyncKeyState
 *  wants. Letters and digits are handled by their character code below, which leaves the ones
 *  with names — and only the ones anyone would actually bind a launcher to. */
const NAMED_KEYS: Record<string, number> = {
  space: 0x20,
  tab: 0x09,
  backspace: 0x08,
  enter: 0x0d,
  return: 0x0d,
  esc: 0x1b,
  escape: 0x1b,
  insert: 0x2d,
  delete: 0x2e,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  capslock: 0x14
}

/** The virtual-key code of the accelerator's main key — the one part of it that is not a
 *  modifier. Push-to-talk watches that key alone: releasing Alt first and Space second is
 *  still one release as far as the user is concerned.
 *
 *  Returns null for anything not in the table, which costs the user push-to-talk on that
 *  hotkey and nothing else. Better than guessing at a keycode and watching the wrong key. */
function holdKeyOf(accelerator: string): number | null {
  const parts = accelerator.split('+')
  const key = (parts[parts.length - 1] ?? '').trim().toLowerCase()
  if (key.length === 1 && /[a-z0-9]/.test(key)) return key.toUpperCase().charCodeAt(0)
  const fkey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(key)
  if (fkey) return 0x70 + Number(fkey[1]) - 1
  const named = NAMED_KEYS[key]
  if (named !== undefined) return named
  log(`no virtual-key code for "${key}", so push-to-talk is off on this hotkey`)
  return null
}

/** On resume the hotkey is often silently unregistered while the process survives. */
export function watchForResume(onReRegistered: (result: HotkeyResult) => void): void {
  powerMonitor.on('resume', () => {
    log('resumed from sleep, re-registering hotkey')
    onReRegistered(apply())
  })
}

export function unregisterHotkey(): void {
  globalShortcut.unregisterAll()
  active = null
  if (holdPoll) clearInterval(holdPoll)
  holdPoll = null
  holding = false
}
