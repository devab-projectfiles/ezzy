import { BrowserWindow, Display, screen, session } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  DOT_VISUAL,
  DOT_WINDOW,
  DotPosition,
  PanelData,
  IPC,
  PANEL_GAP,
  PANEL_MAX_HEIGHT,
  PANEL_MIN_HEIGHT,
  PANEL_WIDTH,
  PILL_DELTA,
  PILL_VISUAL,
  PILL_WINDOW,
  PillDirection,
  SEARCH_HEIGHT,
  SEARCH_PANEL_GAP,
  STATUS_VISUAL,
  VoiceCapture,
  VoiceState,
  Appearance,
  DotMark,
  SpeechRequest
} from '../shared/types'
import { getConfig, updateConfig } from './config'
import { log, since } from './verbose'
import { clearQuery, panelData } from './panel-data'

let dotWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let searchWindow: BrowserWindow | null = null
let quitting = false
let drag: DragState | null = null
let panelHeight = PANEL_MIN_HEIGHT

/** Top-left of the square the collapsed circle occupies. Reading the live rectangle back
 *  would drift with the pill's own width, so this is the source of truth instead. */
let dotAnchor: DotPosition = { x: 0, y: 0 }
let pillSide: PillDirection = 'left'
let hovered = false
let pillOpen = false
let hoverTimer: ReturnType<typeof setInterval> | null = null
let dotStatus = false
let pillSlide = 0
let pillWidth = PILL_VISUAL

/** Granted once at creation and reused on every move — reading the size back at a
 *  fractional scale factor returns a larger value than was set, which would grow the
 *  window on every drag. */
let pillFrame = { width: PILL_WINDOW, height: DOT_WINDOW }
let dotFrame = { width: DOT_WINDOW, height: DOT_WINDOW }
let pillDelta = PILL_DELTA

interface DragState {
  pointerOrigin: DotPosition
  windowOrigin: DotPosition
  commanded: DotPosition
  startedAt: number
}

const IDLE: VoiceState = { kind: 'idle' }
const MAX_DRAG_MS = 20_000
const HOVER_POLL_MS = 30

export function setQuitting(value: boolean): void {
  quitting = value
}

export function createWindows(): void {
  applyPermissionPolicy()
  dotAnchor = restoreDotPosition()

  dotWindow = new BrowserWindow({
    width: PILL_WINDOW,
    height: DOT_WINDOW,
    x: dotAnchor.x - PILL_DELTA,
    y: dotAnchor.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // DWM's own rounded corners composite as an opaque plate on a transparent window;
    // every corner here is drawn in CSS instead.
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    webPreferences: webPreferences()
  })
  const granted = dotWindow.getBounds()
  pillFrame = { width: granted.width, height: granted.height }
  dotFrame = { width: granted.height, height: granted.height }
  pillDelta = granted.width - granted.height
  dotWindow.setIgnoreMouseEvents(true)
  applyAlwaysPresent(dotWindow)
  clampDotIntoBounds()
  applyDotBounds()
  dotWindow.once('ready-to-show', () => dotWindow?.showInactive())
  loadRenderer(dotWindow, 'dot')

  searchWindow = createGlassWindow(SEARCH_HEIGHT)
  panelWindow = createGlassWindow(PANEL_MIN_HEIGHT)
  panelWindow.setFocusable(false)

  searchWindow.on('blur', () => {
    if (searchWindow?.webContents.isDevToolsOpened()) return
    if (panelWindow?.webContents.isDevToolsOpened()) return
    hidePanel()
  })

  loadRenderer(searchWindow, 'searchbar')
  loadRenderer(panelWindow, 'panel')
}

function createGlassWindow(height: number): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: webPreferences()
  })
  applyAlwaysPresent(win)
  return win
}

function applyPermissionPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    if (permission !== 'media') log(`refused a "${permission}" permission request`)
    callback(permission === 'media')
  })
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission) => permission === 'media'
  )
}

export function webPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    // No user gesture ever reaches these windows, so speech synthesis needs this or
    // Chromium queues and silently drops it.
    autoplayPolicy: 'no-user-gesture-required',
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}

export type RendererPage = 'dot' | 'searchbar' | 'panel' | 'settings'

export function loadRenderer(win: BrowserWindow, page: RendererPage): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', (details) => {
    log(`[${page}] ${details.level}: ${details.message}`)
  })
  win.webContents.on('did-fail-load', (_e, code, description) => {
    console.error(`[ezzy] ${page} failed to load: ${code} ${description}`)
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${page}.html`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${page}.html`))
  }
}

