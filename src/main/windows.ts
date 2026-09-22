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
/** The second glass surface: the 420x54 pill above the panel. */
let searchWindow: BrowserWindow | null = null
let quitting = false
let drag: DragState | null = null
/** The panel's current height. It hugs its content, so the renderer drives this. */
let panelHeight = PANEL_MIN_HEIGHT

/** Top-left of the square the collapsed circle would occupy on its own. The single source
 *  of truth for the dot's position — the real window is wider (the pill) and its `x`
 *  depends on which way it opens, so reading the live rectangle back would drift the dot
 *  by the pill's width. */
let dotAnchor: DotPosition = { x: 0, y: 0 }
let pillSide: PillDirection = 'left'
/** Whether the cursor is over the pill. Owned here rather than in the renderer: the window
 *  is click-through when idle, and a click-through window receives no mouse events at all —
 *  so main watches the cursor position directly instead. */
let hovered = false
/** Whether the pill is actually drawn open. Tracks `hovered` except after a press, which
 *  snaps it shut while the cursor is still on it — the hit rectangle shrinks with it. */
let pillOpen = false
let hoverTimer: ReturnType<typeof setInterval> | null = null
/** Whether the pill is drawing a voice status rather than the dot mark. Owned here because
 *  this process decides to send one. */
let dotStatus = false
/** How far the dot window has been slid off its anchor to keep an open status pill on
 *  screen. Zero except when a status is up on a dot parked past a display edge. */
let pillSlide = 0
/** The pill's opened width, measured from its own content by the renderer. */
let pillWidth = PILL_VISUAL

/** The sizes Windows actually granted, captured once at creation. `setPosition()` followed
 *  by `getBounds()` at a fractional scale factor returns a size larger than was set — every
 *  move would otherwise grow the window, and a grown always-on-top window swallows clicks
 *  meant for whatever is underneath it. So a fixed size is passed on every move instead. */
let pillFrame = { width: PILL_WINDOW, height: DOT_WINDOW }
/** The collapsed circle's square footprint. Used for clamping and for anchoring the panel. */
let dotFrame = { width: DOT_WINDOW, height: DOT_WINDOW }
/** How much wider the window is than that square, i.e. how far the pill can open. */
let pillDelta = PILL_DELTA

interface DragState {
  pointerOrigin: DotPosition
  windowOrigin: DotPosition
  /** The last position asked for, compared against the next move. */
  commanded: DotPosition
  startedAt: number
}

const IDLE: VoiceState = { kind: 'idle' }

/** A drag still running after this long is a lost pointerup, not a patient user. */
const MAX_DRAG_MS = 20_000

/** Cursor sampling rate for hover, far cheaper than a pill-wide window swallowing clicks. */
const HOVER_POLL_MS = 30

/** Set from the tray Quit item so the close handlers stop hiding and let the app exit. */
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
    // DWM's rounded rectangle would otherwise composite as an opaque dark plate behind a
    // transparent window, at the system radius rather than ours — every corner is drawn in CSS.
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // If the dot takes focus we lose track of which window was in front.
    focusable: false,
    show: false,
    webPreferences: webPreferences()
  })
  const granted = dotWindow.getBounds()
  pillFrame = { width: granted.width, height: granted.height }
  dotFrame = { width: granted.height, height: granted.height }
  pillDelta = granted.width - granted.height
  // Click-through until the cursor is actually over the pill.
  dotWindow.setIgnoreMouseEvents(true)
  applyAlwaysPresent(dotWindow)
  clampDotIntoBounds()
  applyDotBounds()
  dotWindow.once('ready-to-show', () => dotWindow?.showInactive())
  loadRenderer(dotWindow, 'dot')

  // The search bar and the panel are separate windows so the 11px gap between them shows
  // the desktop rather than a seam. They move as one unit.
  searchWindow = createGlassWindow(SEARCH_HEIGHT)
  panelWindow = createGlassWindow(PANEL_MIN_HEIGHT)

  // The search bar holds the text input and takes focus; the panel is unfocusable so a
  // click on a row cannot pull focus out of the input mid-word. Arrow keys and Enter reach
  // it by being forwarded (IPC.panelNav).
  panelWindow.setFocusable(false)

  searchWindow.on('blur', () => {
    if (searchWindow?.webContents.isDevToolsOpened()) return
    if (panelWindow?.webContents.isDevToolsOpened()) return
    hidePanel()
  })

  loadRenderer(searchWindow, 'searchbar')
  loadRenderer(panelWindow, 'panel')
}

