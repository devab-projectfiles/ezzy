import { useEffect, useRef, useState } from 'react'

/** §6's search bar: its own 420x54 glass window, fully rounded, 11px above the panel.
 *
 *  It is the only one of the three windows that takes focus (see windows.ts), which makes it
 *  the app's keyboard. The text goes to the main process, where the matching happens; the
 *  navigation keys are forwarded to the panel, which is unfocusable and so never sees a key
 *  event of its own. Nothing about the result list is known here.
 *
 *  The mic is still inert — push-to-talk and the listening pulse are chunk D. */
function SearchBar(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return window.ezzy.onSearchReset(() => {
      // Only the field is cleared here: the main process drops the query itself when the
      // panel opens or closes, so telling it again would just re-publish the same list.
      setQuery('')
      // The window has just been shown and focused; the input inside it has to be told
      // separately, and it has to happen after React has committed the cleared value or the
      // caret lands after text that is about to disappear.
      requestAnimationFrame(() => inputRef.current?.focus())
    })
  }, [])

  // Autofocus for the very first open, which happens before any reset event is sent.
  useEffect(() => inputRef.current?.focus(), [])

  return (
    <div className="searchbar" onMouseDown={keepFocus}>
      <SearchGlyph />
      <input
        ref={inputRef}
        className="searchbar__input"
        type="text"
        value={query}
        placeholder="Search or say a command"
        // The field is thrown away and rebuilt by the OS on every open; none of the
        // browser's text conveniences belong on a launcher input.
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value)
          window.ezzy.setQuery(event.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      <MicGlyph />
      <span className="searchbar__sheen" aria-hidden="true" />
    </div>
  )

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'Escape':
        window.ezzy.closePanel()
        return
      case 'ArrowDown':
        // Otherwise the caret jumps to the end of the text on the way past.
        event.preventDefault()
        window.ezzy.navigate('down')
        return
      case 'ArrowUp':
        event.preventDefault()
        window.ezzy.navigate('up')
        return
      case 'Enter':
        event.preventDefault()
        window.ezzy.navigate('enter')
        return
      default:
    }
  }

  /** Clicking the glass around the input must not move focus off it — the pill is where the
   *  keyboard lives while the panel is open, and a click landing on the padding would
   *  otherwise leave the arrow keys going nowhere. */
  function keepFocus(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target === inputRef.current) return
    event.preventDefault()
    inputRef.current?.focus()
  }
}

/** 18px, 72% white (§6). */
function SearchGlyph(): React.JSX.Element {
  return (
    <svg className="searchbar__search" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="7.75" cy="7.75" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M11.6 11.6 15.5 15.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** 19px, 92% white (§6). While listening it is the rim that pulses, not this glyph — but
 *  that is chunk D's job, so nothing animates yet. */
function MicGlyph(): React.JSX.Element {
  return (
    <svg className="searchbar__mic" viewBox="0 0 19 19" aria-hidden="true">
      <rect
        x="7"
        y="2.5"
        width="5"
        height="9"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M4.5 8.75a5 5 0 0 0 10 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M9.5 13.75v2.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export default SearchBar
