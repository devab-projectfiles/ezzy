/** Types and constants shared by the main, preload and renderer processes. */

export interface DotPosition {
  x: number
  y: number
}

/** Which surface treatment the windows wear.
 *
 *  `flat` is one neutral colour per surface with no white over it. `glass` is what the app
 *  looked like before that: a blue-slate gradient under an inner glow, a diagonal sheen, a top
 *  specular and a bright rim. Both are kept because the second one is not worse, it is a
 *  different taste, and the person who liked it should not have to keep a patch. */
export type Appearance = 'flat' | 'glass'

export interface EzzyConfig {
  /** Electron accelerator string, e.g. 'Alt+Space'. */
  hotkey: string
  openAtLogin: boolean
  /** Spoken confirmations — on by default, and the one thing here a
   *  user is likely to want off. Only the voice path speaks: someone who clicked a row is
   *  looking at the screen and does not need telling what they just did. */
  speech: boolean
  /** Whether holding the hotkey listens at all.
   *
   *  On by default, because voice is the reason people try the app. Off, a hold is just a
   *  long tap: no microphone is opened, no model is downloaded and whisper-server is stopped
   *  if it was running — which is the point of the switch, since the server holds ~300MB for
   *  as long as the session lasts. The typed path is untouched either way. */
  voice: boolean
  /** Whether holding the hotkey opens the panel, or leaves voice on the dot.
   *
   *  Off by default: holding a key to say four words should not throw a 420px window list
   *  over what you were reading, and since chunk E the pill can carry the whole exchange —
   *  listening, thinking, and the answer. On, it is chunk D's behaviour: the panel comes up
   *  with the search bar reporting, so a command that misses leaves you in a field you can
   *  finish typing into.
   *
   *  A blocked microphone opens the panel either way. Is explicit that it has to lead to
   *  the setting rather than to a dead button, and that button lives on the search bar. */
  voicePanel: boolean
  /** The surface treatment. Purely how the windows are painted — no size, position or
   *  behaviour changes with it. */
  appearance: Appearance
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
  dotPositions: {},
  lastDisplayId: null
}

/** Window geometry.
 *
 *  The glass circle is 56px and the hover pill opens to at most 212px. The dot window is
 *  created at the PILL size and never resized: resizing a transparent window on Windows
 *  re-creates its composited surface and flashes, which is visible as a flicker at both
 *  ends of every hover. Only the CSS pill inside the window animates.
 *
 *  Because the window is permanently pill-sized it would otherwise swallow mouse input
 *  across a 244px rectangle, so it is click-through everywhere except over the pill —
 *  see setDotInteractive. DOT_SLACK is transparent margin the drop shadow can fall into. */
export const DOT_VISUAL = 56
export const PILL_VISUAL = 212
/** The pill's other ceiling. Ends the hover-pill section with "later the same pill carries
 *  state — a waveform while listening, 'didn't catch that' on a failed command. Keep it as one
 *  reusable component", and chunk E is that later: the pill is where a voice command reports
 *  itself once the panel has gone.
 *
 *  A whole sentence is wider than "Ezzy · Alt + Space", and the window cannot grow to fit one
 *  — see the note above. So the window is sized for the longest thing the pill will ever say
 *  ("Microphone access is blocked for Ezzy" is the current record) and the hover pill simply
 *  opens to less of it. The extra width costs nothing: it is transparent and click-through
 *  until something is drawn in it. */
export const STATUS_VISUAL = 320
export const PILL_DELTA = STATUS_VISUAL - DOT_VISUAL
export const DOT_SLACK = 16
export const DOT_WINDOW = DOT_VISUAL + DOT_SLACK * 2
export const PILL_WINDOW = STATUS_VISUAL + DOT_SLACK * 2
export const DOT_GLYPH_SIZE = 32
/** The search bar and the panel are two separate windows that show, hide and move as a
 *  unit, 11px apart — not one window with a divider.
 *
 *  Both are `transparent: true`. Originally specified `backgroundMaterial: 'acrylic'`,
 *  but acrylic tints the surface with the Windows theme and on a dark theme that reads as a
 *  dark slab rather than glass. Transparency was chosen over frosting deliberately: the
 *  trade is that the desktop behind is clear rather than blurred, since CSS backdrop-filter
 *  cannot blur anything outside its own window. The radii below are plain CSS again, which
 *  also means they are anti-aliased. */
