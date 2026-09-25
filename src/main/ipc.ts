import { dialog, ipcMain } from 'electron'
import {
  DotMark,
  EzzyConfig,
  IPC,
  MAX_LOGO_BYTES,
  NavKey,
  PickedLogo,
  VoiceFailure
} from '../shared/types'
import { randomUUID } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import { appCatalogue, setAliases, setCustomApps } from './app-index'
import { commandCatalogue, phraseProblem, setCustomPhrases } from './commands/registry'
import { getConfig } from './config'
import {
  sendAppearance,
  sendDotLogo,
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
import {
  receiveAudio,
  reportCaptureFailure,
  reportMicLive,
  toggleListening,
  voiceState
} from './voice'
import { logRendererError } from './logger'
import {
  sendAppearanceToSettings,
  applySettings,
  closeSettingsWindow,
  openSettingsWindow,
  settingsSnapshot
} from './settings-window'
import { checkForUpdates, installUpdate, updateStatus } from './updater'
import { refreshTray } from './tray'

function dotMark(): DotMark {
  const config = getConfig()
  const own = config.customLogos.find((logo) => logo.id === config.dotLogo)
  return { logo: config.dotLogo, markup: own?.markup ?? null }
}

export function registerIpc(): void {
  ipcMain.on(IPC.dotDragStart, (_event, x: number, y: number) => beginDotDrag({ x, y }))
  ipcMain.on(IPC.dotDragMove, (_event, x: number, y: number) => moveDotDrag({ x, y }))
  ipcMain.on(IPC.dotDragEnd, () => endDotDrag())
  ipcMain.on(IPC.setPillWidth, (_event, width: number) => setPillWidth(width))
  ipcMain.handle(IPC.getPillSide, () => currentPillSide())
  ipcMain.on(IPC.panelClose, () => hidePanel())
  ipcMain.on(IPC.setPanelHeight, (_event, height: number) => setPanelHeight(height))
  ipcMain.handle(IPC.getHotkey, () => activeHotkey() ?? getConfig().hotkey)

  ipcMain.handle(IPC.panelData, () => panelData())
  ipcMain.handle(IPC.focusWindow, (_event, id: number) => {
    // Focus first, dismiss second: the search bar is the foreground window here, which is
    // what makes SetForegroundWindow legal for us.
    const focused = focusWindow(id)
    if (focused) hidePanel()
    else if (dropIfGone(id)) publishPanelData(panelData())
    return focused
  })
  ipcMain.handle(IPC.launchApp, async (_event, id: string) => {
    // Unlike focusing, dismiss first: a launch takes as long as the app takes to start.
    hidePanel()
    return launchApp(id)
  })
  ipcMain.handle(IPC.openDirect, async () => {
    hidePanel()
    return openDirect()
  })

  ipcMain.on(IPC.searchQuery, (_event, query: string) => {
    sendToPanel(IPC.panelChanged, setQuery(query))
  })
  ipcMain.on(IPC.searchNav, (_event, key: NavKey) => sendToPanel(IPC.panelNav, key))

  ipcMain.handle(IPC.getVoiceState, () => voiceState())
  ipcMain.on(IPC.voiceReady, () => reportMicLive())
  ipcMain.on(IPC.voiceAudio, (_event, wav: ArrayBuffer, spoke: boolean) =>
    receiveAudio(Buffer.from(wav), spoke)
  )
  ipcMain.on(IPC.voiceFailed, (_event, kind: VoiceFailure) => reportCaptureFailure(kind))
  ipcMain.on(IPC.openMicSettings, () => void openMicrophoneSettings())
  ipcMain.on(IPC.toggleVoice, () => toggleListening())

  ipcMain.on(IPC.openTouchpadSettings, () => {
    void openShellTarget('ms-settings:devices-touchpad', 'touchpad settings')
  })

  ipcMain.on(IPC.openSettings, () => {
    // Dismiss first: the settings window takes the foreground, and leaving a panel hovering
    // over it would be a launcher sitting on top of its own settings.
    hidePanel()
    openSettingsWindow()
  })
  ipcMain.handle(IPC.getSettings, () => settingsSnapshot())
  ipcMain.handle(IPC.getAppearance, () => getConfig().appearance)
  ipcMain.handle(IPC.getDotLogo, () => dotMark())
  ipcMain.handle(IPC.getCommands, () => commandCatalogue())
  ipcMain.handle(IPC.getApps, () => appCatalogue())
  ipcMain.handle(IPC.pickApp, async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Add an application',
      properties: ['openFile'],
      filters: [
        { name: 'Applications and shortcuts', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] },
        { name: 'Anything', extensions: ['*'] }
      ]
    })
    const path = picked.filePaths[0]
    if (picked.canceled || path === undefined) return null
    return { id: randomUUID(), name: basename(path, extname(path)), path }
  })
  ipcMain.handle(IPC.pickLogo, async (): Promise<PickedLogo> => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a mark for the dot',
      properties: ['openFile'],
      filters: [{ name: 'SVG images', extensions: ['svg'] }]
    })
    const file = picked.filePaths[0]
    if (picked.canceled || file === undefined) return { kind: 'cancelled' }
    try {
      const { size } = statSync(file)
      if (size > MAX_LOGO_BYTES) {
        return {
          kind: 'problem',
          message: `That file is ${Math.round(size / 1024)}KB. A mark drawn at 32px should be well under ${Math.round(MAX_LOGO_BYTES / 1024)}KB — this one is probably a photo saved as an SVG.`
        }
      }
      return { kind: 'svg', markup: readFileSync(file, 'utf8') }
    } catch {
      return { kind: 'problem', message: 'That file could not be read.' }
    }
  })
  ipcMain.handle(IPC.checkPhrase, (_event, phrase: string) => phraseProblem(phrase))
  ipcMain.handle(IPC.setSettings, (_event, patch: Partial<EzzyConfig>) => {
    const result = applySettings(patch)
    if (patch.phrases !== undefined) setCustomPhrases(result.snapshot.config.phrases)
    if (patch.aliases !== undefined) setAliases(result.snapshot.config.aliases)
    if (patch.customApps !== undefined) setCustomApps()
    if (patch.appearance !== undefined) {
      sendAppearance(result.snapshot.config.appearance)
      sendAppearanceToSettings(result.snapshot.config.appearance)
    }
    if (patch.dotLogo !== undefined || patch.customLogos !== undefined) {
      sendDotLogo(dotMark())
    }
    refreshTray()
    return result
  })
  ipcMain.on(IPC.closeSettings, () => closeSettingsWindow())
  ipcMain.on(IPC.reportError, (_event, page: string, message: string) => {
    logRendererError(page, message)
  })
  ipcMain.handle(IPC.getUpdateStatus, () => updateStatus())
  ipcMain.on(IPC.checkForUpdates, () => checkForUpdates())
  ipcMain.on(IPC.installUpdate, () => installUpdate())
}
