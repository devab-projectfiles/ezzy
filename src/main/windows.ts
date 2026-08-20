import { BrowserWindow, Display, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { DOT_SIZE, DotPosition, PANEL_GAP, PANEL_HEIGHT, PANEL_WIDTH } from '../shared/types'
import { getConfig, updateConfig } from './config'
import { log, since } from './verbose'

let dotWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let quitting = false
let drag: DragState | null = null

/** The sizes Windows actually granted these windows, captured once at creation.
 *
 *  setPosition() re-applies the window's current size internally, and reading that size
 *  back at a fractional scale factor returns a larger value than was set — 1.3625 here.
 *  Every move therefore grew the window: measured, one drag took the dot from 82x82 to
 *  201x199 physical pixels. A transparent, always-on-top window that has quietly grown to
 *  cover much of the desktop still receives mouse input across its whole rectangle, so it
 *  swallows the clicks meant for every app underneath it. Passing a fixed size on every
 *  move is what stops that, which is why nothing below ever reads a size back. */
let dotFrame = { width: DOT_SIZE, height: DOT_SIZE }
let panelFrame = { width: PANEL_WIDTH, height: PANEL_HEIGHT }

interface DragState {
  /** Pointer position, in screen coordinates, when the drag began. */
  pointerOrigin: DotPosition
  /** Window position when the drag began. */
  windowOrigin: DotPosition
  /** The last position we asked for, which is what the next move is compared against. */
  commanded: DotPosition
  startedAt: number
}

/** A drag still running after this long is a lost pointerup, not a patient user. */
const MAX_DRAG_MS = 20_000

/** Set from the tray Quit item so the close handlers stop hiding and let the app exit. */
export function setQuitting(value: boolean): void {
  quitting = value
}

export function createWindows(): void {
  const position = restoreDotPosition()

  dotWindow = new BrowserWindow({
    width: DOT_SIZE,
    height: DOT_SIZE,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // §5: if the dot takes focus we lose track of which window was in front.
    focusable: false,
    show: false,
    webPreferences: webPreferences()
  })
  dotFrame = { width: dotWindow.getBounds().width, height: dotWindow.getBounds().height }
  applyAlwaysPresent(dotWindow)
  clampDotIntoBounds()
  dotWindow.once('ready-to-show', () => dotWindow?.showInactive())
  loadRenderer(dotWindow, 'dot')

  panelWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: webPreferences()
  })
  panelFrame = {
    width: panelWindow.getBounds().width,
    height: panelWindow.getBounds().height
  }
  applyAlwaysPresent(panelWindow)
  panelWindow.on('blur', () => {
    if (panelWindow?.webContents.isDevToolsOpened()) return
    panelWindow?.hide()
  })
  loadRenderer(panelWindow, 'panel')
}

function webPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}

function loadRenderer(win: BrowserWindow, page: 'dot' | 'panel'): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${page}.html`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${page}.html`))
  }
}

/** The "always there" behaviour from PLAN.md §5 — items 1 to 4. */
function applyAlwaysPresent(win: BrowserWindow): void {
  // The plain alwaysOnTop flag sits below too many things; this level clears most of them.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setSkipTaskbar(true)
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })
}

// ---------------------------------------------------------------- dot position

/** Windows floors very small windows to a minimum size, and fractional display scaling
 *  rounds the rest, so a window is rarely the exact size it was asked for. Every
 *  calculation below therefore measures the live window instead of trusting the constant. */
function moveDotTo(position: DotPosition): void {
  dotWindow?.setBounds({ ...position, ...dotFrame })
}

function dotBoundsAt(position: DotPosition): Electron.Rectangle {
  return { ...position, ...dotFrame }
}

/** How much of the dot may be tucked past a display edge. Half of it stays on screen in
 *  every direction, which is enough to remain visible and grabbable, while letting the
 *  user park it mostly out of the way. Tray > Reset dot position brings it fully back. */
const OFF_SCREEN_ALLOWANCE = 0.5

/** Clamped against the display's full bounds rather than its work area, so the dot can be
 *  pushed down past the taskbar instead of stopping on top of it. The work area is still
 *  what the default position and the panel are placed within. */
function clampBounds(bounds: Electron.Rectangle, display: Display): DotPosition {
  const area = display.bounds
  const slackX = Math.round(bounds.width * OFF_SCREEN_ALLOWANCE)
  const slackY = Math.round(bounds.height * OFF_SCREEN_ALLOWANCE)
  return {
    x: Math.round(
      Math.min(Math.max(bounds.x, area.x - slackX), area.x + area.width - bounds.width + slackX)
    ),
    y: Math.round(
      Math.min(Math.max(bounds.y, area.y - slackY), area.y + area.height - bounds.height + slackY)
    )
  }
}

function restoreDotPosition(): DotPosition {
  const config = getConfig()
  const saved = config.lastDisplayId ? config.dotPositions[config.lastDisplayId] : undefined
  if (saved) {
    const display =
      screen.getAllDisplays().find((d) => String(d.id) === config.lastDisplayId) ??
      screen.getPrimaryDisplay()
    return clampBounds(dotBoundsAt(saved), display)
  }
  // First run: park it against the right edge, vertically centred.
  return defaultDotPosition()
}

/** Right edge, vertically centred, inset from the work area. */
function defaultDotPosition(): DotPosition {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(area.x + area.width - dotFrame.width - 24),
    y: Math.round(area.y + area.height / 2 - dotFrame.height / 2)
  }
}

