import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EzzyWindow } from '../../shared/types'

/** Geometry for the sliding selection highlight. §6: slide it between rows, never
 *  cross-fade — measured from the real rows rather than assumed, so a wrapped title or a
 *  section header can never desynchronise it from what is drawn. */
interface Highlight {
  top: number
  height: number
}

function Panel(): React.JSX.Element {
  const [hotkey, setHotkey] = useState('')
  const [windows, setWindows] = useState<EzzyWindow[]>([])
  const [selected, setSelected] = useState(0)
  /** Bumped on every open. Used as a key so the entrance animations replay — the panel is
   *  hidden and shown, never destroyed, so its DOM would otherwise persist between opens. */
  const [openCount, setOpenCount] = useState(0)
  const [highlight, setHighlight] = useState<Highlight | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    window.ezzy.getHotkey().then(setHotkey)
    // The first paint happens before the panel is ever shown, so seed from the cache here;
    // every subsequent open arrives through onPanelShown below.
    window.ezzy.listWindows().then((list) => {
      setWindows(list)
      setSelected(defaultSelection(list))
    })
  }, [])

  useEffect(() => {
    return window.ezzy.onPanelShown((list) => {
      setWindows(list)
      setSelected(defaultSelection(list))
      setOpenCount((count) => count + 1)
    })
  }, [])

  useEffect(() => {
    return window.ezzy.onWindowsChanged((list) => {
      setWindows((previous) => {
        // Keep the selection on the window the user was pointing at. A title change or an
        // unrelated app launching must not move it out from under them mid-keystroke.
        setSelected((index) => {
          const anchor = previous[index]
          const moved = anchor ? list.findIndex((entry) => entry.id === anchor.id) : -1
          if (moved !== -1) return moved
          return Math.min(index, Math.max(list.length - 1, 0))
        })
        return list
      })
    })
  }, [])

  const activate = useCallback(
    (index: number) => {
      const target = windows[index]
      if (!target) return
      // If Windows refuses the switch the panel stays open, so the miss is visible rather
      // than looking like a dismissal that worked.
      window.ezzy.focusWindow(target.id)
    },
    [windows]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      switch (event.key) {
        case 'Escape':
          window.ezzy.closePanel()
          return
        case 'ArrowDown':
          event.preventDefault()
          setSelected((index) => (windows.length === 0 ? 0 : (index + 1) % windows.length))
          return
        case 'ArrowUp':
          event.preventDefault()
          setSelected((index) =>
            windows.length === 0 ? 0 : (index - 1 + windows.length) % windows.length
          )
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
  }, [windows, selected, activate])

  // Measure after layout, not after paint, so the highlight never renders a frame behind.
  useLayoutEffect(() => {
    const row = rowRefs.current[selected]
    if (!row) {
      setHighlight(null)
      return
    }
    setHighlight({ top: row.offsetTop, height: row.offsetHeight })
    row.scrollIntoView({ block: 'nearest' })
  }, [selected, windows, openCount])

  return (
    <div className="panel" key={openCount}>
      <div className="panel__search">
        <span className="panel__caret" />
        <span className="panel__placeholder">Search windows and apps…</span>
      </div>

      {windows.length === 0 ? (
        <div className="panel__empty">
          <p className="panel__title">No open windows</p>
          <p className="panel__hint">
            {hotkey && (
              <>
                <kbd>{hotkey}</kbd> toggles this panel.
                <br />
              </>
            )}
            <kbd>Esc</kbd> closes it.
          </p>
        </div>
      ) : (
        <div className="panel__list" ref={listRef}>
          <p className="panel__section">OPEN WINDOWS</p>
          {highlight && (
            <span
              className="panel__highlight"
              aria-hidden="true"
              style={{ transform: `translateY(${highlight.top}px)`, height: highlight.height }}
            />
          )}
          {windows.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              ref={(node) => {
                rowRefs.current[index] = node
              }}
              className={`panel__row${index === selected ? ' is-selected' : ''}`}
              // 18ms stagger (§6). Capped so a 40-window list does not take a second to
              // finish arriving.
              style={{ animationDelay: `${Math.min(index, 10) * 18}ms` }}
              onMouseEnter={() => setSelected(index)}
              onClick={() => activate(index)}
            >
              <WindowGlyph />
              <span className="panel__text">
                <span className="panel__row-title">{entry.title}</span>
                {entry.app && <span className="panel__row-subtitle">{entry.app}</span>}
              </span>
              <span className="panel__hint-chip">{index === selected ? '↵' : ''}</span>
            </button>
          ))}
        </div>
      )}
      <span className="panel__sheen" aria-hidden="true" />
    </div>
  )
}

/** §7: the panel steals the foreground when it opens, so the window the user just left is
 *  always at the top of the MRU. Selecting the second row makes Enter mean "go back to the
 *  other thing", which is the Alt-Tab behaviour everyone already has in their fingers. */
function defaultSelection(list: EzzyWindow[]): number {
  return list.length > 1 ? 1 : 0
}

/** A stand-in until chunk C extracts real icons from the Start Menu index. */
function WindowGlyph(): React.JSX.Element {
  return (
    <svg className="panel__icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" />
      <path d="M1.5 5.5h13" stroke="currentColor" />
    </svg>
  )
}

export default Panel
