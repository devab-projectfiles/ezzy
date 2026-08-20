import { ipcMain } from 'electron'
import { IPC } from '../shared/types'
import { getConfig } from './config'
import { beginDotDrag, endDotDrag, hidePanel, moveDotDrag, togglePanel } from './windows'
import { activeHotkey } from './hotkey'

export function registerIpc(): void {
  ipcMain.on(IPC.dotDragStart, (_event, x: number, y: number) => beginDotDrag({ x, y }))
  ipcMain.on(IPC.dotDragMove, (_event, x: number, y: number) => moveDotDrag({ x, y }))
  ipcMain.on(IPC.dotDragEnd, () => endDotDrag())
  ipcMain.on(IPC.dotClick, () => togglePanel())
  ipcMain.on(IPC.panelClose, () => hidePanel())
  // The panel shows the hotkey actually in force, which is not always the configured one.
  ipcMain.handle(IPC.getHotkey, () => activeHotkey() ?? getConfig().hotkey)
}
