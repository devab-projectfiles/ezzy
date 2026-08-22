import { contextBridge, ipcRenderer } from 'electron'
import { BackdropTheme, EzzyApi, IPC, PanelData, PillDirection } from '../shared/types'

// Only named functions cross the bridge — `ipcRenderer` itself is never exposed.
const ezzy: EzzyApi = {
  startDotDrag: (x, y) => ipcRenderer.send(IPC.dotDragStart, x, y),
  moveDotDrag: (x, y) => ipcRenderer.send(IPC.dotDragMove, x, y),
  endDotDrag: () => ipcRenderer.send(IPC.dotDragEnd),
  setPillWidth: (width) => ipcRenderer.send(IPC.setPillWidth, width),
  getPillSide: () => ipcRenderer.invoke(IPC.getPillSide),
  onPillSide: (callback) => {
    // The event object stays on this side of the bridge; only the value crosses.
    const handler = (_event: unknown, side: PillDirection): void => callback(side)
    ipcRenderer.on(IPC.pillSide, handler)
    return () => void ipcRenderer.removeListener(IPC.pillSide, handler)
  },
  onDotHover: (callback) => {
    const handler = (_event: unknown, hovered: boolean): void => callback(hovered)
    ipcRenderer.on(IPC.dotHover, handler)
    return () => void ipcRenderer.removeListener(IPC.dotHover, handler)
  },
  closePanel: () => ipcRenderer.send(IPC.panelClose),
  getHotkey: () => ipcRenderer.invoke(IPC.getHotkey),
  getPanelData: () => ipcRenderer.invoke(IPC.panelData),
  onPanelChanged: (callback) => {
    const handler = (_event: unknown, data: PanelData): void => callback(data)
    ipcRenderer.on(IPC.panelChanged, handler)
    return () => void ipcRenderer.removeListener(IPC.panelChanged, handler)
  },
  focusWindow: (id) => ipcRenderer.invoke(IPC.focusWindow, id),
  onPanelShown: (callback) => {
    const handler = (_event: unknown, data: PanelData): void => callback(data)
    ipcRenderer.on(IPC.panelShown, handler)
    return () => void ipcRenderer.removeListener(IPC.panelShown, handler)
  },
  launchApp: (id) => ipcRenderer.invoke(IPC.launchApp, id),
  setPanelHeight: (height) => ipcRenderer.send(IPC.setPanelHeight, height),
  getBackdropTheme: () => ipcRenderer.invoke(IPC.getBackdropTheme),
  onBackdropTheme: (callback) => {
    const handler = (_event: unknown, theme: BackdropTheme): void => callback(theme)
    ipcRenderer.on(IPC.backdropTheme, handler)
    return () => void ipcRenderer.removeListener(IPC.backdropTheme, handler)
  }
}

contextBridge.exposeInMainWorld('ezzy', ezzy)
