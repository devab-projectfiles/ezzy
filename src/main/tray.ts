import { execFileSync } from 'node:child_process'
import { Menu, Tray, nativeImage, nativeTheme } from 'electron'
import trayOnDark from '../../resources/tray-on-dark.png?asset'
import trayOnLight from '../../resources/tray-on-light.png?asset'
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

/** Which way Windows paints the taskbar. Not `nativeTheme.shouldUseDarkColors` —
 *  index.ts pins `themeSource` to 'dark', making that flag permanently true, and Windows
 *  tracks the taskbar's theme (`SystemUsesLightTheme`) separately from apps
 *  (`AppsUseLightTheme`) anyway. Electron exposes neither, so it comes from the registry. */
function taskbarIsLight(): boolean {
  try {
    const output = execFileSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
        '/v',
        'SystemUsesLightTheme'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 2000 }
    )
    return /SystemUsesLightTheme\s+REG_DWORD\s+0x1/i.test(output)
  } catch {
    // The value is missing on installs that have never been themed. Dark is the Windows 11
    // default taskbar, and a white mark on a dark bar is the safer of the two guesses —
    // the other way round is invisible rather than merely low-contrast.
    return false
  }
}

/** The mark is drawn at 32px and handed over at 32px. The tray asks for 16 at 100% but 20 at
 *  125% and 24 at 150%, so shrinking it to 16 here would force Windows to scale a small
 *  bitmap back up on exactly the displays this machine uses. */
function trayImage(): Electron.NativeImage {
  return nativeImage.createFromPath(taskbarIsLight() ? trayOnLight : trayOnDark)
}

export function createTray(onQuit: () => void, hotkey: HotkeyResult): void {
  quit = onQuit
  tray = new Tray(trayImage())
  tray.setToolTip('Ezzy')
  tray.on('click', () => togglePanel())
  // Switching Windows between light and dark leaves the icon behind otherwise, and a
  // dark-on-dark tray icon reads as the app having crashed.
  nativeTheme.on('updated', () => tray?.setImage(trayImage()))
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
      { label: 'Settings…', click: () => openSettingsWindow() },
      { type: 'separator' },
      // A tray app with no console needs the log file reachable from the one menu a
      // user with a bug can always find.
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
