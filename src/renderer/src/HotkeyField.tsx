import { useEffect, useState } from 'react'
import { DEFAULT_CONFIG } from '../../shared/types'

interface Props {
  hotkey: string
  active: string | null
  error: string | null
  onChange: (hotkey: string) => void
}

function HotkeyField({ hotkey, active, error, onChange }: Props): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        return
      }
      const accelerator = toAccelerator(event)
      if (accelerator === null) return
      if (!hasModifier(event)) {
        setWarning('A shortcut needs Ctrl, Alt or Shift — a bare key would be swallowed globally.')
        return
      }
      setWarning(null)
      setRecording(false)
      onChange(accelerator)
    }
    // Capture: the recorder sees the key before the window's own Escape handler does.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, onChange])

  const message = warning ?? error
  const fallenBack = active !== null && active !== hotkey

  return (
    <>
      {recording && (
        <span className="settings__hint">Press the keys you want, or Escape to cancel.</span>
      )}
      {/* Alt+Space can't be recorded — it's the Windows system menu — so a reset button
          reaches it instead. */}
      {hotkey !== DEFAULT_CONFIG.hotkey && (
        <button
          type="button"
          className="settings__reset"
          onClick={() => {
            setRecording(false)
            setWarning(null)
            onChange(DEFAULT_CONFIG.hotkey)
          }}
        >
          Reset
        </button>
      )}
      <button
        type="button"
        className={`settings__hotkey${recording ? ' is-recording' : ''}`}
        onClick={() => {
          setWarning(null)
          setRecording((was) => !was)
        }}
        onBlur={() => setRecording(false)}
      >
        {recording ? 'Press a shortcut…' : hotkey}
      </button>
      {message && <p className="settings__error">{message}</p>}
      {!message && fallenBack && (
        <p className="settings__error">{`In use by another app — Ezzy is on ${active} for now.`}</p>
      )}
    </>
  )
}

function hasModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
}

// Built from `event.code`, not `event.key`: `key` is layout-produced, so Alt+Shift+3 arrives
// as "#" on some keyboards and "3" on others, but the accelerator needs the physical key.
function toAccelerator(event: KeyboardEvent): string | null {
  const key = mainKey(event.code, event.key)
  if (key === null) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')
  parts.push(key)
  return parts.join('+')
}

const NAMED_CODES: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  CapsLock: 'CapsLock',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/'
}

function mainKey(code: string, key: string): string | null {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  const named = NAMED_CODES[code]
  if (named) return named
  if (/^(Control|Alt|Shift|Meta)/.test(code) || key === 'Dead') return null
  return key.length === 1 ? key.toUpperCase() : null
}

export default HotkeyField
