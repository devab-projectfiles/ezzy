import { globalShortcut, powerMonitor } from 'electron'
import { getConfig } from './config'
import { log } from './verbose'

let registered: string | null = null
let trigger: () => void = () => {}

export function registerHotkey(onTrigger: () => void): boolean {
  trigger = onTrigger
  return apply()
}

/** §5: Alt+Space is the Windows system menu, so registration can legitimately fail. */
function apply(): boolean {
  const accelerator = getConfig().hotkey
  if (registered) {
    globalShortcut.unregister(registered)
    registered = null
  }
  let ok = false
  try {
    ok = globalShortcut.register(accelerator, trigger)
  } catch (err) {
    console.error(`[ezy] "${accelerator}" is not a valid accelerator:`, err)
    return false
  }
  if (ok) {
    registered = accelerator
    log(`hotkey registered: ${accelerator}`)
  } else {
    console.error(`[ezy] hotkey "${accelerator}" is already owned by another app`)
  }
  return ok
}

/** §5: on resume the hotkey is often silently unregistered while the process survives. */
export function watchForResume(): void {
  powerMonitor.on('resume', () => {
    log('resumed from sleep, re-registering hotkey')
    globalShortcut.unregisterAll()
    registered = null
    apply()
  })
}

export function unregisterHotkey(): void {
  globalShortcut.unregisterAll()
  registered = null
}
