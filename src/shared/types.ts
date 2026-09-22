/** Types and constants shared by the main, preload and renderer processes. */

export interface DotPosition {
  x: number
  y: number
}

export type Appearance = 'flat' | 'glass'

/** 'cards' is the default and the only one dot.css animates. */
export type DotLogo = 'cards' | 'orbit' | 'cluster' | 'panels' | 'custom'

export type BuiltInLogo = Exclude<DotLogo, 'custom'>
export const DOT_LOGOS: readonly BuiltInLogo[] = ['cards', 'orbit', 'cluster', 'panels']

export interface CustomLogo {
  id: string
  markup: string
}

export const MAX_CUSTOM_LOGOS = 2

export interface DotMark {
  logo: string
  markup: string | null
}

export const MAX_LOGO_BYTES = 96 * 1024

export type PickedLogo =
  { kind: 'cancelled' } | { kind: 'problem'; message: string } | { kind: 'svg'; markup: string }

export interface EzzyConfig {
  hotkey: string
  openAtLogin: boolean
  speech: boolean
  voice: boolean
  voicePanel: boolean
  duckMusic: boolean
  voiceName: string | null
  speechRate: number
  speechVolume: number
  speechVariety: boolean
  customApps: CustomApp[]
  aliases: Record<string, string[]>
  phrases: Record<string, string[]>
  appearance: Appearance
  dotLogo: string
  customLogos: CustomLogo[]
  dotPositions: Record<string, DotPosition>
  lastDisplayId: string | null
}

export const DEFAULT_CONFIG: EzzyConfig = {
  hotkey: 'Alt+Space',
  openAtLogin: true,
  speech: true,
  voice: true,
  voicePanel: false,
  appearance: 'flat',
  dotLogo: 'cards',
  customLogos: [],
  duckMusic: true,
  voiceName: null,
  speechRate: 1.08,
  speechVolume: 0.85,
  speechVariety: true,
  customApps: [],
  aliases: {},
  phrases: {},
  dotPositions: {},
  lastDisplayId: null
}

/** Created pill-sized and never resized — resizing a transparent window on Windows
 *  re-creates its surface and flashes. */
export const DOT_VISUAL = 56
export const PILL_VISUAL = 212
export const STATUS_VISUAL = 320
export const PILL_DELTA = STATUS_VISUAL - DOT_VISUAL
export const DOT_SLACK = 16
export const DOT_WINDOW = DOT_VISUAL + DOT_SLACK * 2
export const PILL_WINDOW = STATUS_VISUAL + DOT_SLACK * 2
export const DOT_GLYPH_SIZE = 32
export const PANEL_WIDTH = 420
export const SEARCH_HEIGHT = 54
export const SEARCH_PANEL_GAP = 11
export const PANEL_GAP = 12
export const PANEL_MIN_HEIGHT = 64
export const PANEL_MAX_HEIGHT = 420

/** Extra height requested beyond panel.css's own layout — keep in step with
 *  `--panel-headroom`. */
export const PANEL_HEADROOM = 2

export type PillDirection = 'left' | 'right'

export interface EzzyWindow {
  id: number
  title: string
  app: string
  icon?: string
}

export interface EzzyApp {
  id: string
  name: string
  icon?: string
}

export interface DirectTarget {
  kind: 'url' | 'path'
  label: string
  detail: string
}

export interface PanelData {
  windows: EzzyWindow[]
  apps: EzzyApp[]
  direct: DirectTarget | null
  query: string
}

export const EMPTY_PANEL_DATA: PanelData = { windows: [], apps: [], direct: null, query: '' }

export type NavKey = 'up' | 'down' | 'enter'
export const MAX_APP_ROWS = 12

export type VoiceState =
  | { kind: 'idle' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'arming' }
  | { kind: 'listening' }
  | { kind: 'thinking' }
  | { kind: 'done'; message: string; heard: string }
  | { kind: 'error'; message: string; micBlocked: boolean; heard?: string }

export type VoiceCapture = 'arm' | 'listen' | 'stop' | 'cancel'

export type VoiceFailure = 'denied' | 'no-device' | 'failed'

export interface SettingsSnapshot {
  config: EzzyConfig
  activeHotkey: string | null
  version: string
  packaged: boolean
  logPath: string
}

export interface SettingsResult {
  snapshot: SettingsSnapshot
  hotkeyError: string | null
}

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }

export interface CommandInfo {
  id: string
  title: string
  summary: string
  examples: string[]
  group: 'media' | 'windows' | 'system'
}

export interface SpeechRequest {
  text: string
  voice: string | null
  rate: number
  volume: number
}

