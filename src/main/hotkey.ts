import { globalShortcut, powerMonitor } from 'electron'
import { getConfig } from './config'
import { log } from './verbose'

/** §5: Alt+Space is the Windows system menu and other launchers claim it too. Whoever
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

export function activeHotkey(): string | null {
  return active
}

export function registerHotkey(onTrigger: () => void): HotkeyResult {
  trigger = onTrigger
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
    return globalShortcut.register(accelerator, trigger)
  } catch (err) {
    console.error(`[ezzy] "${accelerator}" is not a valid accelerator:`, err)
    return false
  }
}

/** §5: on resume the hotkey is often silently unregistered while the process survives. */
export function watchForResume(onReRegistered: (result: HotkeyResult) => void): void {
  powerMonitor.on('resume', () => {
    log('resumed from sleep, re-registering hotkey')
    onReRegistered(apply())
  })
}

export function unregisterHotkey(): void {
  globalShortcut.unregisterAll()
  active = null
}
