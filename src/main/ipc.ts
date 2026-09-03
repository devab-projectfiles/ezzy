import { ipcMain } from 'electron'
import { EzzyConfig, IPC, NavKey, VoiceFailure } from '../shared/types'
import { getConfig } from './config'
import {
  beginDotDrag,
  currentPillSide,
  endDotDrag,
  hidePanel,
  moveDotDrag,
  publishPanelData,
  sendToPanel,
  setPanelHeight,
  setPillWidth
} from './windows'
import { activeHotkey } from './hotkey'
import { focusWindow } from './focus'
import { dropIfGone } from './window-tracker'
import { panelData, setQuery } from './panel-data'
import { launchApp, openDirect, openMicrophoneSettings, openShellTarget } from './launcher'
import { receiveAudio, reportCaptureFailure, toggleListening, voiceState } from './voice'
import { logRendererError, openLogFile } from './logger'
import {
  applySettings,
  closeSettingsWindow,
  openSettingsWindow,
  settingsSnapshot
} from './settings-window'
import { checkForUpdates, installUpdate, updateStatus } from './updater'
import { refreshTray } from './tray'

export function registerIpc(): void {
  ipcMain.on(IPC.dotDragStart, (_event, x: number, y: number) => beginDotDrag({ x, y }))
  ipcMain.on(IPC.dotDragMove, (_event, x: number, y: number) => moveDotDrag({ x, y }))
  ipcMain.on(IPC.dotDragEnd, () => endDotDrag())
  // The renderer measures the pill against its own text, so the main process's hover
  // rectangle matches what is actually drawn.
  ipcMain.on(IPC.setPillWidth, (_event, width: number) => setPillWidth(width))
  ipcMain.handle(IPC.getPillSide, () => currentPillSide())
  ipcMain.on(IPC.panelClose, () => hidePanel())
  // The panel is sized to its list, and only the renderer knows how tall that came out.
  ipcMain.on(IPC.setPanelHeight, (_event, height: number) => setPanelHeight(height))
  // The panel shows the hotkey actually in force, which is not always the configured one.
  ipcMain.handle(IPC.getHotkey, () => activeHotkey() ?? getConfig().hotkey)

  ipcMain.handle(IPC.panelData, () => panelData())
  ipcMain.handle(IPC.focusWindow, (_event, id: number) => {
    // Focus first, dismiss second. The search bar is the foreground window at this
    // point, which is what makes SetForegroundWindow legal for us — hiding it first would
    // hand the foreground back to the OS and put focus.ts back on its fallback path for no
    // reason.
    const focused = focusWindow(id)
    if (focused) hidePanel()
    // A row whose window died since the panel opened would otherwise stay on screen doing
    // nothing every time it is clicked. Dropping it re-publishes the list, and the app it
    // belonged to reappears under APPS where it can actually be launched.
    else if (dropIfGone(id)) publishPanelData(panelData())
    return focused
  })
  ipcMain.handle(IPC.launchApp, async (_event, id: string) => {
    // Unlike focusing, dismiss first: a launch takes as long as the app takes to start, and
    // leaving the panel up over it would read as the click not having registered.
    hidePanel()
    return launchApp(id)
  })
  ipcMain.handle(IPC.openDirect, async () => {
    hidePanel()
    // No target crosses the bridge — the main process opens the one it resolved from the
    // query it was already holding.
    return openDirect()
  })

  // Typing happens in the search-bar window and the results are drawn in the panel window,
  // so the query has to pass through here whatever else it does. Matching runs in the main
  // process for that reason; see search.ts.
  ipcMain.on(IPC.searchQuery, (_event, query: string) => {
    sendToPanel(IPC.panelChanged, setQuery(query))
  })
  // The panel is deliberately unfocusable, so it never sees a key event of its own.
  ipcMain.on(IPC.searchNav, (_event, key: NavKey) => sendToPanel(IPC.panelNav, key))

  // ------------------------------------------------------------------- voice
  // The search bar draws the voice state and the dot's renderer does the recording, so both
  // halves of push-to-talk cross here. Neither renderer decides anything: the dot is told when
  // to record and hands back bytes, and the search bar is told what to display.
  ipcMain.handle(IPC.getVoiceState, () => voiceState())
  ipcMain.on(IPC.voiceAudio, (_event, wav: ArrayBuffer) => receiveAudio(Buffer.from(wav)))
  ipcMain.on(IPC.voiceFailed, (_event, kind: VoiceFailure) => reportCaptureFailure(kind))
  // A microphone Windows has blocked must lead to the setting, not to a dead button.
  ipcMain.on(IPC.openMicSettings, () => void openMicrophoneSettings())
  // The mic glyph is a button now. Same machinery as the hotkey hold, different gesture —
  // see toggleListening for why a click cannot simply reuse press-and-release.
  ipcMain.on(IPC.toggleVoice, () => toggleListening())

  // ---------------------------------------------------------------- chunk F
  // Ezzy reads no gestures. Windows maps a three-finger tap to a shortcut, and this is
  // the page where that is done — which is the whole of Ezzy's gesture support.
  ipcMain.on(IPC.openTouchpadSettings, () => {
    void openShellTarget('ms-settings:devices-touchpad', 'touchpad settings')
  })

  ipcMain.on(IPC.openSettings, () => {
    // Dismiss first, like a launch: the settings window takes the foreground, and leaving a
    // panel hovering over it would be a launcher sitting on top of its own settings. The
    // search bar's blur would hide it a moment later anyway — doing it here makes the order
    // deterministic rather than a race between two windows.
    hidePanel()
    openSettingsWindow()
  })
  ipcMain.handle(IPC.getSettings, () => settingsSnapshot())
  ipcMain.handle(IPC.setSettings, (_event, patch: Partial<EzzyConfig>) => {
    const result = applySettings(patch)
    // The tray shows the hotkey in force in both its tooltip and its first menu item, and
    // that is exactly what a settings change can invalidate. Rebuilding the menu is cheap
    // enough that it is not worth working out whether this particular change needed it.
    refreshTray()
    return result
  })
  ipcMain.on(IPC.closeSettings, () => closeSettingsWindow())
  ipcMain.on(IPC.openLogFile, () => void openLogFile())
  ipcMain.on(IPC.reportError, (_event, page: string, message: string) => {
    logRendererError(page, message)
  })
  ipcMain.handle(IPC.getUpdateStatus, () => updateStatus())
  ipcMain.on(IPC.checkForUpdates, () => checkForUpdates())
  ipcMain.on(IPC.installUpdate, () => installUpdate())
}
