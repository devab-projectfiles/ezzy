import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EMPTY_PANEL_DATA, PANEL_HEADROOM } from '../../shared/types'
import type { DirectTarget, EzzyApp, EzzyWindow, PanelData } from '../../shared/types'

type Row =
  | { kind: 'direct'; key: string; direct: DirectTarget }
  | { kind: 'window'; key: string; window: EzzyWindow }
  | { kind: 'app'; key: string; app: EzzyApp }

const DEFAULT_SELECTION = 0

function Panel(): React.JSX.Element {
  const [data, setData] = useState<PanelData>(EMPTY_PANEL_DATA)
  // null means nothing is selected: the state left after a scroll moves the rows out from
  // under a stationary cursor.
  const [selected, setSelected] = useState<number | null>(0)
  const [openCount, setOpenCount] = useState(0)

  // Pointer selection drops when the pointer leaves the row (scrolling, mouse exit);
  // keyboard selection persists until the keys move it.
  const selectionSource = useRef<'pointer' | 'keyboard'>('keyboard')

  const surfaceRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])

  const rows = toRows(data)

  useEffect(() => {
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
          if (next.query !== previous.query)
            return next.windows.length + next.apps.length === 0 && !next.direct
              ? null
              : DEFAULT_SELECTION
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
      if (row.kind === 'window') window.ezzy.focusWindow(row.window.id)
      else if (row.kind === 'app') window.ezzy.launchApp(row.app.id)
      else window.ezzy.openDirect()
    },
    [rows]
  )

  // This window is deliberately unfocusable, so navigation keys arrive forwarded over IPC.
  useEffect(() => {
    return window.ezzy.onNavigate((key) => {
      switch (key) {
        case 'down':
          selectionSource.current = 'keyboard'
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
          if (selected !== null) activate(selected)
          return
        default:
      }
    })
  }, [rows, selected, activate])

  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (surface) window.ezzy.setPanelHeight(surface.scrollHeight + PANEL_HEADROOM)
  }, [data])

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
    <div className="panel" key={openCount} onMouseLeave={dropPointerSelection}>
      <div className="panel__surface" ref={surfaceRef}>
        {directRows.length > 0 && (
          <div className="panel__direct" onMouseLeave={dropPointerSelection}>
            {renderRows(directRows, 0)}
          </div>
        )}
        <p className="panel__section">OPEN WINDOWS</p>

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
          <button
            type="button"
            className="panel__gear"
            title="Settings"
            aria-label="Settings"
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

  function dropPointerSelection(): void {
    if (selectionSource.current === 'pointer') setSelected(null)
  }

  // On `wheel` rather than `scroll`: `scrollIntoView` also fires `scroll` when the arrow
  // keys walk past a section's edge, and clearing on that would wipe a selection they just set.
  function dropStaleHover(event: React.WheelEvent<HTMLDivElement>): void {
    const section = event.currentTarget
    if (section.scrollHeight > section.clientHeight) dropPointerSelection()
  }

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
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              style={{ animationDelay: `${Math.min(index, 10) * 18}ms` }}
              // mousemove, not mouseenter: scrolling the list under a stationary cursor
              // fires enter events and would yank the selection away.
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

/** Lucide's `settings` gear (lucide.dev, ISC), verbatim. */
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

function toRows(data: PanelData): Row[] {
  const rows: Row[] = []
  if (data.direct) rows.push({ kind: 'direct', key: `d${data.direct.label}`, direct: data.direct })
  for (const window of data.windows) rows.push({ kind: 'window', key: `w${window.id}`, window })
  for (const app of data.apps) rows.push({ kind: 'app', key: `a${app.id}`, app })
  return rows
}

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
