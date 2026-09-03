import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EMPTY_PANEL_DATA, PANEL_HEADROOM } from '../../shared/types'
import type { DirectTarget, EzzyApp, EzzyWindow, PanelData } from '../../shared/types'

/** One selectable thing, flattened across the sections so the arrow keys walk a single
 *  list. The section headers are drawn from this, rather than the other way round. */
type Row =
  | { kind: 'direct'; key: string; direct: DirectTarget }
  | { kind: 'window'; key: string; window: EzzyWindow }
  | { kind: 'app'; key: string; app: EzzyApp }

/** The first row, which with no query is the window the user is looking at: the panel takes
 *  the foreground when it opens, so the window they came from sits at the top of the MRU.
 *  With a query it is the best match, which is the same rule.
 *
 *  This used to open on the second row instead, on the reasoning that Enter would then mean
 *  "go back to the other thing" the way Alt-Tab does. That is a real convention, but it is
 *  not what this panel is — it opens under the cursor showing a list, and starting the
 *  selection somewhere other than the top reads as the wrong row being picked rather than as
 *  a shortcut. the plan does not specify either behaviour. */
const DEFAULT_SELECTION = 0

function Panel(): React.JSX.Element {
  const [data, setData] = useState<PanelData>(EMPTY_PANEL_DATA)
  /** `null` means nothing is selected — the state the list is left in after a scroll moves
   *  the rows out from under a stationary cursor. Hover selection has to be able to say "not
   *  on anything" or it goes stale, points at a row the pointer has left, and slides away
   *  from there on the next mouse move as though the row had been clicked. */
  const [selected, setSelected] = useState<number | null>(0)
  /** Bumped on every open. Used as a key so the entrance animations replay — the panel is
   *  hidden and shown, never destroyed, so its DOM would otherwise persist between opens. */
  const [openCount, setOpenCount] = useState(0)

  /** Where the live selection came from. Pointer selection is only true while the pointer is
   *  actually on the row, so anything that breaks that — scrolling the rows out from under it,
   *  or the pointer leaving — has to drop it. Keyboard selection is deliberate and persists
   *  until the keys move it, so none of that may touch it. */
  const selectionSource = useRef<'pointer' | 'keyboard'>('keyboard')

  const surfaceRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])

  const rows = toRows(data)

  useEffect(() => {
    // The first paint happens before the panel is ever shown, so seed from the cache here;
    // every subsequent open arrives through onPanelShown below.
    window.ezzy.getPanelData().then((next) => {
      setData(next)
      setSelected(DEFAULT_SELECTION)
    })
  }, [])

  useEffect(() => {
    return window.ezzy.onPanelShown((next) => {
      setData(next)
      selectionSource.current = 'keyboard'
      setSelected(DEFAULT_SELECTION)
      setOpenCount((count) => count + 1)
    })
  }, [])

  useEffect(() => {
    return window.ezzy.onPanelChanged((next) => {
      setData((previous) => {
        setSelected((index) => {
          // A new query is a new list, and the answer to it is its first row. Trying to keep
          // the old selection across a keystroke would leave it pointing at whatever
          // happened to land in that slot.
          if (next.query !== previous.query)
            return next.windows.length + next.apps.length === 0 && !next.direct
              ? null
              : DEFAULT_SELECTION
          // Otherwise keep the selection on the row the user was pointing at. A title change
          // or an unrelated app launching must not move it out from under them mid-keystroke.
          if (index === null) return null
          const anchor = toRows(previous)[index]
          const moved = anchor ? toRows(next).findIndex((row) => row.key === anchor.key) : -1
          if (moved !== -1) return moved
          return Math.min(index, Math.max(toRows(next).length - 1, 0))
        })
        return next
      })
    })
  }, [])

  const activate = useCallback(
    (index: number) => {
      const row = rows[index]
      if (!row) return
      // If Windows refuses the switch the panel stays open, so the miss is visible rather
      // than looking like a dismissal that worked.
      if (row.kind === 'window') window.ezzy.focusWindow(row.window.id)
      else if (row.kind === 'app') window.ezzy.launchApp(row.app.id)
      else window.ezzy.openDirect()
    },
    [rows]
  )

  // The keyboard belongs to the search bar — this window is deliberately unfocusable, so it
  // receives no key events at all and the navigation keys arrive forwarded over IPC instead.
  useEffect(() => {
    return window.ezzy.onNavigate((key) => {
      switch (key) {
        case 'down':
          selectionSource.current = 'keyboard'
          // From nothing, the first Down lands on the first row rather than the second.
          setSelected((index) =>
            rows.length === 0 ? null : index === null ? 0 : (index + 1) % rows.length
          )
          return
        case 'up':
          selectionSource.current = 'keyboard'
          setSelected((index) =>
            rows.length === 0
              ? null
              : index === null
                ? rows.length - 1
                : (index - 1 + rows.length) % rows.length
          )
          return
        case 'enter':
          // Nothing selected means nothing to activate. Firing the last hovered row here
          // would switch to something the user can no longer see highlighted.
          if (selected !== null) activate(selected)
          return
        default:
      }
    })
  }, [rows, selected, activate])

  // The panel is a fixed size now: both sections have a fixed row count, so this measures the
  // same number every time and the window stops changing height as the list changes. That is
  // a deliberate move away from the "hugs its content" — it is what keeps the APPS section
  // pinned in place instead of sliding up whenever a window closes. Still measured rather than
  // hardcoded so the arithmetic stays in the stylesheet and cannot drift from it. The direct
  // row is the one thing that does change the height, since it is only there some of the time.
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    // The window is asked for PANEL_HEADROOM more than the content needs, because panel.css
    // holds the surface that far short of the window's bottom edge. Without the extra the
    // content would overflow by exactly that much and clip the last row.
    if (surface) window.ezzy.setPanelHeight(surface.scrollHeight + PANEL_HEADROOM)
  }, [data])

  // Keep the selected row in view. Nothing is measured any more: the selection is painted by
  // the row itself, so there is no overlay whose geometry could drift from what is drawn.
  useLayoutEffect(() => {
    const row = selected === null ? null : rowRefs.current[selected]
    row?.scrollIntoView({ block: 'nearest' })
  }, [selected, data, openCount])

  const searching = data.query.trim() !== ''
  const directCount = data.direct ? 1 : 0
  const directRows = rows.slice(0, directCount)
  const windowRows = rows.slice(directCount, directCount + data.windows.length)
  const appRows = rows.slice(directCount + data.windows.length)

  return (
    // The pointer leaving the panel entirely is the other way a hover goes stale, and it is
    // not covered by the sections below — a fast exit can skip straight out of the window.
    <div className="panel" key={openCount} onMouseLeave={dropPointerSelection}>
      <div className="panel__surface" ref={surfaceRef}>
        {/* A URL or an existing path the query named outright. No header: it is one row and
            it belongs to the query rather than to either list. */}
        {directRows.length > 0 && (
          <div className="panel__direct" onMouseLeave={dropPointerSelection}>
            {renderRows(directRows, 0)}
          </div>
        )}
        <p className="panel__section">OPEN WINDOWS</p>
        {/* Its own scroller, sized to WINDOWS_VISIBLE rows. `overflow-y: auto` means it only
            scrolls when there are more windows than fit — with four or fewer the wheel does
            nothing here, which is what was asked for. Still native scrolling, so the
            two-finger scroll keeps working and there is no custom scroll handling. */}
        {/* Leaving a section for the divider or a header is still leaving every row, so the
            highlight has to go there too, not only at the edge of the panel. */}
        <div
          className="panel__scroll panel__scroll--windows"
          onWheel={dropStaleHover}
          onMouseLeave={dropPointerSelection}
        >
          {windowRows.length === 0 ? (
            <p className="panel__empty">{searching ? 'No matching window' : 'No open windows'}</p>
          ) : (
            renderRows(windowRows, directCount)
          )}
        </div>
        <span className="panel__divider" aria-hidden="true" />
        <p className="panel__section">
          APPS
          {/* The only way into settings that does not need the tray. Parked on this header
              because it is the one that has spare room — OPEN WINDOWS is what the panel is
              for, and a gear beside it would sit next to the first thing the eye lands on. */}
          <button
            type="button"
            className="panel__gear"
            title="Settings"
            aria-label="Settings"
            // Outside the focus model, exactly like the rows: this window cannot take focus,
            // and a button that tried would carry the platform's own ring.
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={window.ezzy.openSettings}
          >
            <GearGlyph />
          </button>
        </p>
        <div
          className="panel__scroll panel__scroll--apps"
          onWheel={dropStaleHover}
          onMouseLeave={dropPointerSelection}
        >
          {appRows.length === 0 ? (
            <p className="panel__empty">{searching ? 'No matching app' : 'No apps indexed'}</p>
          ) : (
            renderRows(appRows, directCount + data.windows.length)
          )}
        </div>
      </div>
      <span className="panel__sheen" aria-hidden="true" />
    </div>
  )

  /** Give up a selection the pointer is no longer entitled to. A keyboard selection is left
   *  alone — arrowing to a row and then moving the mouse away must not throw that away, or
   *  Enter would do nothing. */
  function dropPointerSelection(): void {
    if (selectionSource.current === 'pointer') setSelected(null)
  }

  /** Scrolling slides the rows out from under a pointer that has not moved. Without this the
   *  highlight stays on a row the pointer has left, reads as a click-focus, and slides across
   *  the list from that stale position the next time the mouse moves.
   *
   *  On `wheel` rather than `scroll` deliberately: `scrollIntoView` scrolls the section when
   *  the arrow keys walk past its edge, and that fires `scroll` too — clearing on it would
   *  wipe the selection the arrow keys had just set. A wheel only comes from the user.
   *  Sections with nothing to scroll are left alone, since nothing moves under the pointer. */
  function dropStaleHover(event: React.WheelEvent<HTMLDivElement>): void {
    const section = event.currentTarget
    if (section.scrollHeight > section.clientHeight) dropPointerSelection()
  }

  /** Rows for one section. `offset` maps a position inside the section onto the flat index
   *  the arrow keys and the selection use, so the sections stay one navigable list. */
  function renderRows(sectionRows: Row[], offset: number): React.JSX.Element {
    return (
      <>
        {sectionRows.map((row, position) => {
          const index = offset + position
          return (
            <button
              type="button"
              key={row.key}
              ref={(node) => {
                rowRefs.current[index] = node
              }}
              className={`panel__row${index === selected ? ' is-selected' : ''}`}
              // Focus is not the selection model here — the arrow keys drive `selected`, and
              // the row paints itself from that. A row that also took DOM focus would carry
              // the platform's own focus ring, a second unfilled outline sitting on whatever
              // was last clicked. This window cannot take focus at all now, but the rule is
              // what keeps a click from trying.
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              // 18ms stagger. Capped so a long list does not take a second to finish.
              style={{ animationDelay: `${Math.min(index, 10) * 18}ms` }}
              // mousemove, not mouseenter: scrolling the list under a stationary cursor fires
              // enter events and would yank the selection away from the arrow keys.
              onMouseMove={() => {
                selectionSource.current = 'pointer'
                setSelected(index)
              }}
              onClick={() => activate(index)}
            >
              <RowIcon row={row} />
              <span className="panel__text">
                <span className="panel__row-title">{title(row)}</span>
                <span className="panel__row-subtitle">{subtitle(row)}</span>
              </span>
              <span className="panel__hint">
                {index === selected ? (
                  <span className="panel__hint-chip">↵</span>
                ) : (
                  row.kind !== 'window' && <span className="panel__hint-chip">{hint(row)}</span>
                )}
              </span>
            </button>
          )
        })}
      </>
    )
  }
}

