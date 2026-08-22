import { ipcMain } from 'electron'
import { IPC } from '../shared/types'
import { getConfig } from './config'
import {
  backdropThemeFor,
  beginDotDrag,
  currentPillSide,
  endDotDrag,
  hidePanel,
  moveDotDrag,
  setPanelHeight,
  setPillWidth
} from './windows'
import { activeHotkey } from './hotkey'
import { focusWindow } from './focus'
import { panelData } from './panel-data'
import { launchApp } from './app-index'

export function registerIpc(): void {
  ipcMain.on(IPC.dotDragStart, (_event, x: number, y: number) => beginDotDrag({ x, y }))
  ipcMain.on(IPC.dotDragMove, (_event, x: number, y: number) => moveDotDrag({ x, y }))
  ipcMain.on(IPC.dotDragEnd, () => endDotDrag())
  // The renderer measures the pill against its own text, so the main process's hover
  // rectangle matches what is actually drawn.
  ipcMain.on(IPC.setPillWidth, (_event, width: number) => setPillWidth(width))
  ipcMain.handle(IPC.getPillSide, () => currentPillSide())
  ipcMain.on(IPC.panelClose, () => hidePanel())
  // §6: the panel is sized to its list, and only the renderer knows how tall that came out.
  ipcMain.on(IPC.setPanelHeight, (_event, height: number) => setPanelHeight(height))
  // The panel shows the hotkey actually in force, which is not always the configured one.
  ipcMain.handle(IPC.getHotkey, () => activeHotkey() ?? getConfig().hotkey)

  // §6 adaptive contrast: the push only fires on a change, so a window that loaded over a
  // white desktop needs to be told once what it is already sitting on.
  ipcMain.handle(IPC.getBackdropTheme, (event) => backdropThemeFor(event.sender))

  ipcMain.handle(IPC.panelData, () => panelData())
  ipcMain.handle(IPC.focusWindow, (_event, id: number) => {
    // Focus first, dismiss second (§7). The panel is the foreground window at this point,
    // which is what makes SetForegroundWindow legal for us — hiding it first would hand the
    // foreground back to the OS and put focus.ts back on its fallback path for no reason.
    const focused = focusWindow(id)
    if (focused) hidePanel()
    return focused
  })
  ipcMain.handle(IPC.launchApp, async (_event, id: string) => {
    // Unlike focusing, dismiss first: a launch takes as long as the app takes to start, and
    // leaving the panel up over it would read as the click not having registered.
    hidePanel()
    return launchApp(id)
  })
}
