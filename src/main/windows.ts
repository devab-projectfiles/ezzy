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
  VoiceState
} from '../shared/types'
import { getConfig, updateConfig } from './config'
import { log, since } from './verbose'
import { clearQuery, panelData } from './panel-data'

let dotWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
/** §6's second glass surface: the 420x54 pill above the panel. */
let searchWindow: BrowserWindow | null = null
let quitting = false
let drag: DragState | null = null
/** The panel's current height. It hugs its content, so the renderer drives this. */
let panelHeight = PANEL_MIN_HEIGHT

/** Where the collapsed glass circle sits, expressed as the top-left of the square window
 *  it would occupy on its own. This is the single source of truth for the dot's position:
 *  the real window is wider than that square and its `x` depends on which way the pill
 *  opens, so reading the live rectangle back would drift the dot by the pill's width. */
let dotAnchor: DotPosition = { x: 0, y: 0 }
let pillSide: PillDirection = 'left'
/** Whether the cursor is currently over the pill. Owned here rather than in the renderer:
 *  the window is click-through when idle, and a click-through window is never sent mouse
 *  events at all — `setIgnoreMouseEvents(.., { forward: true })` delivers nothing to a
 *  `focusable: false` window, measured. So the main process watches the cursor instead. */
let hovered = false
/** Whether the pill is actually drawn open. It tracks `hovered` except after a press, which
 *  snaps the pill shut while the cursor is still on it — the hit rectangle has to shrink
 *  with it, or the window keeps claiming mouse input over space it no longer paints. */
let pillOpen = false
let hoverTimer: ReturnType<typeof setInterval> | null = null
/** The pill's opened width, measured from its own content by the renderer. */
let pillWidth = PILL_VISUAL

/** The sizes Windows actually granted, captured once at creation.
 *
 *  setPosition() re-applies the window's current size internally, and reading that size
 *  back at a fractional scale factor returns a larger value than was set — 1.3625 here.
 *  Every move therefore grew the window: measured, one drag took the dot from 82x82 to
 *  201x199 physical pixels. A transparent, always-on-top window that has quietly grown to
 *  cover much of the desktop still receives mouse input across its whole rectangle, so it
 *  swallows the clicks meant for every app underneath it. Passing a fixed size on every
 *  move is what stops that, which is why nothing below ever reads a size back. */
let pillFrame = { width: PILL_WINDOW, height: DOT_WINDOW }
/** The collapsed circle's square footprint — the window's height on both axes. Used for
 *  clamping and for anchoring the panel, neither of which cares about the pill's reach. */
let dotFrame = { width: DOT_WINDOW, height: DOT_WINDOW }
/** How much wider the window is than that square, i.e. how far the pill can open. */
let pillDelta = PILL_DELTA

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

/** Cursor sampling rate for hover. One GetCursorPos per tick costs far less than the
 *  alternative: a pill-wide window that swallows every click aimed underneath it. */
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
    // DWM rounds a frameless window's own rectangle at the system radius, and on a
    // transparent window that rounded rectangle composites as an opaque dark plate behind
    // the page. Our radius is 24-28px and the system's is ~8px, so it showed up as a black
    // near-rectangle sticking out behind the glass. We draw every corner in CSS, so DWM has
    // nothing useful to add here.
    roundedCorners: false,
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
  const granted = dotWindow.getBounds()
  pillFrame = { width: granted.width, height: granted.height }
  dotFrame = { width: granted.height, height: granted.height }
  pillDelta = granted.width - granted.height
  // Click-through until the cursor is actually over the pill. Without this the window's
  // full pill-width rectangle would eat clicks meant for whatever sits underneath it.
  dotWindow.setIgnoreMouseEvents(true)
  applyAlwaysPresent(dotWindow)
  clampDotIntoBounds()
  applyDotBounds()
  dotWindow.once('ready-to-show', () => dotWindow?.showInactive())
  loadRenderer(dotWindow, 'dot')

  // §6, "Three windows, not one". The search bar and the panel are separate windows so the
  // 11px gap between them shows the desktop rather than a seam. They move as one unit.
  searchWindow = createGlassWindow(SEARCH_HEIGHT)
  panelWindow = createGlassWindow(PANEL_MIN_HEIGHT)

  // The search bar holds the text input, so it is the one window of the three that takes
  // focus. The panel is unfocusable instead: it still receives clicks — WS_EX_NOACTIVATE
  // suppresses activation, not mouse input — so clicking a row cannot pull focus out of the
  // input mid-word, and every key the user presses lands in the field they are looking at.
  // The arrow keys and Enter reach the list by being forwarded (IPC.panelNav).
  panelWindow.setFocusable(false)

  searchWindow.on('blur', () => {
    if (searchWindow?.webContents.isDevToolsOpened()) return
    if (panelWindow?.webContents.isDevToolsOpened()) return
    hidePanel()
  })

  loadRenderer(searchWindow, 'searchbar')
  loadRenderer(panelWindow, 'panel')
}

