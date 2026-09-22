/** Types and constants shared by the main, preload and renderer processes. */

export interface DotPosition {
  x: number
  y: number
}

/** 'flat' is one colour per surface; 'glass' is the tinted, lit version. Both stay as options. */
export type Appearance = 'flat' | 'glass'

/** Which mark the dot wears. 'cards' is the default and the only one dot.css animates, since
 *  it is drawn in three pieces the CSS can target by id; the others are single paths. */
export type DotLogo = 'cards' | 'orbit' | 'cluster' | 'panels' | 'custom'

/** All non-custom values, in picker order. */
export type BuiltInLogo = Exclude<DotLogo, 'custom'>
export const DOT_LOGOS: readonly BuiltInLogo[] = ['cards', 'orbit', 'cluster', 'panels']

/** A mark the user added. `dotLogo` points at it by id, so reordering the list never breaks
 *  which one is worn. */
export interface CustomLogo {
  id: string
  markup: string
}

/** Cap on user-added marks — one more than this starts wrapping the picker row. */
export const MAX_CUSTOM_LOGOS = 2

/** What the dot needs to draw: the chosen id, and its markup if that id is a custom one. */
export interface DotMark {
  logo: string
  markup: string | null
}

/** Largest SVG accepted as a custom mark. */
export const MAX_LOGO_BYTES = 96 * 1024

/** Result of the file picker: cancelled, a problem to show, or the SVG text. */
export type PickedLogo =
  { kind: 'cancelled' } | { kind: 'problem'; message: string } | { kind: 'svg'; markup: string }

