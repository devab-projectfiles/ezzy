import { globalShortcut, powerMonitor } from 'electron'
import { getConfig } from './config'
import { log } from './verbose'
import { isKeyDown } from './win32'

// Alt+Space is the Windows system menu and other launchers claim it too; whoever registers
// first wins, so a fixed default alone can leave Ezzy silently without a hotkey.
const FALLBACKS = ['Alt+Space', 'Ctrl+Alt+Space', 'Alt+Shift+Space', 'Ctrl+Shift+Space']

export interface HotkeyResult {
  accelerator: string | null
  usedFallback: boolean
}

let active: string | null = null
let trigger: () => void = () => {}
let hold: HoldHandlers | null = null
let holdKey: number | null = null
let holdPoll: ReturnType<typeof setInterval> | null = null
let holding = false

// Long enough that a deliberate tap (60-120ms) never records; short enough the mic is live
// before anyone finishes drawing breath.
const HOLD_MS = 350
const HOLD_POLL_MS = 25
// A press still unreleased this long is a missed key event, not a patient user.
const MAX_HOLD_MS = 30_000

export interface HoldHandlers {
  onPress(): void
  onHold(): void
  onRelease(held: boolean): void
}

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

// Windows repeats WM_HOTKEY for as long as the key is held; repeats are dropped here so a
// held key doesn't re-trigger mid-utterance.
function onHotkey(): void {
  if (holdPoll) return
  // The microphone first: opening the audio device already costs 225-960ms of words.
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

// Returns null for anything not in the table, which costs push-to-talk on that hotkey and
// nothing else — better than guessing at a keycode and watching the wrong key.
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

// On resume the hotkey is often silently unregistered while the process survives.
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