function persistDotPosition(): void {
  if (!dotWindow) return
  const bounds = dotBoundsAt(dotWindow.getBounds())
  const display = screen.getDisplayMatching(bounds)
  // Store the clamped value, so a position that is somehow off-screen can never be the
  // one restored at the next launch.
  const position = clampBounds(bounds, display)
  updateConfig({
    dotPositions: { ...getConfig().dotPositions, [String(display.id)]: position },
    lastDisplayId: String(display.id)
  })
}

/** §5: re-clamp on display changes, or the dot ends up off-screen and unreachable.
 *  The clamped position is deliberately not saved — Windows reports transient work areas
 *  while DPI contexts settle, and persisting those would overwrite the spot the user chose. */
export function clampDotIntoBounds(): void {
  if (!dotWindow) return
  const live = dotWindow.getBounds()
  // A pixel or two of difference is the DIP rounding and is expected; anything larger
  // would mean the window is inflating again and is worth shouting about.
  if (Math.abs(live.width - dotFrame.width) > 4 || Math.abs(live.height - dotFrame.height) > 4) {
    console.warn(`[ezzy] dot inflated to ${live.width}x${live.height}, forcing it back`)
  }
  const bounds = dotBoundsAt(live)
  const next = clampBounds(bounds, screen.getDisplayMatching(bounds))
  if (next.x === bounds.x && next.y === bounds.y) return
  moveDotTo(next)
  log(`dot re-clamped from ${bounds.x},${bounds.y} to ${next.x},${next.y}`)
}

export function watchDisplays(): void {
  screen.on('display-metrics-changed', clampDotIntoBounds)
  screen.on('display-added', clampDotIntoBounds)
  screen.on('display-removed', clampDotIntoBounds)
}

// ---------------------------------------------------------------------- dragging

// Dragging is driven entirely by screen coordinates the renderer reports from its pointer
// events, and the window position is never read back while a drag is in flight. Both rules
// exist because of measured behaviour on a 1.3625 scale factor display:
//
//   * setPosition(x, y) followed by getBounds() comes back one pixel short on each axis,
//     because the DIP -> physical -> DIP round trip rounds. Feeding that result into the
//     next move subtracts another pixel, every frame, forever.
//   * screen.getCursorScreenPoint() shifts in lockstep with this window as it moves, so a
//     physically stationary mouse reports a moving cursor. Deriving the target from it is
//     self-referential.
//
// Together those made the dot walk off the screen under a still mouse, at one SetWindowPos
// call per pointer event on an always-on-top window, which is what wedged desktop input.

export function beginDotDrag(pointer: DotPosition): void {
  if (!dotWindow) return
  const bounds = dotWindow.getBounds()
  drag = {
    pointerOrigin: pointer,
    windowOrigin: { x: bounds.x, y: bounds.y },
    commanded: { x: bounds.x, y: bounds.y },
    startedAt: performance.now()
  }
}

export function moveDotDrag(pointer: DotPosition): void {
  if (!dotWindow || !drag) return
  if (performance.now() - drag.startedAt > MAX_DRAG_MS) {
    log('drag ran past its safety timeout, ending it')
    endDotDrag()
    return
  }
  const target = dotBoundsAt({
    x: drag.windowOrigin.x + (pointer.x - drag.pointerOrigin.x),
    y: drag.windowOrigin.y + (pointer.y - drag.pointerOrigin.y)
  })
  const next = clampBounds(target, screen.getDisplayMatching(target))
  if (next.x === drag.commanded.x && next.y === drag.commanded.y) return
  drag.commanded = next
  moveDotTo(next)
}

export function endDotDrag(): void {
  if (!drag) return
  drag = null
  clampDotIntoBounds()
  persistDotPosition()
}

/** Tray rescue for a dot that has ended up somewhere unreachable. */
export function resetDotPosition(): void {
  if (!dotWindow) return
  moveDotTo(defaultDotPosition())
  dotWindow.showInactive()
  persistDotPosition()
  log('dot position reset')
}

// ------------------------------------------------------------------------- panel

/** §6: the panel opens next to the dot, clamped to stay on-screen near edges. */
function panelPosition(): DotPosition {
  const dot = dotBoundsAt(dotWindow?.getBounds() ?? { x: 0, y: 0 })
  const panel = panelFrame
  const area = screen.getDisplayMatching(dot).workArea

  let x = dot.x + dot.width + PANEL_GAP
  if (x + panel.width > area.x + area.width) x = dot.x - panel.width - PANEL_GAP
  x = Math.min(Math.max(x, area.x + PANEL_GAP), area.x + area.width - panel.width - PANEL_GAP)

  let y = dot.y + dot.height / 2 - panel.height / 2
  y = Math.min(Math.max(y, area.y + PANEL_GAP), area.y + area.height - panel.height - PANEL_GAP)

  return { x: Math.round(x), y: Math.round(y) }
}

export function togglePanel(): void {
  const startedAt = performance.now()
  if (!panelWindow) return
  if (panelWindow.isVisible()) {
    panelWindow.hide()
    return
  }
  const { x, y } = panelPosition()
  panelWindow.setBounds({ x, y, ...panelFrame })
  panelWindow.show()
  since('hotkey -> panel visible', startedAt)
}

export function hidePanel(): void {
  panelWindow?.hide()
}

export function showDot(): void {
  if (!dotWindow) return
  clampDotIntoBounds()
  dotWindow.showInactive()
}
