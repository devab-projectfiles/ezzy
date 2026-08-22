import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PANEL_HEADROOM } from '../../shared/types'
import type { EzzyApp, EzzyWindow, PanelData } from '../../shared/types'

/** One selectable thing, flattened across both sections so the arrow keys walk a single
 *  list. The section headers are drawn from this, rather than the other way round. */
type Row =
  { kind: 'window'; key: string; window: EzzyWindow } | { kind: 'app'; key: string; app: EzzyApp }

const EMPTY: PanelData = { windows: [], apps: [] }

/** §6 keeps the panel a switcher, not a directory. Until chunk C's fuzzy search can narrow
 *  the index, showing every installed app would turn the scroll into a phone book. */
const APPS_SHOWN = 8

function Panel(): React.JSX.Element {
  const [data, setData] = useState<PanelData>(EMPTY)
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
      setSelected(defaultSelection(next))
    })
  }, [])

  useEffect(() => {
    return window.ezzy.onPanelShown((next) => {
      setData(next)
      selectionSource.current = 'keyboard'
      setSelected(defaultSelection(next))
      setOpenCount((count) => count + 1)
    })
  }, [])

  useEffect(() => {
    return window.ezzy.onPanelChanged((next) => {
      setData((previous) => {
        // Keep the selection on the row the user was pointing at. A title change or an
        // unrelated app launching must not move it out from under them mid-keystroke.
        setSelected((index) => {
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
      else window.ezzy.launchApp(row.app.id)
    },
    [rows]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      switch (event.key) {
        case 'Escape':
          window.ezzy.closePanel()
          return
        case 'ArrowDown':
          event.preventDefault()
          selectionSource.current = 'keyboard'
          // From nothing, the first Down lands on the first row rather than the second.
          setSelected((index) =>
            rows.length === 0 ? null : index === null ? 0 : (index + 1) % rows.length
          )
          return
        case 'ArrowUp':
          event.preventDefault()
          selectionSource.current = 'keyboard'
          setSelected((index) =>
            rows.length === 0
              ? null
              : index === null
                ? rows.length - 1
                : (index - 1 + rows.length) % rows.length
          )
          return
        case 'Enter':
          event.preventDefault()
          // Nothing selected means nothing to activate. Firing the last hovered row here
          // would switch to something the user can no longer see highlighted.
          if (selected !== null) activate(selected)
          return
        default:
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [rows, selected, activate])

  // The panel is a fixed size now: both sections have a fixed row count, so this measures the
  // same number every time and the window stops changing height as the list changes. That is
  // a deliberate move away from §6's "hugs its content" — it is what keeps the APPS section
  // pinned in place instead of sliding up whenever a window closes. Still measured rather than
  // hardcoded so the arithmetic stays in the stylesheet and cannot drift from it.
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

  const windowCount = data.windows.length
  const windowRows = rows.slice(0, windowCount)
  const appRows = rows.slice(windowCount)

  return (
    // The pointer leaving the panel entirely is the other way a hover goes stale, and it is
    // not covered by the sections below — a fast exit can skip straight out of the window.
    <div className="panel" key={openCount} onMouseLeave={dropPointerSelection}>
      <div className="panel__surface" ref={surfaceRef}>
        <p className="panel__section">OPEN WINDOWS</p>
        {/* Its own scroller, sized to WINDOWS_VISIBLE rows. `overflow-y: auto` means it only
            scrolls when there are more windows than fit — with four or fewer the wheel does
            nothing here, which is what was asked for. Still native scrolling, so §1's
            two-finger scroll keeps working and there is no custom scroll handling. */}
        {/* Leaving a section for the divider or a header is still leaving every row, so the
            highlight has to go there too, not only at the edge of the panel. */}
        <div
          className="panel__scroll panel__scroll--windows"
          onWheel={dropStaleHover}
          onMouseLeave={dropPointerSelection}
        >
          {windowRows.length === 0 ? (
            <p className="panel__empty">No open windows</p>
          ) : (
            renderRows(windowRows, 0)
          )}
        </div>
        <span className="panel__divider" aria-hidden="true" />
        <p className="panel__section">APPS</p>
        <div
          className="panel__scroll panel__scroll--apps"
          onWheel={dropStaleHover}
          onMouseLeave={dropPointerSelection}
        >
          {appRows.length === 0 ? (
            <p className="panel__empty">No apps indexed</p>
          ) : (
            renderRows(appRows, windowCount)
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
   *  the arrow keys and the selection use, so the two sections stay one navigable list. */
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
              // was last clicked, independent of where the selection actually is.
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              // 18ms stagger (§6). Capped so a long list does not take a second to finish.
              style={{ animationDelay: `${Math.min(index, 10) * 18}ms` }}
              // mousemove, not mouseenter: scrolling the list under a stationary cursor fires
              // enter events and would yank the selection away from the arrow keys.
              onMouseMove={() => {
                selectionSource.current = 'pointer'
                setSelected(index)
              }}
              onClick={() => activate(index)}
            >
              {row.kind === 'window' ? <WindowGlyph /> : <AppGlyph />}
              <span className="panel__text">
                <span className="panel__row-title">
                  {row.kind === 'window' ? row.window.title : row.app.name}
                </span>
                <span className="panel__row-subtitle">
                  {row.kind === 'window' ? row.window.app : 'Not running'}
                </span>
              </span>
              <span className="panel__hint">
                {index === selected ? (
                  <span className="panel__hint-chip">↵</span>
                ) : (
                  row.kind === 'app' && <span className="panel__hint-chip">launch</span>
                )}
              </span>
            </button>
          )
        })}
      </>
    )
  }
}

/** Windows first in MRU order, then the apps that are not running (§6). */
function toRows(data: PanelData): Row[] {
  return [
    ...data.windows.map((window): Row => ({ kind: 'window', key: `w${window.id}`, window })),
    ...data.apps.slice(0, APPS_SHOWN).map((app): Row => ({ kind: 'app', key: `a${app.id}`, app }))
  ]
}

/** §7: the panel steals the foreground when it opens, so the window the user just left is
 *  always at the top of the MRU. Selecting the second row makes Enter mean "go back to the
 *  other thing", which is the Alt-Tab behaviour everyone already has in their fingers. */
function defaultSelection(data: PanelData): number {
  return data.windows.length > 1 ? 1 : 0
}

/** Stand-ins until chunk C extracts real icons from the Start Menu index. */
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

export default Panel