/** One of the two glass surfaces — same window underneath, only height and contents differ.
 *  `transparent: true`, not acrylic: acrylic follows the Windows theme and frosts the
 *  surface into a milky slab, and needs a window region that is not anti-aliased. */
function createGlassWindow(height: number): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // The OS shadow draws around the window's square, not the rounded surface inside it.
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

/** The only permission Ezzy has any use for is the microphone, for push-to-talk. Everything
 *  else is refused rather than left to Electron's more permissive default. */
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
    // Chromium gates speech synthesis behind a user gesture; these windows are never
    // clicked (dragged, or triggered by a global hotkey), so confirmations would be
    // silently dropped without this.
    autoplayPolicy: 'no-user-gesture-required',
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}

/** The four pages, one per window. Settings is the odd one out — an ordinary framed window
 *  built in settings-window.ts, borrowing only the loading and security flags from here. */
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

function moveDotTo(position: DotPosition): void {
  dotAnchor = position
  applyDotBounds()
}

/** The one place the dot window is positioned. Always a pure move — resizing a transparent
 *  window on Windows re-creates its composited surface and flashes.
 *
 *  The pill opens leftward, so spare width sits on the left and the circle rides the right
 *  edge; parked against the left of a display it mirrors instead. */
function applyDotBounds(): void {
  if (!dotWindow) return
  const display = screen.getDisplayMatching(dotBoundsAt(dotAnchor))
  const opensLeft = dotAnchor.x - pillDelta >= display.bounds.x
  const anchored = opensLeft ? dotAnchor.x - pillDelta : dotAnchor.x

  // The dot tucks half past a screen edge when idle and slides fully on screen while its
  // pill is open — otherwise an open pill's text runs off the edge with it ("Switching to
  // Notepad" drew as "Switching to Notep"). Skipped during a drag, or the window would lag
  // the cursor as it neared the edge; moveDotDrag folds any slide into the anchor instead.
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

/** The renderer measures the pill against its own text and reports the result, so hover
 *  hit-testing matches what is actually drawn. */
export function setPillWidth(width: number): void {
  pillWidth = Math.max(DOT_VISUAL, Math.min(Math.round(width), STATUS_VISUAL))
}

/** The pill's rectangle in screen coordinates. Grows once hovered, which gives the hover
 *  test hysteresis for free: the cursor must reach the circle to open the pill, but may
 *  then roam anywhere over it without closing it. */
function pillScreenRect(): Electron.Rectangle {
  const inset = visualInset()
  const anchoredX = dotAnchor.x + inset
  // Plus any slide: the circle is drawn at a fixed place inside the window, so a slid
  // window is a moved circle.
  const circleX = anchoredX + pillSlide
  const width = pillOpen ? pillWidth : DOT_VISUAL
  const x = pillSide === 'left' ? circleX + DOT_VISUAL - width : circleX
  const y = dotAnchor.y + inset
  if (pillSlide === 0) return { x, y, width, height: DOT_VISUAL }

  // Also covers where the circle was BEFORE the slide — opening the pill moves the window,
  // and the cursor that opened it sits on the untucked circle's old position. Without this
  // union the cursor lands outside the instant the window moves and the pair oscillates.
  const left = Math.min(x, anchoredX)
  const right = Math.max(x + width, anchoredX + DOT_VISUAL)
  return { x: left, y, width: right - left, height: DOT_VISUAL }
}

/** Stands down during a drag — reading the cursor is self-referential while the window is
 *  being moved under it. */
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

/** Transparent margin between the collapsed square and the glass circle drawn inside it.
 *  Derived from the granted frame rather than the constant — Windows rarely grants exactly
 *  the size asked for. */
function visualInset(): number {
  return Math.round((dotFrame.width - DOT_VISUAL) / 2)
}

/** How much of the dot may be tucked past a display edge — half the collapsed square, which
 *  leaves exactly half the visible circle on screen. Tray > Reset dot position undoes it. */
const OFF_SCREEN_ALLOWANCE = 0.5

/** Clamped against the display's full bounds rather than its work area, so the dot can sit
 *  past the taskbar instead of stopping on top of it. */
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

/** Right edge, vertically centred, with the visible circle — not the padded square — inset
 *  from the work area. */
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
  // Clamped, so a position that is somehow off-screen is never restored next launch.
  const position = clampBounds(bounds, display)
  updateConfig({
    dotPositions: { ...getConfig().dotPositions, [String(display.id)]: position },
    lastDisplayId: String(display.id)
  })
}

