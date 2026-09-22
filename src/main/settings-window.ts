/** The settings window: hotkey, voice, speech, startup.
 *
 *  It is the one window in Ezzy that is an ordinary window. The other three are
 *  frameless, transparent, unfocusable furniture that must never appear in the taskbar;
 *  this one is something the user deliberately opened and closes when done — it gets a
 *  frame, a taskbar entry and the system's own close button. */

import { BrowserWindow, app } from 'electron'
import icon from '../../resources/icon.png?asset'
import { Appearance, EzzyConfig, IPC, SettingsResult, SettingsSnapshot } from '../shared/types'
import { getConfig, updateConfig } from './config'
import { activeHotkey, reapplyHotkey } from './hotkey'
import { applyLoginItem } from './login-item'
import { logFilePath } from './logger'
import { onUpdateStatus } from './updater'
import { releaseVoice } from './voice'
import { loadRenderer, webPreferences } from './windows'

/** Two panes — a nav and a page of settings — sized and behaving like a window someone
 *  works in rather than a form that happened to fit. The minimum is where the layout
 *  stops working rather than a round number: below about 720 the 236px nav starts
 *  eating the control column, and button-controlled rows wrap under their own label. */
const WIDTH = 980
const HEIGHT = 680
const MIN_WIDTH = 720
const MIN_HEIGHT = 520

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
    // The numbers above are the page, not the window — the title bar is the OS's, and
    // its height depends on the user's DPI and theme, not ours.
    useContentSize: true,
    title: 'Ezzy',
    icon,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    // nativeTheme is pinned to dark in index.ts, so the system frame comes out dark
    // and the page does not have to fake a title bar to match it.
    backgroundColor: '#14161c',
    autoHideMenuBar: true,
    webPreferences: webPreferences()
  })

  // Deliberately none of applyAlwaysPresent — closing this window closes it, since the
  // app lives in the tray regardless and there is nothing here to protect.
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    stopWatchingUpdates?.()
    stopWatchingUpdates = null
    win = null
  })

  // The window can be open while an update downloads behind it.
  stopWatchingUpdates = onUpdateStatus((status) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.updateStatus, status)
  })

  loadRenderer(win, 'settings')
}

/** The settings window paints itself from the same tokens as everything else, so it
 *  has to hear about a change to them — including the one made in it right now. */
export function sendAppearanceToSettings(appearance: Appearance): void {
  if (win && !win.isDestroyed()) win.webContents.send(IPC.appearance, appearance)
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

/** Apply a change from the settings window. Everything is written first and applied
 *  second, since the config file is the source of truth — `applyLoginItem` and
 *  `reapplyHotkey` read it back rather than take an argument, so a setting changed
 *  here and one hand-edited into config.json take the same path. */
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
    // A false register is the normal case, not the exceptional one — another launcher
    // may already own the key, and the fallback chain means Ezzy still has one.
    if (result.accelerator === null) {
      hotkeyError = 'Every shortcut Ezzy knows is taken. Try a different one.'
    } else if (result.usedFallback) {
      hotkeyError = `${patch.hotkey} is taken by another app, so Ezzy is using ${result.accelerator}.`
    }
  }

  return { snapshot: settingsSnapshot(), hotkeyError }
}
