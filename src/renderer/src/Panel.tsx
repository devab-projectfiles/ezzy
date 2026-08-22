import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EzzyApp, EzzyWindow, PanelData } from '../../shared/types'

/** Geometry for the sliding selection highlight. §6: slide it between rows, never
 *  cross-fade — measured from the real rows rather than assumed, so a section header or a
 *  divider can never desynchronise it from what is drawn. */
interface Highlight {
  top: number
  height: number
}

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
  const [selected, setSelected] = useState(0)
  /** Bumped on every open. Used as a key so the entrance animations replay — the panel is
   *  hidden and shown, never destroyed, so its DOM would otherwise persist between opens. */
  const [openCount, setOpenCount] = useState(0)
  const [highlight, setHighlight] = useState<Highlight | null>(null)

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
          setSelected((index) => (rows.length === 0 ? 0 : (index + 1) % rows.length))
          return
        case 'ArrowUp':
          event.preventDefault()
          setSelected((index) => (rows.length === 0 ? 0 : (index - 1 + rows.length) % rows.length))
          return
        case 'Enter':
          event.preventDefault()
          activate(selected)
          return
        default:
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [rows, selected, activate])

  // §6: the panel hugs its content. Measured after layout so the window resizes in the same
  // frame the rows appear, rather than snapping a beat later.
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (surface) window.ezzy.setPanelHeight(surface.scrollHeight)
  }, [data])

  // Measure after layout, not after paint, so the highlight never renders a frame behind.
  useLayoutEffect(() => {
    const row = rowRefs.current[selected]
    if (!row) {
      setHighlight(null)
      return
    }
    setHighlight({ top: row.offsetTop, height: row.offsetHeight })
    row.scrollIntoView({ block: 'nearest' })
  }, [selected, data, openCount])

  const windowCount = data.windows.length

  return (
    <div className="panel" key={openCount}>
      <div className="panel__surface" ref={surfaceRef}>
        {rows.length === 0 ? (
          <p className="panel__empty">No open windows</p>
        ) : (
          <>
            {highlight && (
              <span
                className="panel__highlight"
                aria-hidden="true"
                style={{ transform: `translateY(${highlight.top}px)`, height: highlight.height }}
              />
            )}
            {windowCount > 0 && <p className="panel__section">OPEN WINDOWS</p>}
            {rows.map((row, index) => (
              <Fragment key={row.key}>
                {/* §6's divider, drawn where the sections meet rather than inside either. */}
                {index === windowCount && windowCount > 0 && (
                  <span className="panel__divider" aria-hidden="true" />
                )}
                {index === windowCount && <p className="panel__section">APPS</p>}
                <button
                  type="button"
                  ref={(node) => {
                    rowRefs.current[index] = node
                  }}
                  className={`panel__row${index === selected ? ' is-selected' : ''}`}
                  // 18ms stagger (§6). Capped so a long list does not take a second to
                  // finish arriving.
                  style={{ animationDelay: `${Math.min(index, 10) * 18}ms` }}
                  // mousemove, not mouseenter: scrolling the list under a stationary cursor
                  // fires enter events and would yank the selection away from the arrow keys.
                  onMouseMove={() => setSelected(index)}
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
              </Fragment>
            ))}
          </>
        )}
      </div>
      <span className="panel__sheen" aria-hidden="true" />
    </div>
  )
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