export interface EzzyConfig {
  /** Electron accelerator string, e.g. 'Alt+Space'. */
  hotkey: string
  openAtLogin: boolean
  /** Spoken confirmations. Only the voice path speaks. */
  speech: boolean
  /** Whether holding the hotkey listens at all; off stops the mic and whisper-server. */
  voice: boolean
  /** Whether holding the hotkey opens the panel too, or stays on the dot alone. */
  voicePanel: boolean
  /** Pause music while listening — otherwise the mic can hear it and mistranscribe. */
  duckMusic: boolean
  /** Preferred voice by name, or null to auto-pick the best English one installed. */
  voiceName: string | null
  /** Playback rate and volume for confirmations. */
  speechRate: number
  speechVolume: number
  /** Vary the "Okay, "/"Sure, " prefix, or always use the plain sentence. */
  speechVariety: boolean
  /** Apps the scanner cannot find on its own, added by hand. */
  customApps: CustomApp[]
  /** Extra names per app id, matched the same way the real name is. */
  aliases: Record<string, string[]>
  /** Extra wordings per command id, rewritten to the canonical example before matching. */
  phrases: Record<string, string[]>
  /** Surface treatment; looks only. */
  appearance: Appearance
  /** A built-in name, or the id of a mark in `customLogos`. */
  dotLogo: string
  /** User-added marks, as sanitised SVG — see logo.ts. */
  customLogos: CustomLogo[]
  /** Dot position keyed by display id, so each monitor remembers its own spot. */
  dotPositions: Record<string, DotPosition>
  /** Display the dot was last on, used to pick a position at startup. */
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

/** 56px glass circle; hover pill opens to 212px max. Created pill-sized and never resized —
 *  resizing a transparent window on Windows re-creates its surface and flashes. */
export const DOT_VISUAL = 56
export const PILL_VISUAL = 212
/** Ceiling for the pill's open width — sized to the longest thing it ever says
 *  ("Microphone access is blocked for Ezzy"). */
export const STATUS_VISUAL = 320
export const PILL_DELTA = STATUS_VISUAL - DOT_VISUAL
export const DOT_SLACK = 16
export const DOT_WINDOW = DOT_VISUAL + DOT_SLACK * 2
export const PILL_WINDOW = STATUS_VISUAL + DOT_SLACK * 2
export const DOT_GLYPH_SIZE = 32
/** Search bar and panel are two windows, 11px apart, both transparent rather than acrylic —
 *  acrylic tints with the Windows theme and reads as a dark slab on a dark one. */
export const PANEL_WIDTH = 420
export const SEARCH_HEIGHT = 54
export const SEARCH_PANEL_GAP = 11
export const PANEL_GAP = 12

/** Panel sections (open windows, apps) are fixed height and scroll independently rather than
 *  the panel resizing per row — keeps APPS from sliding up when a window closes. */
export const PANEL_MIN_HEIGHT = 64
/** Ceiling, not the design height (~357px) — rounded up so a layout tweak does not silently
 *  clip. */
export const PANEL_MAX_HEIGHT = 420

/** Extra height requested beyond panel.css's own layout — Chromium snaps a box up to whole
 *  device pixels, which clipped the bottom rim. Keep in step with `--panel-headroom`. */
export const PANEL_HEADROOM = 2

/** Which edge the pill is pinned to; mirrors when the dot is parked against the left of a
 *  display. */
export type PillDirection = 'left' | 'right'

/** One switchable window. `id` is the HWND (32 significant bits, safe over IPC as a number). */
export interface EzzyWindow {
  id: number
  title: string
  /** Owning app, shown as the row subtitle; empty when unreadable. */
  app: string
  /** PNG data URL; absent until read from disk, or for good if the shell had none — the row
   *  falls back to an outline glyph either way. */
  icon?: string
}

/** An installed application that is not currently running, from the Start Menu index. */
export interface EzzyApp {
  /** Opaque id sent back for a launch request; main resolves it against the index. */
  id: string
  name: string
  icon?: string
}

/** A URL or existing path the query names directly, shown as its own row above the two
 *  sections. */
export interface DirectTarget {
  kind: 'url' | 'path'
  label: string
  /** "Open link" / the resolved path. */
  detail: string
}

/** Windows and apps travel together so the two sections can never disagree about what
 *  counts as "not running". */
export interface PanelData {
  windows: EzzyWindow[]
  apps: EzzyApp[]
  /** Non-null when the query is itself a URL or an existing path. */
  direct: DirectTarget | null
  /** The query these results answer; empty when just listing. */
  query: string
}

export const EMPTY_PANEL_DATA: PanelData = { windows: [], apps: [], direct: null, query: '' }

/** Keys forwarded from the search input to the (unfocusable) panel window. */
export type NavKey = 'up' | 'down' | 'enter'

/** Cap on app rows sent to the panel — each carries an icon over IPC on every keystroke. */
export const MAX_APP_ROWS = 12

/** What the voice path is doing, for the search bar to draw. One value, not flags — the
 *  states are mutually exclusive. */
export type VoiceState =
  | { kind: 'idle' }
  | { kind: 'downloading'; percent: number }
  /** Hold recognised but the mic is not capturing yet — opening the device costs
   *  225-960ms, and nothing said during it is recorded. */
  | { kind: 'arming' }
  | { kind: 'listening' }
  | { kind: 'thinking' }
  | { kind: 'done'; message: string; heard: string }
  /** `heard` is absent when the failure came before there was a transcript. */
  | { kind: 'error'; message: string; micBlocked: boolean; heard?: string }

/** What the dot's renderer should do with its microphone. Three states because arming
 *  happens before listening — the mic takes 300-950ms to open, so it opens on key-down
 *  before Ezzy knows whether this is a tap or a hold. */
export type VoiceCapture =
  | 'arm'
  /** Record until the speaker stops, then send — the hands-free path for the mic button. */
  | 'listen'
  | 'stop'
  | 'cancel'

/** Mapped from the DOMException getUserMedia rejects with, since the exception itself
 *  cannot cross the bridge. */
export type VoiceFailure = 'denied' | 'no-device' | 'failed'

/** Everything Settings draws, fetched once on open rather than four round trips. */
export interface SettingsSnapshot {
  config: EzzyConfig
  /** The accelerator actually in force — not always `config.hotkey`, since another app may
   *  have owned it first. Null when every candidate was taken. */
  activeHotkey: string | null
  version: string
  /** False in dev — openAtLogin and the updater no-op outside a packaged build. */
  packaged: boolean
  logPath: string
}

/** Result of a settings change. Hotkey is the one field the OS can refuse, so it rides back
 *  with the snapshot. */
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

/** One command as the settings window lists it — the regex that matches it never leaves
 *  the main process. */
export interface CommandInfo {
  id: string
  title: string
  summary: string
  examples: string[]
  group: 'media' | 'windows' | 'system'
}

/** One thing to say. Travels with the sentence rather than the dot holding its own copy
 *  of voice/rate/volume. Empty text means stop talking. */
export interface SpeechRequest {
  text: string
  voice: string | null
  rate: number
  volume: number
}

/** An app the user pointed Ezzy at directly; launched the same way an indexed shortcut is. */
export interface CustomApp {
  /** Stable across renames. */
  id: string
  name: string
  path: string
}

export interface AppInfo {
  id: string
  name: string
  aliases: string[]
  /** True if the user added this by hand — only those can be removed. */
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

/** The surface the preload exposes on `window.ezzy`. Named functions only — drag
 *  coordinates come from the renderer's pointer events, not read in the main process. */
export interface EzzyApi {
  startDotDrag(screenX: number, screenY: number): void
  moveDotDrag(screenX: number, screenY: number): void
  endDotDrag(): void
  /** Reports the pill's measured open width, for hit-testing. */
  setPillWidth(width: number): void
  /** A click-through window gets no mouse events of its own, so hover is detected in main. */
  onDotHover(callback: (hovered: boolean) => void): () => void
  getPillSide(): Promise<PillDirection>
  onPillSide(callback: (side: PillDirection) => void): () => void
  closePanel(): void
  getHotkey(): Promise<string>
  getCommands(): Promise<CommandInfo[]>
  getApps(): Promise<AppInfo[]>
  /** Opens a file picker; the path never comes from the renderer. */
  pickApp(): Promise<CustomApp | null>
  /** Why this phrase cannot be added, or null when it can. */
  checkPhrase(phrase: string): Promise<string | null>
  /** Every window asks on load — none share a stylesheet at runtime. */
  getAppearance(): Promise<Appearance>
  onAppearance(callback: (appearance: Appearance) => void): () => void
  getDotLogo(): Promise<DotMark>
  /** Opens an SVG file dialog. Reading only — nothing runs before `cleanLogo`. */
  pickLogo(): Promise<PickedLogo>
  onDotLogo(callback: (mark: DotMark) => void): () => void
  /** No OS enumeration here — stays inside the panel's 50ms budget. */
  getPanelData(): Promise<PanelData>
  onPanelChanged(callback: (data: PanelData) => void): () => void
  /** Resolves false when Windows refused, so the panel can stay open. */
  focusWindow(id: number): Promise<boolean>
  /** Fires on every panel open with the list already attached, saving a round trip. */
  onPanelShown(callback: (data: PanelData) => void): () => void
  launchApp(id: string): Promise<boolean>
  setPanelHeight(height: number): void
  setQuery(query: string): void
  navigate(key: NavKey): void
  onNavigate(callback: (key: NavKey) => void): () => void
  onSearchReset(callback: () => void): () => void
  /** Takes no target — the renderer cannot widen this into "open any path you like". */
  openDirect(): Promise<boolean>
  onVoiceState(callback: (state: VoiceState) => void): () => void
  /** The search bar is hidden for most of a download, so it asks fresh on the way back up. */
  getVoiceState(): Promise<VoiceState>
  /** Recording lives in the dot's renderer — it is the one window always alive. */
  onVoiceCapture(callback: (capture: VoiceCapture) => void): () => void
  /** Sent once, on the first real block captured. Everything before it is `arming`. */
  reportMicLive(): void
  /** 16kHz mono WAV, POSTed to whisper-server (localhost only). `spoke` is measured before
   *  any gain, so it is one honest answer per hold. */
  sendVoiceAudio(wav: ArrayBuffer, spoke: boolean): void
  reportVoiceFailure(kind: VoiceFailure): void
  openMicSettings(): void
  /** Windows' touchpad page — Ezzy reads no gestures itself. */
  openTouchpadSettings(): void
  toggleVoice(): void
  /** speechSynthesis is a web API, so the sentence is decided in main and spoken here.
   *  Empty string stops talking. */
  onSpeak(callback: (request: SpeechRequest) => void): () => void

  /** Opens Settings from the panel's APPS header and dismisses the panel. */
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