export interface CustomApp {
  id: string
  name: string
  path: string
}

export interface AppInfo {
  id: string
  name: string
  aliases: string[]
  custom: boolean
}

export const IPC = {
  dotDragStart: 'dot:drag-start',
  dotDragMove: 'dot:drag-move',
  dotDragEnd: 'dot:drag-end',
  setPillWidth: 'dot:set-pill-width',
  dotHover: 'dot:hover',
  getPillSide: 'dot:get-pill-side',
  pillSide: 'dot:pill-side',
  panelClose: 'panel:close',
  getHotkey: 'app:get-hotkey',
  getAppearance: 'app:get-appearance',
  getDotLogo: 'app:get-dot-logo',
  pickLogo: 'app:pick-logo',
  getCommands: 'app:get-commands',
  checkPhrase: 'app:check-phrase',
  getApps: 'app:get-apps',
  pickApp: 'app:pick',
  appearance: 'app:appearance',
  dotLogo: 'app:dot-logo',
  panelData: 'panel:data',
  panelChanged: 'panel:changed',
  focusWindow: 'windows:focus',
  panelShown: 'panel:shown',
  launchApp: 'apps:launch',
  setPanelHeight: 'panel:set-height',
  searchQuery: 'search:query',
  searchNav: 'search:nav',
  searchReset: 'search:reset',
  panelNav: 'panel:nav',
  openDirect: 'panel:open-direct',
  voiceState: 'voice:state',
  getVoiceState: 'voice:get-state',
  voiceCapture: 'voice:capture',
  voiceReady: 'voice:ready',
  voiceAudio: 'voice:audio',
  voiceFailed: 'voice:failed',
  openMicSettings: 'voice:mic-settings',
  toggleVoice: 'voice:toggle',
  openTouchpadSettings: 'settings:touchpad',
  speak: 'speech:speak',
  openSettings: 'settings:open',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  closeSettings: 'settings:close',
  openLogFile: 'log:open',
  reportError: 'log:renderer-error',
  updateStatus: 'update:status',
  getUpdateStatus: 'update:get-status',
  checkForUpdates: 'update:check',
  installUpdate: 'update:install'
} as const

/** Named functions only — drag coordinates come from the renderer's pointer events, not
 *  read in the main process. */
export interface EzzyApi {
  startDotDrag(screenX: number, screenY: number): void
  moveDotDrag(screenX: number, screenY: number): void
  endDotDrag(): void
  setPillWidth(width: number): void
  onDotHover(callback: (hovered: boolean) => void): () => void
  getPillSide(): Promise<PillDirection>
  onPillSide(callback: (side: PillDirection) => void): () => void
  closePanel(): void
  getHotkey(): Promise<string>
  getCommands(): Promise<CommandInfo[]>
  getApps(): Promise<AppInfo[]>
  pickApp(): Promise<CustomApp | null>
  checkPhrase(phrase: string): Promise<string | null>
  getAppearance(): Promise<Appearance>
  onAppearance(callback: (appearance: Appearance) => void): () => void
  getDotLogo(): Promise<DotMark>
  pickLogo(): Promise<PickedLogo>
  onDotLogo(callback: (mark: DotMark) => void): () => void
  getPanelData(): Promise<PanelData>
  onPanelChanged(callback: (data: PanelData) => void): () => void
  focusWindow(id: number): Promise<boolean>
  onPanelShown(callback: (data: PanelData) => void): () => void
  launchApp(id: string): Promise<boolean>
  setPanelHeight(height: number): void
  setQuery(query: string): void
  navigate(key: NavKey): void
  onNavigate(callback: (key: NavKey) => void): () => void
  onSearchReset(callback: () => void): () => void
  openDirect(): Promise<boolean>
  onVoiceState(callback: (state: VoiceState) => void): () => void
  getVoiceState(): Promise<VoiceState>
  onVoiceCapture(callback: (capture: VoiceCapture) => void): () => void
  reportMicLive(): void
  sendVoiceAudio(wav: ArrayBuffer, spoke: boolean): void
  reportVoiceFailure(kind: VoiceFailure): void
  openMicSettings(): void
  openTouchpadSettings(): void
  toggleVoice(): void
  onSpeak(callback: (request: SpeechRequest) => void): () => void
  openSettings(): void
  getSettings(): Promise<SettingsSnapshot>
  setSettings(patch: Partial<EzzyConfig>): Promise<SettingsResult>
  closeSettings(): void
  openLogFile(): void
  reportError(page: string, message: string): void
  getUpdateStatus(): Promise<UpdateStatus>
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void
  checkForUpdates(): void
  installUpdate(): void
}
