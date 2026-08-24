/** Types and constants shared by the main, preload and renderer processes. */

export interface DotPosition {
  x: number
  y: number
}

export interface EzzyConfig {
  /** Electron accelerator string, e.g. 'Alt+Space'. */
  hotkey: string
  openAtLogin: boolean
  /** Dot position keyed by display id, so each monitor remembers its own spot. */
  dotPositions: Record<string, DotPosition>
  /** Display the dot was last on, used to pick a position at startup. */
  lastDisplayId: string | null
}

export const DEFAULT_CONFIG: EzzyConfig = {
  hotkey: 'Alt+Space',
  openAtLogin: true,
  dotPositions: {},
  lastDisplayId: null
}

/** Window geometry (PLAN.md §6).
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
export const PILL_DELTA = PILL_VISUAL - DOT_VISUAL
export const DOT_SLACK = 16
export const DOT_WINDOW = DOT_VISUAL + DOT_SLACK * 2
export const PILL_WINDOW = PILL_VISUAL + DOT_SLACK * 2
export const DOT_GLYPH_SIZE = 32
/** §6: the search bar and the panel are two separate windows that show, hide and move as a
 *  unit, 11px apart — not one window with a divider.
 *
 *  Both are `transparent: true`. §6 originally specified `backgroundMaterial: 'acrylic'`,
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
 *  This is a deliberate departure from §6, which has the panel hug its content behind a
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
 *  and opens rightward instead (§6). */
export type PillDirection = 'left' | 'right'

/** One switchable window, as the panel renders it (PLAN.md §6, row spec).
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
 *  path that exists on disk. Offered as its own row above the two sections (§8 chunk C,
 *  "shell.openPath / shell.openExternal fallback for paths and URLs"). */
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
  openDirect: 'panel:open-direct'
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
  /** The cached window list and app index. Reads variables in the main process — no OS
   *  enumeration happens here, which is what keeps the panel inside §7's 50ms budget. */
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
  /** The panel hugs its content (§6 shows it sized to the list, not a fixed slab), so the
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
}