function applyAlwaysPresent(win: BrowserWindow): void {
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

function moveDotTo(position: DotPosition): void {
  dotAnchor = position
  applyDotBounds()
}

/** Always a pure move, never a resize — resizing a transparent window on Windows
 *  re-creates its surface and flashes. */
function applyDotBounds(): void {
  if (!dotWindow) return
  const display = screen.getDisplayMatching(dotBoundsAt(dotAnchor))
  const opensLeft = dotAnchor.x - pillDelta >= display.bounds.x
  const anchored = opensLeft ? dotAnchor.x - pillDelta : dotAnchor.x

  let x = anchored
  if (!drag && (dotStatus || pillOpen)) {
    const left = display.bounds.x
    const right = display.bounds.x + display.bounds.width - pillFrame.width
    x = Math.min(Math.max(anchored, left), right)
  }
  pillSlide = x - anchored

  dotWindow.setBounds({ x, y: dotAnchor.y, ...pillFrame })
  const side: PillDirection = opensLeft ? 'left' : 'right'
  if (side === pillSide) return
  pillSide = side
  dotWindow.webContents.send(IPC.pillSide, side)
  log(`pill now opens ${side === 'left' ? 'leftward' : 'rightward'}`)
}

export function currentPillSide(): PillDirection {
  return pillSide
}

export function setPillWidth(width: number): void {
  pillWidth = Math.max(DOT_VISUAL, Math.min(Math.round(width), STATUS_VISUAL))
}

function pillScreenRect(): Electron.Rectangle {
  const inset = visualInset()
  const anchoredX = dotAnchor.x + inset
  const circleX = anchoredX + pillSlide
  const width = pillOpen ? pillWidth : DOT_VISUAL
  const x = pillSide === 'left' ? circleX + DOT_VISUAL - width : circleX
  const y = dotAnchor.y + inset
  if (pillSlide === 0) return { x, y, width, height: DOT_VISUAL }

  const left = Math.min(x, anchoredX)
  const right = Math.max(x + width, anchoredX + DOT_VISUAL)
  return { x: left, y, width: right - left, height: DOT_VISUAL }
}

export function watchCursor(): void {
  hoverTimer = setInterval(() => {
    if (!dotWindow || drag) return
    const cursor = screen.getCursorScreenPoint()
    const rect = pillScreenRect()
    const inside =
      cursor.x >= rect.x &&
      cursor.x <= rect.x + rect.width &&
      cursor.y >= rect.y &&
      cursor.y <= rect.y + rect.height
    if (inside === hovered) return
    hovered = inside
    dotWindow.setIgnoreMouseEvents(!inside)
    pillOpen = inside
    applyDotBounds()
    dotWindow.webContents.send(IPC.dotHover, inside)
  }, HOVER_POLL_MS)
}

export function stopWatchingCursor(): void {
  if (hoverTimer === null) return
  clearInterval(hoverTimer)
  hoverTimer = null
}

function dotBoundsAt(position: DotPosition): Electron.Rectangle {
  return { ...position, ...dotFrame }
}

function visualInset(): number {
  return Math.round((dotFrame.width - DOT_VISUAL) / 2)
}

const OFF_SCREEN_ALLOWANCE = 0.5

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
  return defaultDotPosition()
}

function defaultDotPosition(): DotPosition {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(area.x + area.width - dotFrame.width - 24 + visualInset()),
    y: Math.round(area.y + area.height / 2 - dotFrame.height / 2)
  }
}

function persistDotPosition(): void {
  if (!dotWindow) return
  const bounds = dotBoundsAt(dotAnchor)
  const display = screen.getDisplayMatching(bounds)
  const position = clampBounds(bounds, display)
  updateConfig({
    dotPositions: { ...getConfig().dotPositions, [String(display.id)]: position },
    lastDisplayId: String(display.id)
  })
}

