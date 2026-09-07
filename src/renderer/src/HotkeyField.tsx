import { useEffect, useState } from 'react'
import { DEFAULT_CONFIG } from '../../shared/types'

interface Props {
  /** What the config asks for. */
  hotkey: string
  /** What Windows actually gave us, which is not always the same. */
  active: string | null
  error: string | null
  onChange: (hotkey: string) => void
}

/** The hotkey recorder.
 *
 *  The hotkey has to be configurable from day one — Alt+Space is the Windows system
 *  menu and every launcher on the machine wants it — and until this window existed the only
 *  way to change it was to hand-edit config.json.
 *
 *  Recording rather than a dropdown: nobody knows the Electron accelerator string for the key
 *  they have in mind, and everybody can press it. The one rule enforced here is that a
 *  shortcut needs a modifier, because a bare key registered globally would be swallowed
 *  system-wide — you would lose the letter B everywhere on the machine. */
function HotkeyField({ hotkey, active, error, onChange }: Props): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent): void => {
      // While recording, this field owns the keyboard: nothing else in the window should see
      // the keys, and Escape must not reach the window-level handler that closes it.
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
    // Capture, so the recorder sees the key before the window's own Escape handler does.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, onChange])

  const message = warning ?? error
  const fallenBack = active !== null && active !== hotkey

  // The control only. The row around it — its name and its description — belongs to the
  // settings list, which declares every setting as data so the search can filter them; a
  // component that drew its own row would be findable on its page and invisible to the search.
  return (
    <>
      {recording && (
        <span className="settings__hint">Press the keys you want, or Escape to cancel.</span>
      )}
      {/* Alt+Space cannot be recorded: it is the Windows system menu, so pressing it over
          a framed window opens that menu and the field only ever sees the Space. Which would
          leave the default unreachable for anyone who changed away from it — hence a button
          rather than a keystroke. */}
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
      {/* Not an error: Ezzy still has a hotkey, it is just not the one on file. Shown every
          time the window opens, because the fallback happens at startup and the balloon that
          announced it is long gone by the time anyone comes looking. */}
      {!message && fallenBack && (
        <p className="settings__error">{`In use by another app — Ezzy is on ${active} for now.`}</p>
      )}
    </>
  )
}

function hasModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
}

/** A KeyboardEvent as an Electron accelerator, or null while only modifiers are down.
 *
 *  Built from `event.code` rather than `event.key`: `key` is what the layout produced, so
 *  Alt+Shift+3 arrives as "#" on some keyboards and as "3" on others, and the accelerator has
 *  to name the physical key that will be registered. */
function toAccelerator(event: KeyboardEvent): string | null {
  const key = mainKey(event.code, event.key)
  if (key === null) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  // Electron's name for the Windows key. Rare as a launcher shortcut — Windows claims most
  // Win+letter combinations for itself — but it costs one line to accept.
  if (event.metaKey) parts.push('Super')
  parts.push(key)
  return parts.join('+')
}

/** Named keys Electron accepts, keyed by `KeyboardEvent.code`. Deliberately the same shape as
 *  the table in main/hotkey.ts, which has to turn the accelerator back into a virtual-key code
 *  for push-to-talk — anything missing from that table still works as a hotkey and just does
 *  not listen when held. */
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
  // Modifiers on their own are not a shortcut yet — the user is still holding them down on
  // the way to one.
  if (/^(Control|Alt|Shift|Meta)/.test(code) || key === 'Dead') return null
  // Keyboards this file has never seen: take whatever the layout produced, if it is a single
  // character. Anything else is refused rather than guessed at.
  return key.length === 1 ? key.toUpperCase() : null
}

export default HotkeyField
