import { Menu, Tray, nativeImage, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { configFilePath, getConfig, updateConfig } from './config'
import { HotkeyResult, activeHotkey } from './hotkey'
import { resetDotPosition, showDot, togglePanel } from './windows'

let tray: Tray | null = null
let quit: () => void = () => {}

export function createTray(onQuit: () => void, hotkey: HotkeyResult): void {
  quit = onQuit
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setToolTip('Ezzy')
  tray.on('click', () => togglePanel())
  refreshTray()
  announce(hotkey)
}

export function refreshTray(): void {
  if (!tray) return
  const hotkey = activeHotkey()
  tray.setToolTip(hotkey ? `Ezzy — ${hotkey}` : 'Ezzy — no hotkey available')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hotkey ? `Hotkey: ${hotkey}` : 'Hotkey: unavailable', enabled: false },
      { type: 'separator' },
      { label: 'Show', click: () => showDot() },
      { label: 'Reset dot position', click: () => resetDotPosition() },
      // §8 chunk E: spoken confirmations are on by default and toggleable. The settings
      // WINDOW is chunk F — this is the same stopgap as the Settings item below it, which
      // opens config.json, except that the one setting a user is likely to want off should
      // not require finding a JSON file to turn off.
      {
        label: 'Speak confirmations',
        type: 'checkbox',
        checked: getConfig().speech,
        click: (item) => updateConfig({ speech: item.checked })
      },
      { label: 'Settings', click: () => void openSettings() },
      { type: 'separator' },
      { label: 'Quit', click: () => quit() }
    ])
  )
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

/** Chunk A has no settings window (that is chunk F), so this opens the config file. */
async function openSettings(): Promise<void> {
  const path = configFilePath()
  const error = await shell.openPath(path)
  if (error) shell.showItemInFolder(path)
}
