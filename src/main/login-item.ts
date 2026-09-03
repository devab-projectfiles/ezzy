/** Ezzy has to survive a restart to feel permanent.
 *
 *  Its own file because two places set it — startup, and the settings window's startup toggle
 *  — and because both need the same caveat. In dev this registers the Electron
 *  binary rather than Ezzy, so it is applied to packaged builds only, which is also the only
 *  place it can honestly be tested. */

import { app } from 'electron'
import { getConfig } from './config'
import { log } from './verbose'

export function applyLoginItem(): void {
  if (!app.isPackaged) {
    log('openAtLogin skipped: only applied in a packaged build')
    return
  }
  app.setLoginItemSettings({ openAtLogin: getConfig().openAtLogin })
}
