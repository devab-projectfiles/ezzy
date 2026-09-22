import { useEffect, useRef, useState } from 'react'
import type { VoiceState } from '../../shared/types'

function SearchBar(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [voice, setVoice] = useState<VoiceState>({ kind: 'idle' })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return window.ezzy.onSearchReset(() => {
      setQuery('')
      // Runs after React commits the cleared value, or the caret lands after text about
      // to disappear.
      requestAnimationFrame(() => inputRef.current?.focus())
    })
  }, [])

  useEffect(() => inputRef.current?.focus(), [])

  // A hidden window (most of a model download) is not sent state changes, so this asks for
  // the current one every time it comes back up.
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
        placeholder={status ?? 'Search or say a command'}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value)
          window.ezzy.setQuery(event.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      {blocked && (
        <button type="button" className="searchbar__action" onClick={window.ezzy.openMicSettings}>
          Settings
        </button>
      )}
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

  // Runs on mousedown, before the click, so preventing the default keeps focus in the input
  // while a button's own onClick still fires.
  function keepFocus(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target === inputRef.current) return
    event.preventDefault()
    inputRef.current?.focus()
  }
}

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
