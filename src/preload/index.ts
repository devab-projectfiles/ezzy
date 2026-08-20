import { contextBridge, ipcRenderer } from 'electron'
import { EzyApi, IPC } from '../shared/types'

// Only named functions cross the bridge — `ipcRenderer` itself is never exposed.
const ezy: EzyApi = {
  startDotDrag: () => ipcRenderer.send(IPC.dotDragStart),
  moveDotDrag: () => ipcRenderer.send(IPC.dotDragMove),
  endDotDrag: () => ipcRenderer.send(IPC.dotDragEnd),
  clickDot: () => ipcRenderer.send(IPC.dotClick),
  closePanel: () => ipcRenderer.send(IPC.panelClose),
  getHotkey: () => ipcRenderer.invoke(IPC.getHotkey)
}

contextBridge.exposeInMainWorld('ezy', ezy)
