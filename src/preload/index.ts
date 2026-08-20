import { contextBridge, ipcRenderer } from 'electron'
import { EzzyApi, IPC } from '../shared/types'

// Only named functions cross the bridge — `ipcRenderer` itself is never exposed.
const ezzy: EzzyApi = {
  startDotDrag: (x, y) => ipcRenderer.send(IPC.dotDragStart, x, y),
  moveDotDrag: (x, y) => ipcRenderer.send(IPC.dotDragMove, x, y),
  endDotDrag: () => ipcRenderer.send(IPC.dotDragEnd),
  clickDot: () => ipcRenderer.send(IPC.dotClick),
  closePanel: () => ipcRenderer.send(IPC.panelClose),
  getHotkey: () => ipcRenderer.invoke(IPC.getHotkey)
}

contextBridge.exposeInMainWorld('ezzy', ezzy)
