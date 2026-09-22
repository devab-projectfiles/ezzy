import { useEffect, useRef, useState } from 'react'
import type { VoiceState } from '../../shared/types'

/** The search bar: its own 420x54 glass window, 11px above the panel. The only one of
 *  the three that takes focus, which makes it the app's keyboard — text goes to main for
 *  matching, navigation keys are forwarded to the unfocusable panel.
 *
 *  Also where voice reports itself. It does no recording (that is the always-alive dot
 *  window) and holds no state of its own — main sends one `VoiceState` and this draws it. */
function SearchBar(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [voice, setVoice] = useState<VoiceState>({ kind: 'idle' })
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

  // This window is hidden for most of a model download, and a hidden window is not sent state
  // changes — so it asks for the current one every time it comes back up.
  useEffect(() => {
    const refresh = (): void => void window.ezzy.getVoiceState().then(setVoice)
    refresh()
    const stopWatching = window.ezzy.onVoiceState(setVoice)
    const stopResetting = window.ezzy.onSearchReset(refresh)
    return () => {
      stopWatching()
      stopResetting()
    }
  }, [])

  const status = statusText(voice)
  const blocked = voice.kind === 'error' && voice.micBlocked

  return (
    <div
      className={`searchbar${voice.kind === 'listening' ? ' is-listening' : ''}`}
      onMouseDown={keepFocus}
    >
      <SearchGlyph />
      <input
        ref={inputRef}
        className={`searchbar__input${status ? ' is-status' : ''}`}
        type="text"
        value={query}
        // The status replaces the placeholder rather than the field: the input keeps focus and
        // keeps whatever was typed, so a voice command that misses leaves the user in a search
        // bar they can just finish typing into.
        placeholder={status ?? 'Search or say a command'}
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
      {/* A microphone Windows has blocked must lead to the setting that unblocks it. */}
      {blocked && (
        <button type="button" className="searchbar__action" onClick={window.ezzy.openMicSettings}>
          Settings
        </button>
      )}
      {/* A button, not decoration — clicking it starts listening the way holding the
          hotkey does. `keepFocus` below stops the click moving focus off the input. */}
      <button
        type="button"
        className="searchbar__mic-button"
        title={voice.kind === 'listening' ? 'Stop listening' : 'Listen'}
        aria-label={voice.kind === 'listening' ? 'Stop listening' : 'Listen'}
        aria-pressed={voice.kind === 'listening'}
        tabIndex={-1}
        onClick={window.ezzy.toggleVoice}
      >
        <MicGlyph state={voice.kind} />
      </button>
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

  /** Clicking the glass around the input must not move focus off it. Runs on mousedown,
   *  before the click, so preventing the default keeps focus in the input while the
   *  button's own `onClick` still fires — no extra handling needed on the buttons. */
  function keepFocus(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target === inputRef.current) return
    event.preventDefault()
    inputRef.current?.focus()
  }
}

/** 18px, 72% white. */
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

/** What the voice path is doing, in the words it should be read in. Null when there is
 *  nothing to say, which is most of the time. */
function statusText(voice: VoiceState): string | null {
  switch (voice.kind) {
    case 'downloading':
      return `Downloading the speech model… ${voice.percent}%`
    case 'arming':
      return 'Getting ready…'
    case 'listening':
      return 'Listening…'
    case 'thinking':
      return 'One moment…'
    case 'error':
      return voice.message
    default:
      return null
  }
}

/** 19px, 92% white. While listening it is the rim that pulses and not this glyph, so the
 *  only thing that changes here is its weight. */
function MicGlyph({ state }: { state: VoiceState['kind'] }): React.JSX.Element {
  return (
    <svg
      className={`searchbar__mic searchbar__mic--${state}`}
      viewBox="0 0 19 19"
      aria-hidden="true"
    >
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