export const PANEL_WIDTH = 420
export const SEARCH_HEIGHT = 54
/** Gap between the search bar and the panel below it. */
export const SEARCH_PANEL_GAP = 11
/** Gap between the dot and the search-bar/panel pair. */
export const PANEL_GAP = 12

/** The panel is a fixed size: four window rows and two app rows, each section scrolling on
 *  its own. The renderer still measures it rather than computing it here, so panel.css stays
 *  the single source of the arithmetic — these two only bound what the renderer may ask for.
 *
 *  This is a deliberate departure, which has the panel hug its content behind a
 *  single scroller. Fixed sections are what keep the APPS header from sliding up the moment a
 *  window closes, and what lets an empty OPEN WINDOWS say so in place instead of vanishing. */
export const PANEL_MIN_HEIGHT = 64
/** A ceiling, not the design height. The laid-out panel is ~357: 20 of surface padding, two
 *  28px headers, 176 of window rows, 88 of app rows and the 17px divider block. Rounded up so
 *  a tweak to the type scale or the row count does not silently get clamped. */
export const PANEL_MAX_HEIGHT = 420

/** The gap panel.css holds between the glass surface and the bottom of its window, and so
 *  the amount the renderer adds to the height it asks for. Chromium snaps a box up to whole
 *  device pixels, which pushed the surface's bottom edge outside the window and clipped the
 *  rim drawn on it; the surface stops short instead. Keep in step with `--panel-headroom`. */
export const PANEL_HEADROOM = 2

/** Which side of its window the pill is pinned to. The dot normally opens leftward, so the
 *  circle sits at the window's right edge; parked against the left of a display it mirrors
 *  and opens rightward instead. */
export type PillDirection = 'left' | 'right'

/** One switchable window, as the panel renders it.
 *  `id` is the HWND. Window handles carry only 32 significant bits, so they survive the trip
 *  through IPC as ordinary numbers. */
export interface EzzyWindow {
  id: number
  /** The window title — what the row shows as its title line. */
  title: string
  /** The owning application, shown as the row's subtitle. Empty when it cannot be read. */
  app: string
  /** The owning executable's icon as a PNG data URL. Absent until it has been read off
   *  disk, and absent for good if the shell had none to give — the row falls back to the
   *  outline glyph either way, so this is never on the path to a usable panel. */
  icon?: string
}

/** An installed application that is not currently running, from the Start Menu index. */
export interface EzzyApp {
  /** Stable identity for React keys and launch requests. Opaque on purpose: it is the only
   *  thing the renderer sends back to ask for a launch, and the main process resolves it
   *  against the index rather than treating it as a path to execute. */
  id: string
  name: string
  /** PNG data URL, as EzzyWindow.icon. Start Apps entries have no file to read one from. */
  icon?: string
}

/** Something the query names directly rather than something the index found: a URL or a
 *  path that exists on disk. Offered as its own row above the two sections — the
 *  fallback for paths and URLs the launcher was always meant to have. */
export interface DirectTarget {
  kind: 'url' | 'path'
  /** What the row shows as its title — the query as the user typed it. */
  label: string
  /** What the row shows as its subtitle: "Open link" / the resolved path. */
  detail: string
}

/** Everything the panel renders. Windows and apps travel together so the two sections can
 *  never disagree about which apps count as "not running". */
export interface PanelData {
  windows: EzzyWindow[]
  apps: EzzyApp[]
  /** Non-null when the query is itself a URL or an existing path. */
  direct: DirectTarget | null
  /** The query these results answer; empty when the panel is just listing. Carried so the
   *  panel can tell "nothing is open" from "nothing matched what you typed" without
   *  keeping its own copy of the query in sync across two windows. */
  query: string
}

