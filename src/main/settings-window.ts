/** The settings window: hotkey, voice, speech, startup.
 *
 *  It is the one window in Ezzy that is an ordinary window. The other three are frameless,
 *  transparent, unfocusable furniture that must never appear in the taskbar; this one is
 *  something the user deliberately opened, wants in Alt-Tab while they are in it, and closes
 *  when they are done. It gets a frame, a taskbar entry and the system's own close button —
 *  the "furniture that disappears when not in use, not a settings app" is about the overlay,
 *  and this is the settings app.
 *
 *  A settings UI is the third thing to cut if the build runs late. It is here because
 *  the build did not: the hotkey is the one setting that cannot be cut, since the plan requires it to
 *  be configurable from day one and until now the only way to change it was to hand-edit
 *  config.json. */

import { BrowserWindow, app } from 'electron'
import icon from '../../resources/icon.png?asset'
import { EzzyConfig, IPC, SettingsResult, SettingsSnapshot } from '../shared/types'
import { getConfig, updateConfig } from './config'
import { activeHotkey, reapplyHotkey } from './hotkey'
import { applyLoginItem } from './login-item'
import { logFilePath } from './logger'
import { onUpdateStatus } from './updater'
import { releaseVoice } from './voice'
import { loadRenderer, webPreferences } from './windows'

/** Sized to the content rather than resizable: it is one column of eight rows, and there is
 *  nothing in it that benefits from being dragged wider. The height is measured against what
 *  the page actually lays out — the window cannot be resized, so anything that does not fit
 *  becomes a scrollbar on a form with nine controls in it. */
const WIDTH = 460
const HEIGHT = 760

let win: BrowserWindow | null = null
let stopWatchingUpdates: (() => void) | null = null

export function openSettingsWindow(): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    // The numbers above are the page, not the window: the title bar is the OS's and its
    // height is the user's DPI and theme, not ours. Without this the form is measured
    // including a frame it does not draw, and the footer ends up under a scrollbar.
    useContentSize: true,
    title: 'Ezzy',
    icon,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // nativeTheme is pinned to dark in index.ts, so the system frame comes out dark and the
    // page does not have to fake a title bar to match it.
    backgroundColor: '#14161c',
    autoHideMenuBar: true,
    webPreferences: webPreferences()
  })

  // Deliberately none of applyAlwaysPresent: no screen-saver level, no skipTaskbar, no close
  // interception. Closing this window closes it — the app lives in the tray regardless, so
  // there is nothing here to protect.
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    stopWatchingUpdates?.()
    stopWatchingUpdates = null
    win = null
  })

  // The window is open while an update downloads behind it, and a progress bar that only moves
  // when you reopen the window is worse than no progress bar.
  stopWatchingUpdates = onUpdateStatus((status) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.updateStatus, status)
  })

  loadRenderer(win, 'settings')
}

export function closeSettingsWindow(): void {
  win?.close()
}

export function settingsSnapshot(): SettingsSnapshot {
  return {
    config: getConfig(),
    activeHotkey: activeHotkey(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    logPath: logFilePath()
  }
}

/** Apply a change from the settings window.
 *
 *  Everything is written first and applied second, because the config file is the source of
 *  truth for all of it — `applyLoginItem` and `reapplyHotkey` both read it back rather than
 *  taking an argument, which is what keeps a setting that is changed here and a setting that is
 *  hand-edited into config.json from taking different paths. */
export function applySettings(patch: Partial<EzzyConfig>): SettingsResult {
  const before = getConfig()
  updateConfig(patch)

  if (patch.openAtLogin !== undefined && patch.openAtLogin !== before.openAtLogin) {
    applyLoginItem()
  }
  if (patch.voice !== undefined && patch.voice !== before.voice) releaseVoice()

  let hotkeyError: string | null = null
  if (patch.hotkey !== undefined && patch.hotkey !== before.hotkey) {
    const result = reapplyHotkey()
    // `globalShortcut.register` returning false is the normal case, not the exceptional
    // one — another launcher may already own Alt+Space. The fallback chain means Ezzy still
    // has *a* hotkey, so the failure is a sentence rather than a broken app.
    if (result.accelerator === null) {
      hotkeyError = 'Every shortcut Ezzy knows is taken. Try a different one.'
    } else if (result.usedFallback) {
      hotkeyError = `${patch.hotkey} is taken by another app, so Ezzy is using ${result.accelerator}.`
    }
  }

  return { snapshot: settingsSnapshot(), hotkeyError }
}