/** One of the two glass surfaces. Both are the same window underneath — only their height
 *  and contents differ.
 *
 *  `transparent: true`, not §6's acrylic. Acrylic does blur the desktop, which nothing else
 *  on Windows can, but it frosts the surface into a milky slab and it follows the Windows
 *  theme, neither of which is the look this is aiming at. The cost is that there is no blur,
 *  so what shows through the glass shows through sharp.
 *
 *  It also buys back real CSS corner radii, which are anti-aliased, where acrylic needed a
 *  window region that was not. */
function createGlassWindow(height: number): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // The OS shadow is drawn around the window's square, not around the rounded surface
    // inside it, so it reads as a grey box behind the glass.
    hasShadow: false,
    // Same reason as the dot: DWM's own rounded rectangle composites as an opaque dark
    // plate behind a transparent window, at the system radius rather than ours.
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

/** The only web permission Ezzy has any use for is the microphone, and only because chunk D's
 *  push-to-talk records in a renderer. Electron's default handler is more permissive than that,
 *  so everything else is refused here rather than left to the default — these windows load our
 *  own pages and nothing they contain should be asking.
 *
 *  The check handler is the synchronous half: `getUserMedia` consults it before it ever raises
 *  a request, and a renderer on `file://` is not automatically trusted with it. */
function applyPermissionPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    if (permission !== 'media') log(`refused a "${permission}" permission request`)
    callback(permission === 'media')
  })
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission) => permission === 'media'
  )
}

function webPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}