/** The empty panel, so main and renderer agree on what "nothing yet" looks like. */
export const EMPTY_PANEL_DATA: PanelData = { windows: [], apps: [], direct: null, query: '' }

/** Keys the search bar forwards to the panel. The input has focus, so the panel — which is
 *  a separate, deliberately unfocusable window — never sees a key event of its own. */
export type NavKey = 'up' | 'down' | 'enter'

/** How many app rows main will send. The APPS section scrolls, so this is not the number
 *  visible — it is the point past which more results stop being worth the icons they carry
 *  across IPC on every keystroke. */
export const MAX_APP_ROWS = 12

/** What the voice path is doing, as the search bar draws it — the mic glyph and the
 *  listening pulse live there. One value, not a set of flags: the states are mutually exclusive
 *  and the renderer should never have to work out which of several booleans wins.
 *
 *  The transcript itself is not in here. Chunk E is what shows the user what was heard; chunk
 *  D only has to say what is happening and, when a command misses, why. */
export type VoiceState =
  | { kind: 'idle' }
  /** First run: the speech model is coming down. */
  | { kind: 'downloading'; percent: number }
  /** The hold was recognised but the microphone is not capturing yet.
   *
   *  Opening the audio device costs 225-960ms on a cold graph, and nothing said during it is
   *  recorded — it is not quiet or garbled, it never existed. Before this state the surface
   *  said "Listening..." from the moment of the hold, which is an instruction to start
   *  talking into a device that is not there, and that is where a clipped first word came
   *  from. So the two moments are drawn apart: this one waits, and `listening` means the
   *  microphone is genuinely delivering audio. */
  | { kind: 'arming' }
  | { kind: 'listening' }
  /** Between the key coming up and the command running: transcribing, and possibly still
   *  waiting for whisper-server to finish loading the model. */
  | { kind: 'thinking' }
  /** It worked. Chunk D had no such state — a command that succeeded had already put the
   *  window in front of the user and taken the panel with it, so there was nothing left to
   *  draw on. Chunk E gives it the dot's own pill, which outlives the panel. */
  | { kind: 'done'; message: string; heard: string }
  /** A command that could not be carried out, and why. `heard` is absent when the failure
   *  came before there was a transcript — a blocked microphone, a download that failed. */
  | { kind: 'error'; message: string; micBlocked: boolean; heard?: string }

/** What the dot's renderer should do with its microphone.
 *
 *  Three states rather than a boolean because arming happens *before* listening does. The
 *  microphone takes 300-950ms to open — measured on this machine — and a user who starts
 *  talking as they press loses the first word to that. So the device is opened the instant the
 *  hotkey goes down, before Ezzy knows whether this is a tap or a hold, and a tap throws the
 *  recording away unheard. */
export type VoiceCapture =
  /** Open the microphone and start buffering. */
  | 'arm'
  /** Open it and keep recording until the speaker stops, then send without being asked.
   *
   *  The hands-free half of the mic button: a click has no release to end it, so the recorder
   *  ends it by listening for the end of the sentence. Only the button uses this — a held
   *  hotkey already knows exactly when the user finished. */
  | 'listen'
  /** Stop and send what was recorded. */
  | 'stop'
  /** Stop, discard it, and let go of the device — this press turned out to be a tap. */
  | 'cancel'

/** Why the renderer could not record. Mapped from the DOMException getUserMedia rejects
 *  with, because the exception itself must not cross the bridge. */
export type VoiceFailure = 'denied' | 'no-device' | 'failed'

/** Everything the settings window draws. It is a fourth window and a
 *  cold renderer, so it asks for all of this once on open rather than assembling it from
 *  four round trips. */
