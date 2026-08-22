import { app } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { getConfig, loadConfig } from './config'
import { registerHotkey, unregisterHotkey, watchForResume } from './hotkey'
import { registerIpc } from './ipc'
import { createTray, refreshTray } from './tray'
import {
  createWindows,
  setQuitting,
  showDot,
  stopWatchingCursor,
  togglePanel,
  watchCursor,
  watchDisplays
} from './windows'
import { log, since } from './verbose'

const startedAt = performance.now()

// §5: two copies fighting over one global hotkey is a confusing bug to diagnose.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showDot()
    togglePanel()
  })
  start()
}

function start(): void {
  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.ezzy.app')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    loadConfig()
    applyLoginItem()
    registerIpc()
    createWindows()
    watchDisplays()
    watchCursor()
    const hotkey = registerHotkey(togglePanel)
    watchForResume(() => refreshTray())
    createTray(quit, hotkey)

    since('cold start -> tray ready', startedAt)
  })

  // Ezzy is furniture, not a window you close. Subscribing here overrides Electron's
  // default of quitting once the last window goes away (§5, item 4).
  app.on('window-all-closed', () => {})

  app.on('will-quit', () => {
    unregisterHotkey()
    stopWatchingCursor()
  })
}

function quit(): void {
  setQuitting(true)
  app.quit()
}

/** §5, item 5. In dev this would register the Electron binary rather than Ezzy, so it is
 *  only applied to packaged builds — which is also the only place it can be tested. */
function applyLoginItem(): void {
  if (!app.isPackaged) {
    log('openAtLogin skipped: only applied in a packaged build')
    return
  }
  app.setLoginItemSettings({ openAtLogin: getConfig().openAtLogin })
}
