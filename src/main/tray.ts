import { Menu, Tray, nativeImage, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { configFilePath, getConfig } from './config'
import { showDot, togglePanel } from './windows'

let tray: Tray | null = null

export function createTray(onQuit: () => void, hotkeyOk: boolean): void {
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setToolTip('Ezy')
  tray.on('click', () => togglePanel())

  const hotkey = getConfig().hotkey
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: hotkeyOk ? `Hotkey: ${hotkey}` : `Hotkey: ${hotkey} (unavailable)`,
        enabled: false
      },
      { type: 'separator' },
      { label: 'Show', click: () => showDot() },
      { label: 'Settings', click: () => void openSettings() },
      { type: 'separator' },
      { label: 'Quit', click: onQuit }
    ])
  )
}

/** Chunk A has no settings window (that is chunk F), so this opens the config file. */
async function openSettings(): Promise<void> {
  const path = configFilePath()
  const error = await shell.openPath(path)
  if (error) shell.showItemInFolder(path)
}
