import { BrowserWindow, Display, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { DOT_SIZE, DotPosition, PANEL_GAP, PANEL_HEIGHT, PANEL_WIDTH } from '../shared/types'
import { getConfig, updateConfig } from './config'
import { log, since } from './verbose'

let dotWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let quitting = false
let dragOffset: DotPosition | null = null

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
function clampBounds(bounds: Electron.Rectangle, display: Display): DotPosition {
  const area = display.workArea
  return {
    x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height))
  }
}

function restoreDotPosition(): DotPosition {
  const config = getConfig()
  const saved = config.lastDisplayId ? config.dotPositions[config.lastDisplayId] : undefined
  if (saved) {
    const display =
      screen.getAllDisplays().find((d) => String(d.id) === config.lastDisplayId) ??
      screen.getPrimaryDisplay()
    return clampBounds({ ...saved, width: DOT_SIZE, height: DOT_SIZE }, display)
  }
  // First run: park it against the right edge, vertically centred.
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(area.x + area.width - DOT_SIZE - 24),
    y: Math.round(area.y + area.height / 2 - DOT_SIZE / 2)
  }
}

function persistDotPosition(): void {
  if (!dotWindow) return
  const bounds = dotWindow.getBounds()
  const id = String(screen.getDisplayMatching(bounds).id)
  updateConfig({
    dotPositions: { ...getConfig().dotPositions, [id]: { x: bounds.x, y: bounds.y } },
    lastDisplayId: id
  })
}

/** §5: re-clamp on display changes, or the dot ends up off-screen and unreachable.
 *  The clamped position is deliberately not saved — Windows reports transient work areas
 *  while DPI contexts settle, and persisting those would overwrite the spot the user chose. */
export function clampDotIntoBounds(): void {
  if (!dotWindow) return
  const bounds = dotWindow.getBounds()
  const next = clampBounds(bounds, screen.getDisplayMatching(bounds))
  if (next.x === bounds.x && next.y === bounds.y) return
  dotWindow.setPosition(next.x, next.y)
  log(`dot re-clamped from ${bounds.x},${bounds.y} to ${next.x},${next.y}`)
}

export function watchDisplays(): void {
  screen.on('display-metrics-changed', clampDotIntoBounds)
  screen.on('display-added', clampDotIntoBounds)
  screen.on('display-removed', clampDotIntoBounds)
}

// ---------------------------------------------------------------------- dragging

// The renderer only reports that a drag is happening; the cursor position is read here
// so the dot never has to convert between CSS pixels and DIP across mixed-DPI monitors.

export function beginDotDrag(): void {
  if (!dotWindow) return
  const cursor = screen.getCursorScreenPoint()
  const [x, y] = dotWindow.getPosition()
  dragOffset = { x: cursor.x - x, y: cursor.y - y }
}

export function moveDotDrag(): void {
  if (!dotWindow || !dragOffset) return
  const cursor = screen.getCursorScreenPoint()
  dotWindow.setPosition(cursor.x - dragOffset.x, cursor.y - dragOffset.y)
}

export function endDotDrag(): void {
  if (!dragOffset) return
  dragOffset = null
  clampDotIntoBounds()
  persistDotPosition()
}

// ------------------------------------------------------------------------- panel

/** §6: the panel opens next to the dot, clamped to stay on-screen near edges. */
function panelPosition(): DotPosition {
  const dot = dotWindow?.getBounds() ?? { x: 0, y: 0, width: DOT_SIZE, height: DOT_SIZE }
  const panel = panelWindow?.getBounds() ?? {
    x: 0,
    y: 0,
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT
  }
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
  panelWindow.setPosition(x, y)
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