/** Lucide's `settings` gear (lucide.dev, ISC), verbatim — the path and the 24-unit viewBox
 *  are theirs, only the stroke width is nudged, because at the 14px this renders at Lucide's
 *  own 2 comes out near one device pixel and the gear teeth wash out. Round caps and joins
 *  are what make it match the search and mic glyphs. */
function GearGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function title(row: Row): string {
  if (row.kind === 'window') return row.window.title
  if (row.kind === 'app') return row.app.name
  return row.direct.label
}

function subtitle(row: Row): string {
  if (row.kind === 'window') return row.window.app
  if (row.kind === 'app') return 'Not running'
  return row.direct.detail
}

function hint(row: Row): string {
  return row.kind === 'app' ? 'launch' : 'open'
}

/** Windows first, then the apps that are not running — in MRU and alphabetical order
 *  with no query, in match order with one. A direct hit on a URL or a path leads. */
function toRows(data: PanelData): Row[] {
  const rows: Row[] = []
  if (data.direct) rows.push({ kind: 'direct', key: `d${data.direct.label}`, direct: data.direct })
  for (const window of data.windows) rows.push({ kind: 'window', key: `w${window.id}`, window })
  for (const app of data.apps) rows.push({ kind: 'app', key: `a${app.id}`, app })
  return rows
}

