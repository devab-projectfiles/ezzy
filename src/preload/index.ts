import { contextBridge, ipcRenderer } from 'electron'
import {
  SpeechRequest,
  Appearance,
  DotMark,
  EzzyApi,
  IPC,
  NavKey,
  PanelData,
  PillDirection,
  UpdateStatus,
  VoiceCapture,
  VoiceState
} from '../shared/types'

// Only named functions cross the bridge — `ipcRenderer` itself is never exposed.
const ezzy: EzzyApi = {
  startDotDrag: (x, y) => ipcRenderer.send(IPC.dotDragStart, x, y),
  moveDotDrag: (x, y) => ipcRenderer.send(IPC.dotDragMove, x, y),
  endDotDrag: () => ipcRenderer.send(IPC.dotDragEnd),
  clickDot: () => ipcRenderer.send(IPC.dotClick),
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
  getAppearance: () => ipcRenderer.invoke(IPC.getAppearance),
  getDotLogo: () => ipcRenderer.invoke(IPC.getDotLogo),
  pickLogo: () => ipcRenderer.invoke(IPC.pickLogo),
  getCommands: () => ipcRenderer.invoke(IPC.getCommands),
  getApps: () => ipcRenderer.invoke(IPC.getApps),
  pickApp: () => ipcRenderer.invoke(IPC.pickApp),
  checkPhrase: (phrase) => ipcRenderer.invoke(IPC.checkPhrase, phrase),
  onAppearance: (callback) => {
    const handler = (_event: unknown, appearance: Appearance): void => callback(appearance)
    ipcRenderer.on(IPC.appearance, handler)
    return () => void ipcRenderer.removeListener(IPC.appearance, handler)
  },
  onDotLogo: (callback) => {
    const handler = (_event: unknown, mark: DotMark): void => callback(mark)
    ipcRenderer.on(IPC.dotLogo, handler)
    return () => void ipcRenderer.removeListener(IPC.dotLogo, handler)
  },
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
  setQuery: (query) => ipcRenderer.send(IPC.searchQuery, query),
  navigate: (key) => ipcRenderer.send(IPC.searchNav, key),
  onNavigate: (callback) => {
    const handler = (_event: unknown, key: NavKey): void => callback(key)
    ipcRenderer.on(IPC.panelNav, handler)
    return () => void ipcRenderer.removeListener(IPC.panelNav, handler)
  },
  onSearchReset: (callback) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC.searchReset, handler)
    return () => void ipcRenderer.removeListener(IPC.searchReset, handler)
  },
  openDirect: () => ipcRenderer.invoke(IPC.openDirect),
  onVoiceState: (callback) => {
    const handler = (_event: unknown, state: VoiceState): void => callback(state)
    ipcRenderer.on(IPC.voiceState, handler)
    return () => void ipcRenderer.removeListener(IPC.voiceState, handler)
  },
  getVoiceState: () => ipcRenderer.invoke(IPC.getVoiceState),
  onVoiceCapture: (callback) => {
    const handler = (_event: unknown, capture: VoiceCapture, readyMs: number): void =>
      callback(capture, readyMs)
    ipcRenderer.on(IPC.voiceCapture, handler)
    return () => void ipcRenderer.removeListener(IPC.voiceCapture, handler)
  },
  reportMicLive: () => ipcRenderer.send(IPC.voiceReady),
  sendVoiceAudio: (wav, spoke) => ipcRenderer.send(IPC.voiceAudio, wav, spoke),
  reportVoiceFailure: (kind) => ipcRenderer.send(IPC.voiceFailed, kind),
  openMicSettings: () => ipcRenderer.send(IPC.openMicSettings),
  toggleVoice: () => ipcRenderer.send(IPC.toggleVoice),
  openTouchpadSettings: () => ipcRenderer.send(IPC.openTouchpadSettings),
  onSpeak: (callback) => {
    const handler = (_event: unknown, request: SpeechRequest): void => callback(request)
    ipcRenderer.on(IPC.speak, handler)
    return () => void ipcRenderer.removeListener(IPC.speak, handler)
  },
  openSettings: () => ipcRenderer.send(IPC.openSettings),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  closeSettings: () => ipcRenderer.send(IPC.closeSettings),
  reportError: (page, message) => ipcRenderer.send(IPC.reportError, page, message),
  getUpdateStatus: () => ipcRenderer.invoke(IPC.getUpdateStatus),
  onUpdateStatus: (callback) => {
    const handler = (_event: unknown, status: UpdateStatus): void => callback(status)
    ipcRenderer.on(IPC.updateStatus, handler)
    return () => void ipcRenderer.removeListener(IPC.updateStatus, handler)
  },
  checkForUpdates: () => ipcRenderer.send(IPC.checkForUpdates),
  installUpdate: () => ipcRenderer.send(IPC.installUpdate)
}

contextBridge.exposeInMainWorld('ezzy', ezzy)
