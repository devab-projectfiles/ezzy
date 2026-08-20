import { ipcMain } from 'electron'
import { IPC } from '../shared/types'
import { getConfig } from './config'
import { beginDotDrag, endDotDrag, hidePanel, moveDotDrag, togglePanel } from './windows'

export function registerIpc(): void {
  ipcMain.on(IPC.dotDragStart, beginDotDrag)
  ipcMain.on(IPC.dotDragMove, moveDotDrag)
  ipcMain.on(IPC.dotDragEnd, endDotDrag)
  ipcMain.on(IPC.dotClick, () => togglePanel())
  ipcMain.on(IPC.panelClose, () => hidePanel())
  ipcMain.handle(IPC.getHotkey, () => getConfig().hotkey)
}
