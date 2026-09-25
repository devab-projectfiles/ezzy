// The one window in Ezzy that is an ordinary window: the other three are frameless,
// transparent, unfocusable furniture that must never appear in the taskbar.

import { BrowserWindow, app } from 'electron'
import icon from '../../resources/icon.ico?asset'
import { Appearance, EzzyConfig, IPC, SettingsResult, SettingsSnapshot } from '../shared/types'
import { getConfig, updateConfig } from './config'
import { activeHotkey, reapplyHotkey } from './hotkey'
import { applyLoginItem } from './login-item'
import { onUpdateStatus } from './updater'
import { releaseVoice } from './voice'
import { loadRenderer, webPreferences } from './windows'

// The minimum is where the layout stops working, not a round number: below ~720 the 236px
// nav starts eating the control column.
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
    useContentSize: true,
    title: 'Ezzy',
    icon,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    backgroundColor: '#14161c',
    autoHideMenuBar: true,
    webPreferences: webPreferences()
  })

  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    stopWatchingUpdates?.()
    stopWatchingUpdates = null
    win = null
  })

  stopWatchingUpdates = onUpdateStatus((status) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.updateStatus, status)
  })

  loadRenderer(win, 'settings')
}

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
    packaged: app.isPackaged
  }
}

// Written first, applied second: applyLoginItem and reapplyHotkey read the config back
// rather than take an argument, so a hand-edited config.json takes the same path.
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
    if (result.accelerator === null) {
      hotkeyError = 'Every shortcut Ezzy knows is taken. Try a different one.'
    } else if (result.usedFallback) {
      hotkeyError = `${patch.hotkey} is taken by another app, so Ezzy is using ${result.accelerator}.`
    }
  }

  return { snapshot: settingsSnapshot(), hotkeyError }
}