/** Re-clamp on display changes, or the dot ends up off-screen and unreachable. Not saved —
 *  Windows reports transient work areas while DPI contexts settle. */
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

// Driven entirely by screen coordinates the renderer reports from pointer events; the
// window position is never read back mid-drag. Both are needed on a fractional scale
// factor: setPosition() -> getBounds() rounds a pixel short each time, and
// getCursorScreenPoint() moves in lockstep with this window, so a stationary mouse reports
// a moving cursor. Together they walked the dot off the screen under a still mouse.

export function beginDotDrag(pointer: DotPosition): void {
  if (!dotWindow) return
  // The renderer snaps the pill shut on press, so the hit rectangle follows it back down.
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
  // Any pill slide is folded into the anchor on the first real move rather than at the
  // press, so the window does not jump and a stray click does not untuck a tucked dot.
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

/** Tray rescue for a dot that has ended up somewhere unreachable. */
export function resetDotPosition(): void {
  if (!dotWindow) return
  moveDotTo(defaultDotPosition())
  dotWindow.showInactive()
  persistDotPosition()
  log('dot position reset')
}

// ------------------------------------------------------------- search bar + panel

/** The search bar sits 11px above the panel; both move as one unit anchored to the dot. */
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

/** Where a surface of this size opens next to the dot: whichever side has room, vertically
 *  centred, clamped into the work area. Measured from the visible circle, not the padded
 *  dot window, or the gap would silently include DOT_SLACK. */
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

/** The panel hugs its list rather than being a fixed slab — the renderer measures its own
 *  content and reports it here, bounded between one row and ~8 before it scrolls. */
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

/** Push-to-talk reports on the search bar, so a hold that began with the panel shut has to
 *  bring it back up. Already-open is the common case and costs nothing. */
export function showPanelForVoice(): void {
  if (panelWindow?.isVisible()) return
  showPanel()
}

function showPanel(): void {
  const startedAt = performance.now()
  if (!panelWindow || !searchWindow) return
  // The search bar is about to draw whatever the pill was saying.
  sendToDot(IDLE)
  clearQuery()
  applyPairBounds()
  // The list rides along with the show event instead of being fetched back — it is
  // already in memory, so this costs one IPC hop instead of a round trip.
  panelWindow.webContents.send(IPC.panelShown, panelData())
  searchWindow.webContents.send(IPC.searchReset)
  // The panel is unfocusable, so showInactive is what it gets; the search bar takes the
  // foreground and every keystroke with it.
  panelWindow.showInactive()
  searchWindow.show()
  since('hotkey -> panel visible', startedAt)
}

/** Live updates while the panel is open. Skipped when hidden — the next show sends fresh
 *  data anyway. */
export function publishPanelData(data: PanelData): void {
  if (!panelWindow || !panelWindow.isVisible()) return
  panelWindow.webContents.send(IPC.panelChanged, data)
}

/** A microphone opened from the search bar's own button has no other end once the panel
 *  goes with it. A listener rather than a call, since voice.ts imports this file. */
let panelHiddenListener: (() => void) | null = null

export function onPanelHidden(listener: () => void): void {
  panelHiddenListener = listener
}

export function hidePanel(): void {
  const wasOpen = searchWindow?.isVisible() === true
  panelWindow?.hide()
  searchWindow?.hide()
  clearQuery()
  // Only when it was actually up — hidePanel is called defensively from several places,
  // and firing on an already-closed panel would cancel a voice session mid-flight.
  if (wasOpen) panelHiddenListener?.()
}

export function sendToPanel(channel: string, payload?: unknown): void {
  if (!panelWindow?.isVisible()) return
  panelWindow.webContents.send(channel, payload)
}

/** Voice state goes to whichever surface is on screen — the search bar while the panel is
 *  up, the dot's own pill otherwise — never both. The pill is what survives the panel
 *  being dismissed, which is every successful command. */
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

/** `speechSynthesis` is renderer-only, and the dot's renderer is the one always alive —
 *  the search bar exists only while the panel is open. */
export function speakInDot(request: SpeechRequest): void {
  dotWindow?.webContents.send(IPC.speak, request)
}

/** Sent to all three — each window is its own document with its own stylesheet, so there
 *  is nothing shared to change centrally. Each also asks once on load, for a window
 *  created after the broadcast. */
export function sendAppearance(appearance: Appearance): void {
  for (const win of [dotWindow, panelWindow, searchWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.appearance, appearance)
  }
}

/** Only the dot draws the mark, so unlike appearance this goes to one window. */
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
