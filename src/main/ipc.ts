import { ipcMain } from 'electron'
import { IPC } from '../shared/types'
import { getConfig } from './config'
import {
  beginDotDrag,
  currentPillSide,
  endDotDrag,
  hidePanel,
  moveDotDrag,
  setPillWidth
} from './windows'
import { activeHotkey } from './hotkey'

export function registerIpc(): void {
  ipcMain.on(IPC.dotDragStart, (_event, x: number, y: number) => beginDotDrag({ x, y }))
  ipcMain.on(IPC.dotDragMove, (_event, x: number, y: number) => moveDotDrag({ x, y }))
  ipcMain.on(IPC.dotDragEnd, () => endDotDrag())
  // The renderer measures the pill against its own text, so the main process's hover
  // rectangle matches what is actually drawn.
  ipcMain.on(IPC.setPillWidth, (_event, width: number) => setPillWidth(width))
  ipcMain.handle(IPC.getPillSide, () => currentPillSide())
  ipcMain.on(IPC.panelClose, () => hidePanel())
  // The panel shows the hotkey actually in force, which is not always the configured one.
  ipcMain.handle(IPC.getHotkey, () => activeHotkey() ?? getConfig().hotkey)
}