/** The real icon where the shell had one to give, and the outline glyph where it did not —
 *  a Store app with no file behind it, an elevated process we cannot open, or an icon that
 *  simply has not been read yet. The glyph is the resting state, not the error state. */
function RowIcon({ row }: { row: Row }): React.JSX.Element {
  const icon =
    row.kind === 'window' ? row.window.icon : row.kind === 'app' ? row.app.icon : undefined
  if (icon) return <img className="panel__icon panel__icon--file" src={icon} alt="" />
  if (row.kind === 'window') return <WindowGlyph />
  if (row.kind === 'app') return <AppGlyph />
  return row.direct.kind === 'url' ? <LinkGlyph /> : <FileGlyph />
}

function WindowGlyph(): React.JSX.Element {
  return (
    <svg className="panel__icon" viewBox="0 0 19 19" aria-hidden="true">
      <rect
        x="2.25"
        y="3.25"
        width="14.5"
        height="12.5"
        rx="2.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path d="M2.25 7h14.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function AppGlyph(): React.JSX.Element {
  return (
    <svg className="panel__icon" viewBox="0 0 19 19" aria-hidden="true">
      <rect
        x="2.5"
        y="2.5"
        width="6"
        height="6"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="10.5"
        y="2.5"
        width="6"
        height="6"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="2.5"
        y="10.5"
        width="6"
        height="6"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="10.5"
        y="10.5"
        width="6"
        height="6"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  )
}

function LinkGlyph(): React.JSX.Element {
  return (
    <svg className="panel__icon" viewBox="0 0 19 19" aria-hidden="true">
      <circle cx="9.5" cy="9.5" r="7" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.5 9.5h14" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M9.5 2.5a11 11 0 0 1 0 14a11 11 0 0 1 0-14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  )
}

function FileGlyph(): React.JSX.Element {
  return (
    <svg className="panel__icon" viewBox="0 0 19 19" aria-hidden="true">
      <path
        d="M4.5 2.75h6l4 4v9.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-12.5a1 1 0 0 1 1-1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M10.25 2.75v4.25h4.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export default Panel