export interface SettingsSnapshot {
  config: EzzyConfig
  /** The accelerator actually in force, which is not always `config.hotkey` — another app may
   *  have owned it first. Null when every candidate was taken. */
  activeHotkey: string | null
  version: string
  /** False in dev. `openAtLogin` and the updater both do nothing outside a packaged build,
   *  and the window says so rather than offering controls that quietly no-op. */
  packaged: boolean
  /** The log file the plan asks for, so the window can point at the file users attach to issues. */
  logPath: string
}

/** The answer to a settings change. The hotkey is the one field the OS can refuse — every
 *  other setting is ours to keep — so it comes back with the snapshot rather than being
 *  reported through a second channel. */
export interface SettingsResult {
  snapshot: SettingsSnapshot
  /** Non-null when the requested hotkey could not be registered; the message names what took
   *  over instead. The config still holds what was asked for, so it can be tried again after
   *  the other app is closed. */
  hotkeyError: string | null
}

/** Where the auto-updater is. Drawn by the settings window and reduced
 *  to one line in the tray menu. */
export type UpdateStatus =
  | { kind: 'idle' }
  /** Dev builds and anything else electron-updater will not check. */
  | { kind: 'unsupported'; reason: string }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  /** Downloaded and staged. It installs on the next quit on its own; restarting now is the
   *  offer, not the requirement. */
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }

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
  appearance: 'app:appearance',
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

/** The surface the preload exposes on `window.ezzy`. Named functions only.
 *  Drag coordinates come from the renderer's pointer events rather than being read in the
 *  main process — see the note in main/windows.ts for why that distinction matters. */