export function clampDotIntoBounds(): void {
  if (!dotWindow) return
  const live = dotWindow.getBounds()
  if (Math.abs(live.width - pillFrame.width) > 4 || Math.abs(live.height - pillFrame.height) > 4) {
    console.warn(`[ezzy] dot inflated to ${live.width}x${live.height}, forcing it back`)
  }
  const bounds = dotBoundsAt(dotAnchor)
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

// Driven by screen coordinates the renderer reports from pointer events, never by reading
// the window position back mid-drag — on a fractional scale factor that rounds a pixel
// short each time and the cursor position moves in lockstep with the window, which
// together walked the dot off-screen under a still mouse.

export function beginDotDrag(pointer: DotPosition): void {
  if (!dotWindow) return
  pillOpen = false
  drag = {
    pointerOrigin: pointer,
    windowOrigin: { ...dotAnchor },
    commanded: { ...dotAnchor },
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
  if (pillSlide !== 0) {
    dotAnchor = { x: dotAnchor.x + pillSlide, y: dotAnchor.y }
    drag.windowOrigin = { x: drag.windowOrigin.x + pillSlide, y: drag.windowOrigin.y }
    drag.commanded = { ...dotAnchor }
    pillSlide = 0
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

export function resetDotPosition(): void {
  if (!dotWindow) return
  moveDotTo(defaultDotPosition())
  dotWindow.showInactive()
  persistDotPosition()
  log('dot position reset')
}

// ------------------------------------------------------------- search bar + panel

function layoutPair(): { search: Electron.Rectangle; panel: Electron.Rectangle } {
  const totalHeight = SEARCH_HEIGHT + SEARCH_PANEL_GAP + panelHeight
  const { x: left, y: top } = anchorToDot(PANEL_WIDTH, totalHeight)
  return {
    search: { x: left, y: top, width: PANEL_WIDTH, height: SEARCH_HEIGHT },
    panel: {
      x: left,
      y: top + SEARCH_HEIGHT + SEARCH_PANEL_GAP,
      width: PANEL_WIDTH,
      height: panelHeight
    }
  }
}

function anchorToDot(width: number, height: number): Electron.Rectangle {
  const inset = visualInset()
  const dot = {
    x: dotAnchor.x + inset,
    y: dotAnchor.y + inset,
    width: DOT_VISUAL,
    height: DOT_VISUAL
  }
  const area = screen.getDisplayMatching(dotBoundsAt(dotAnchor)).workArea

  let x = dot.x + dot.width + PANEL_GAP
  if (x + width > area.x + area.width) x = dot.x - width - PANEL_GAP
  x = Math.min(Math.max(x, area.x + PANEL_GAP), area.x + area.width - width - PANEL_GAP)

  let y = dot.y + dot.height / 2 - height / 2
  y = Math.min(Math.max(y, area.y + PANEL_GAP), area.y + area.height - height - PANEL_GAP)

  return { x: Math.round(x), y: Math.round(y), width, height }
}

function applyPairBounds(): void {
  if (!searchWindow || !panelWindow) return
  const { search, panel } = layoutPair()
  searchWindow.setBounds(search)
  panelWindow.setBounds(panel)
}

export function setPanelHeight(height: number): void {
  const next = Math.round(Math.min(Math.max(height, PANEL_MIN_HEIGHT), PANEL_MAX_HEIGHT))
  if (next === panelHeight) return
  panelHeight = next
  if (panelWindow?.isVisible()) applyPairBounds()
}

export function togglePanel(): void {
  if (!panelWindow || !searchWindow) return
  if (panelWindow.isVisible()) {
    hidePanel()
    return
  }
  showPanel()
}

export function showPanelForVoice(): void {
  if (panelWindow?.isVisible()) return
  showPanel()
}

function showPanel(): void {
  const startedAt = performance.now()
  if (!panelWindow || !searchWindow) return
  sendToDot(IDLE)
  clearQuery()
  applyPairBounds()
  panelWindow.webContents.send(IPC.panelShown, panelData())
  searchWindow.webContents.send(IPC.searchReset)
  panelWindow.showInactive()
  searchWindow.show()
  since('hotkey -> panel visible', startedAt)
}

export function publishPanelData(data: PanelData): void {
  if (!panelWindow || !panelWindow.isVisible()) return
  panelWindow.webContents.send(IPC.panelChanged, data)
}

let panelHiddenListener: (() => void) | null = null

export function onPanelHidden(listener: () => void): void {
  panelHiddenListener = listener
}

export function hidePanel(): void {
  const wasOpen = searchWindow?.isVisible() === true
  panelWindow?.hide()
  searchWindow?.hide()
  clearQuery()
  if (wasOpen) panelHiddenListener?.()
}

export function sendToPanel(channel: string, payload?: unknown): void {
  if (!panelWindow?.isVisible()) return
  panelWindow.webContents.send(channel, payload)
}

export function sendVoiceState(state: VoiceState): void {
  if (searchWindow?.isVisible()) {
    sendToDot(IDLE)
    searchWindow.webContents.send(IPC.voiceState, state)
    return
  }
  sendToDot(state)
}

function sendToDot(state: VoiceState): void {
  const status = state.kind !== 'idle'
  dotWindow?.webContents.send(IPC.voiceState, state)
  if (status === dotStatus) return
  dotStatus = status
  applyDotBounds()
}

export function speakInDot(request: SpeechRequest): void {
  dotWindow?.webContents.send(IPC.speak, request)
}

export function sendAppearance(appearance: Appearance): void {
  for (const win of [dotWindow, panelWindow, searchWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.appearance, appearance)
  }
}

export function sendDotLogo(mark: DotMark): void {
  if (dotWindow && !dotWindow.isDestroyed()) dotWindow.webContents.send(IPC.dotLogo, mark)
}

export function sendCapture(capture: VoiceCapture): void {
  dotWindow?.webContents.send(IPC.voiceCapture, capture)
}

export function showDot(): void {
  if (!dotWindow) return
  clampDotIntoBounds()
  dotWindow.showInactive()
}
