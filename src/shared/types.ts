/** Types and constants shared by the main, preload and renderer processes. */

export interface DotPosition {
  x: number
  y: number
}

export interface EzyConfig {
  /** Electron accelerator string, e.g. 'Alt+Space'. */
  hotkey: string
  openAtLogin: boolean
  /** Dot position keyed by display id, so each monitor remembers its own spot. */
  dotPositions: Record<string, DotPosition>
  /** Display the dot was last on, used to pick a position at startup. */
  lastDisplayId: string | null
}

export const DEFAULT_CONFIG: EzyConfig = {
  hotkey: 'Alt+Space',
  openAtLogin: true,
  dotPositions: {},
  lastDisplayId: null
}

/** Window geometry from PLAN.md §6. The dot glyph is 44px; the window carries 6px of
 *  slack on each side so the hover glow is not clipped by the window bounds. */
export const DOT_GLYPH_SIZE = 44
export const DOT_SIZE = 56
export const PANEL_WIDTH = 480
export const PANEL_HEIGHT = 420
export const PANEL_GAP = 12

export const IPC = {
  dotDragStart: 'dot:drag-start',
  dotDragMove: 'dot:drag-move',
  dotDragEnd: 'dot:drag-end',
  dotClick: 'dot:click',
  panelClose: 'panel:close',
  getHotkey: 'app:get-hotkey'
} as const

/** The surface the preload exposes on `window.ezy`. Named functions only. */
export interface EzyApi {
  startDotDrag(): void
  moveDotDrag(): void
  endDotDrag(): void
  clickDot(): void
  closePanel(): void
  getHotkey(): Promise<string>
}
