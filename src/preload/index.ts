import { contextBridge, ipcRenderer } from 'electron'
import { EzzyApi, IPC, PillDirection } from '../shared/types'

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
  getHotkey: () => ipcRenderer.invoke(IPC.getHotkey)
}

contextBridge.exposeInMainWorld('ezzy', ezzy)