export interface EzzyApi {
  startDotDrag(screenX: number, screenY: number): void
  moveDotDrag(screenX: number, screenY: number): void
  endDotDrag(): void
  /** Reports the pill's measured open width so the main process can hit-test the cursor
   *  against the same rectangle the renderer draws. */
  setPillWidth(width: number): void
  /** Hover is detected in the main process, because a click-through window receives no
   *  mouse events of its own. */
  onDotHover(callback: (hovered: boolean) => void): () => void
  getPillSide(): Promise<PillDirection>
  /** Returns an unsubscribe function; without one the listener outlives the effect. */
  onPillSide(callback: (side: PillDirection) => void): () => void
  closePanel(): void
  getHotkey(): Promise<string>
  /** The surface treatment as of now. Every window asks on load, because each is its own
   *  document and none of them shares a stylesheet at runtime. */
  getAppearance(): Promise<Appearance>
  /** Fires when it is changed in Settings, so the change lands without a restart. Returns an
   *  unsubscribe function. */
  onAppearance(callback: (appearance: Appearance) => void): () => void
  /** The cached window list and app index. Reads variables in the main process — no OS
   *  enumeration happens here, which is what keeps the panel inside the 50ms budget. */
  getPanelData(): Promise<PanelData>
  /** Fires while the panel is open, so a window that opens or is renamed behind it shows up
   *  without the user closing and reopening. Returns an unsubscribe function. */
  onPanelChanged(callback: (data: PanelData) => void): () => void
  /** Brings a window to the front. Resolves false when Windows refused, so the panel can
   *  stay open rather than dismissing over a switch that never happened. */
  focusWindow(id: number): Promise<boolean>
  /** Fires each time the panel is shown, carrying the list as of that moment. The renderer
   *  never re-requests on open — the list rides along with the event, which removes a round
   *  trip from the hotkey path. Returns an unsubscribe function. */
  onPanelShown(callback: (data: PanelData) => void): () => void
  /** Starts an installed app that is not running. Resolves false if Windows refused. */
  launchApp(id: string): Promise<boolean>
  /** The panel hugs its content, so the
   *  renderer measures the rendered rows and the main process resizes the window to match. */
  setPanelHeight(height: number): void
  /** Reports what has been typed. The matching itself runs in the main process, which is
   *  where both lists already live — the results come back through onPanelChanged. */
  setQuery(query: string): void
  /** Forwards a navigation key from the search input to the panel window. */
  navigate(key: NavKey): void
  /** Panel side of `navigate`. Returns an unsubscribe function. */
  onNavigate(callback: (key: NavKey) => void): () => void
  /** Fires on the search bar when the panel opens, so the input clears and takes focus.
   *  Returns an unsubscribe function. */
  onSearchReset(callback: () => void): () => void
  /** Opens the direct row — the URL or path the current query names. Takes no target: the
   *  main process opens the one it computed, so nothing the renderer sends can widen this
   *  into "open any path you like". */
  openDirect(): Promise<boolean>
  /** Voice progress, for the search bar. Returns an unsubscribe function. */
  onVoiceState(callback: (state: VoiceState) => void): () => void
  /** The state as of right now. The search bar is hidden for most of a download, so it asks
   *  on the way back up rather than relying on having heard every change. */
  getVoiceState(): Promise<VoiceState>
  /** The dot window's half of push-to-talk. Recording lives in the dot's renderer because
   *  `getUserMedia` is a web API and the dot is the one window that is always alive — the
   *  search bar only exists while the panel is open, which is not long enough to hold a
   *  microphone open across a command. */
  onVoiceCapture(callback: (capture: VoiceCapture) => void): () => void
  /** The microphone is now delivering audio for this session. Sent once per session, on the
   *  first block that is actually captured, which is the only moment either process can
   *  honestly call it listening. Everything before it is `arming`. */
  reportMicLive(): void
  /** The recorded utterance as a 16kHz mono WAV. The main process POSTs it to whisper-server;
   *  the bytes never touch the network beyond localhost.
   *
   *  `spoke` is the recorder's answer to "was anybody talking?", measured from the signal
   *  before any gain was applied to it. It rides along with the audio rather than arriving on
   *  a channel of its own, so the main process still gets exactly one answer per hold. */
  sendVoiceAudio(wav: ArrayBuffer, spoke: boolean): void
  /** Recording could not start. Sent instead of the audio, so main stops waiting for it. */
  reportVoiceFailure(kind: VoiceFailure): void
  /** Opens Windows' microphone privacy page — a blocked mic must lead somewhere, not to
   *  a dead button. */
  openMicSettings(): void
  /** Windows' touchpad page, for the gesture mapping the plan asks users to set up themselves —
   *  Ezzy reads no gestures of its own. */
  openTouchpadSettings(): void
  /** The mic button on the search bar. Starts listening if it is not, sends what it has if it
   *  is — a click cannot be held down the way the hotkey is, so the same button ends it. */
  toggleVoice(): void
  /** Something to say out loud. `speechSynthesis` is a web API and does not exist in the
   *  main process, so the sentence is decided there and spoken here. Only the dot's renderer
   *  subscribes — it is the one window that is always alive, and the confirmation for a
   *  command usually arrives after the panel has already gone. An empty string means stop
   *  talking. Returns an unsubscribe function. */
  onSpeak(callback: (text: string) => void): () => void

  // ---------------------------------------------------------------- chunk F
  /** Opens the settings window. On the panel's APPS header, which is the only surface a
   *  keyboard-only user ever has in front of them — the tray menu needs a mouse and a trip to
   *  the notification area. Dismisses the panel with it. */
  openSettings(): void
  /** Everything the settings window draws, as of now. */
  getSettings(): Promise<SettingsSnapshot>
  /** Changes one or more settings and returns the state that resulted — which is not always
   *  the state that was asked for, since Windows can refuse a hotkey. */
  setSettings(patch: Partial<EzzyConfig>): Promise<SettingsResult>
  closeSettings(): void
  /** Opens the log file the plan asks for, in whatever the machine uses for.log. */
  openLogFile(): void
  /** A crash in a renderer, on its way to that same log file. The error object itself does
   *  not cross the bridge — only the page it happened on and what it said. */
  reportError(page: string, message: string): void
  getUpdateStatus(): Promise<UpdateStatus>
  /** Returns an unsubscribe function. */
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void
  /** Checks now, rather than waiting for the next scheduled check. */
  checkForUpdates(): void
  /** Quits and installs a downloaded update. */
  installUpdate(): void
}
