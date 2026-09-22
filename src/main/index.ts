import { app, nativeTheme } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { loadConfig } from './config'
import { registerHotkey, unregisterHotkey, watchForResume } from './hotkey'
import { registerIpc } from './ipc'
import { createTray, refreshTray } from './tray'
import {
  createWindows,
  publishPanelData,
  setQuitting,
  showDot,
  stopWatchingCursor,
  togglePanel,
  watchCursor,
  watchDisplays
} from './windows'
import { restartTracking, startTracking, stopTracking } from './window-tracker'
import { onPanelDataChanged } from './panel-data'
import { refreshAppIndex, startAppIndex } from './app-index'
import { loadIconCache } from './icons'
import { initVoice } from './voice'
import { stopWhisperServer } from './stt'
import { since } from './verbose'
import { startLogging } from './logger'
import { applyLoginItem } from './login-item'
import { startUpdater, stopUpdater } from './updater'

const startedAt = performance.now()

// Two copies fighting over one global hotkey is a confusing bug to diagnose.
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

    // The surfaces are transparent and always white-on-dark-glass, so nothing should
    // follow the OS into light mode and invert the text under them.
    nativeTheme.themeSource = 'dark'

    // First, so that everything below this line — including anything that throws on the way
    // up — is in the file a user can attach to an issue.
    startLogging()
    loadConfig()
    applyLoginItem()
    registerIpc()
    createWindows()
    watchDisplays()
    watchCursor()
    // Hooks are registered after app.whenReady because SetWinEventHook delivers through the
    // thread's message loop, and Electron only has one running from here onward.
    startTracking()
    onPanelDataChanged(publishPanelData)
    // Scanning the Start Menu touches a few hundred directories, so it is deliberately
    // not awaited — the window list is what the panel needs in the first 50ms, and the
    // apps section fills in behind it. The icon cache is read first so a warm start has
    // icons on the very first panel.
    void loadIconCache().then(startAppIndex)
    const hotkey = registerHotkey(togglePanel)
    // Push-to-talk hangs off the same hotkey: a tap toggles the panel, a hold listens —
    // nothing here loads a model until the key is actually held.
    initVoice()
    watchForResume(() => {
      refreshTray()
      // The process survives sleep but the hook subscription does not, which leaves the
      // list frozen at its pre-sleep state with no visible symptom until you look for it.
      restartTracking()
      // Apps installed while the machine slept would otherwise be missing until a restart.
      void refreshAppIndex()
    })
    createTray(quit, hotkey)
    // Last, and on a timer of its own inside — nothing about it belongs on the startup path.
    startUpdater()

    since('cold start -> tray ready', startedAt)
  })

  // Ezzy is furniture, not a window you close. Subscribing here overrides Electron's
  // default of quitting once the last window goes away.
  app.on('window-all-closed', () => {})

  app.on('will-quit', () => {
    unregisterHotkey()
    stopUpdater()
    stopWatchingCursor()
    // Leaving a WinEvent hook behind makes Windows keep calling into a process that is on
    // its way out.
    stopTracking()
    // whisper-server is our child but not Windows' responsibility — nothing kills it for
    // us, and a stray one holds 300MB and a port for as long as the session lasts.
    stopWhisperServer()
  })
}

function quit(): void {
  setQuitting(true)
  app.quit()
}
