import { Menu, Tray, nativeImage } from 'electron'
import icon from '../../resources/icon.png?asset'
import { UpdateStatus } from '../shared/types'
import { getConfig } from './config'
import { HotkeyResult, activeHotkey } from './hotkey'
import { openLogFile } from './logger'
import { openSettingsWindow } from './settings-window'
import { checkForUpdates, installUpdate, onUpdateStatus, updateStatus } from './updater'
import { resetDotPosition, showDot, togglePanel } from './windows'

let tray: Tray | null = null
let quit: () => void = () => {}
/** The version of a downloaded update that has already been announced, so the balloon fires
 *  once per update rather than on every status change that follows it. */
let announcedUpdate: string | null = null

export function createTray(onQuit: () => void, hotkey: HotkeyResult): void {
  quit = onQuit
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setToolTip('Ezzy')
  tray.on('click', () => togglePanel())
  refreshTray()
  announce(hotkey)
  onUpdateStatus((status) => {
    refreshTray()
    announceUpdate(status)
  })
}

export function refreshTray(): void {
  if (!tray) return
  const hotkey = activeHotkey()
  tray.setToolTip(hotkey ? `Ezzy — ${hotkey}` : 'Ezzy — no hotkey available')
  const update = updateStatus()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hotkey ? `Hotkey: ${hotkey}` : 'Hotkey: unavailable', enabled: false },
      { type: 'separator' },
      { label: 'Show', click: () => showDot() },
      { label: 'Reset dot position', click: () => resetDotPosition() },
      // Chunk E's two checkbox stopgaps lived here because there was no settings window yet.
      // There is one now, and it holds every setting rather than the two that
      // happened to be worth a menu item.
      { label: 'Settings…', click: () => openSettingsWindow() },
      { type: 'separator' },
      // Ezzy is a tray app with no console, so a user with a bug has nothing to attach unless
      // the log file is reachable from the one menu they can always find.
      { label: 'Open log file', click: () => void openLogFile() },
      update.kind === 'ready'
        ? { label: `Restart to update to ${update.version}`, click: () => installUpdate() }
        : {
            label: updateLabel(update),
            enabled: update.kind !== 'checking' && update.kind !== 'downloading',
            click: () => checkForUpdates()
          },
      { type: 'separator' },
      { label: 'Quit', click: () => quit() }
    ])
  )
}

function updateLabel(status: UpdateStatus): string {
  switch (status.kind) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Downloading ${status.version}…`
    case 'downloading':
      return `Downloading ${status.version} — ${status.percent}%`
    case 'unsupported':
      return 'Check for updates'
    default:
      return 'Check for updates'
  }
}

/** Without this a taken hotkey is invisible: the app looks simply broken. */
function announce(hotkey: HotkeyResult): void {
  if (!tray) return
  if (hotkey.accelerator === null) {
    tray.displayBalloon({
      title: 'Ezzy has no hotkey',
      content: 'Every candidate shortcut is taken. Set one in Settings, then restart Ezzy.'
    })
    return
  }
  if (!hotkey.usedFallback) return
  tray.displayBalloon({
    title: `Ezzy is on ${hotkey.accelerator}`,
    content: `${getConfig().hotkey} is unavailable, so Ezzy took ${hotkey.accelerator}.`
  })
}

/** A downloaded update installs itself on the next quit, which for a tray app can be weeks
 *  away — so it is worth one balloon, once. A failed check is not: see updater.ts. */
function announceUpdate(status: UpdateStatus): void {
  if (!tray || status.kind !== 'ready' || announcedUpdate === status.version) return
  announcedUpdate = status.version
  tray.displayBalloon({
    title: `Ezzy ${status.version} is ready`,
    content: 'It installs the next time you quit Ezzy, or restart now from the tray menu.'
  })
}
