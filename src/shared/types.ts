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
export const PANEL_WIDTH = 430
export const PANEL_HEIGHT = 420
export const PANEL_GAP = 12

/** Which side of its window the pill is pinned to. The dot normally opens leftward, so the
 *  circle sits at the window's right edge; parked against the left of a display it mirrors
 *  and opens rightward instead (§6). */
export type PillDirection = 'left' | 'right'

export const IPC = {
  dotDragStart: 'dot:drag-start',
  dotDragMove: 'dot:drag-move',
  dotDragEnd: 'dot:drag-end',
  setPillWidth: 'dot:set-pill-width',
  dotHover: 'dot:hover',
  getPillSide: 'dot:get-pill-side',
  pillSide: 'dot:pill-side',
  panelClose: 'panel:close',
  getHotkey: 'app:get-hotkey'
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
}