function loadRenderer(win: BrowserWindow, page: 'dot' | 'searchbar' | 'panel'): void {
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

function moveDotTo(position: DotPosition): void {
  dotAnchor = position
  applyDotBounds()
}

/** The one place the dot window is positioned. Its size never changes, so this is always a
 *  pure move — which is the entire point: resizing a transparent window on Windows
 *  re-creates its composited surface and flashes.
 *
 *  §6: the pill opens leftward, so the window carries its spare width on the left and the
 *  circle rides at the right edge. A dot parked against the left of a display has no room
 *  for that, so it mirrors: spare width on the right, circle at the left edge. */
function applyDotBounds(): void {
  if (!dotWindow) return
  const display = screen.getDisplayMatching(dotBoundsAt(dotAnchor))
  const opensLeft = dotAnchor.x - pillDelta >= display.bounds.x
  dotWindow.setBounds({
    x: opensLeft ? dotAnchor.x - pillDelta : dotAnchor.x,
    y: dotAnchor.y,
    ...pillFrame
  })
  const side: PillDirection = opensLeft ? 'left' : 'right'
  if (side === pillSide) return
  pillSide = side
  dotWindow.webContents.send(IPC.pillSide, side)
  log(`pill now opens ${side === 'left' ? 'leftward' : 'rightward'}`)
}

export function currentPillSide(): PillDirection {
  return pillSide
}

/** The renderer measures the pill against its own text and reports the result, so the
 *  hover rectangle below matches what is actually drawn. */
export function setPillWidth(width: number): void {
  pillWidth = Math.max(DOT_VISUAL, Math.min(Math.round(width), PILL_VISUAL))
}

/** The pill's rectangle in screen coordinates. It grows once hovered, which gives the hover
 *  test its hysteresis for free: the cursor has to reach the circle to open the pill, but
 *  may then roam anywhere over the opened pill without closing it. */
function pillScreenRect(): Electron.Rectangle {
  const inset = visualInset()
  const circleX = dotAnchor.x + inset
  const width = pillOpen ? pillWidth : DOT_VISUAL
  return {
    x: pillSide === 'left' ? circleX + DOT_VISUAL - width : circleX,
    y: dotAnchor.y + inset,
    width,
    height: DOT_VISUAL
  }
}

/** Reading the cursor is only self-referential while the window is being moved under it,
 *  which is why this stands down for the duration of a drag (see the note below). */
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

/** The transparent margin between the collapsed square and the glass circle drawn inside
 *  it — see DOT_SLACK. Derived from the granted frame rather than the constant, because
 *  Windows rarely grants exactly the size it was asked for. */
function visualInset(): number {
  return Math.round((dotFrame.width - DOT_VISUAL) / 2)
}

/** How much of the dot may be tucked past a display edge. Because the slack is uniform,
 *  half the collapsed square is exactly the slack plus half the glass circle — so allowing
 *  half of it past an edge leaves precisely half the visible dot on screen, which is what
 *  §6 describes. Tray > Reset dot position brings it fully back. */
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

/** §6: the search bar sits 11px above the panel and the two move as one unit, anchored to
 *  the dot and clamped on-screen near edges. This lays the pair out together so the gap
 *  between them is fixed no matter where the dot is parked.
 *
 *  Anchored to the visible circle rather than the padded dot window, or the gap would
 *  silently include DOT_SLACK and read as too wide. */
function layoutPair(): { search: Electron.Rectangle; panel: Electron.Rectangle } {
  const inset = visualInset()
  const dot = {
    x: dotAnchor.x + inset,
    y: dotAnchor.y + inset,
    width: DOT_VISUAL,
    height: DOT_VISUAL
  }
  const area = screen.getDisplayMatching(dotBoundsAt(dotAnchor)).workArea
  const totalHeight = SEARCH_HEIGHT + SEARCH_PANEL_GAP + panelHeight

  // Open away from the dot, and flip to its other side when there is no room.
  let x = dot.x + dot.width + PANEL_GAP
  if (x + PANEL_WIDTH > area.x + area.width) x = dot.x - PANEL_WIDTH - PANEL_GAP
  x = Math.min(Math.max(x, area.x + PANEL_GAP), area.x + area.width - PANEL_WIDTH - PANEL_GAP)

  // Centre the whole pair on the dot, then clamp the pair — not each window — so the 11px
  // gap survives being pushed against the top or bottom of the work area.
  let y = dot.y + dot.height / 2 - totalHeight / 2
  y = Math.min(Math.max(y, area.y + PANEL_GAP), area.y + area.height - totalHeight - PANEL_GAP)

  const left = Math.round(x)
  const top = Math.round(y)
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

/** Move both surfaces together. */
function applyPairBounds(): void {
  if (!searchWindow || !panelWindow) return
  const { search, panel } = layoutPair()
  searchWindow.setBounds(search)
  panelWindow.setBounds(panel)
}

/** §6: the panel hugs its list rather than being a fixed slab, so the renderer measures its
 *  own content and reports it here. Bounded at both ends — one row minimum, ~8 rows before
 *  it starts scrolling instead of growing. */
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

/** Push-to-talk reports itself on the search bar, so a hold that began with the panel shut —
 *  or that shut it, since the press toggles before the hold is recognised — has to bring it
 *  back up. Already-open is the common case and costs nothing. */
export function showPanelForVoice(): void {
  if (panelWindow?.isVisible()) return
  showPanel()
}

function showPanel(): void {
  const startedAt = performance.now()
  if (!panelWindow || !searchWindow) return
  // A previous session's query must not survive into this open — the input is about to be
  // cleared, and the results have to be cleared with it or the panel flashes the old ones.
  clearQuery()
  applyPairBounds()
  // The list rides along with the show event rather than being fetched back by the renderer.
  // It is already in memory, so this costs one IPC hop instead of a round trip (§7).
  panelWindow.webContents.send(IPC.panelShown, panelData())
  searchWindow.webContents.send(IPC.searchReset)
  // The panel is unfocusable, so showInactive is what it gets; the search bar takes the
  // foreground and with it every keystroke.
  panelWindow.showInactive()
  searchWindow.show()
  since('hotkey -> panel visible', startedAt)
}

/** Live updates while the panel is open — a window opening, closing or being renamed behind
 *  it, or the app index finishing its scan. Skipped when hidden: the next show sends fresh
 *  data anyway. */
export function publishPanelData(data: PanelData): void {
  if (!panelWindow || !panelWindow.isVisible()) return
  panelWindow.webContents.send(IPC.panelChanged, data)
}

export function hidePanel(): void {
  panelWindow?.hide()
  searchWindow?.hide()
  // So the next open starts on the full list rather than on whatever was last typed.
  clearQuery()
}

/** Send one message to the panel window. The search bar is where the typing happens, so
 *  everything the panel needs to hear about it arrives second-hand through here. */
export function sendToPanel(channel: string, payload?: unknown): void {
  if (!panelWindow?.isVisible()) return
  panelWindow.webContents.send(channel, payload)
}

/** Voice state goes to the search bar, which is where §6 puts the mic glyph and the listening
 *  pulse. Skipped while it is hidden — it asks for the current state when it comes back up,
 *  so a download that finishes behind a closed panel is not lost. */
export function sendVoiceState(state: VoiceState): void {
  if (!searchWindow?.isVisible()) return
  searchWindow.webContents.send(IPC.voiceState, state)
}

/** Recording runs in the dot's renderer: it is the only window that is always alive, and
 *  `getUserMedia` is a web API with no main-process equivalent. */
export function startCapture(): void {
  dotWindow?.webContents.send(IPC.voiceCapture, true)
}

export function stopCapture(): void {
  dotWindow?.webContents.send(IPC.voiceCapture, false)
}

export function showDot(): void {
  if (!dotWindow) return
  clampDotIntoBounds()
  dotWindow.showInactive()
}
