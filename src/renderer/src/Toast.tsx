import { useEffect, useState } from 'react'
import type { VoiceState } from '../../shared/types'

/** The visual half of chunk E's feedback (PLAN.md §8): what was heard, and what is happening
 *  about it.
 *
 *  Its own transparent, click-through window, anchored beside the dot the way the panel is.
 *  It exists because the search bar cannot carry a confirmation: by the time a command has
 *  succeeded the panel has been dismissed and the window the user asked for is in front of
 *  them, so the surface that reports it has to outlive the panel. The two are never up
 *  together — the main process sends state to the search bar when it is visible and here when
 *  it is not, so there is one set of words on screen and only one.
 *
 *  Nothing is decided here. The main process sends one `VoiceState` and this draws it. */
function Toast(): React.JSX.Element | null {
  /** The last state worth drawing. Kept through the exit animation, so the card fades out
   *  showing what it said rather than emptying first. */
  const [shown, setShown] = useState<VoiceState | null>(null)
  const [leaving, setLeaving] = useState(false)
  /** Bumped on every new state, and used as the card's key so the entrance animation
   *  restarts — one message replacing another should arrive, not cross-fade in place. */
  const [seq, setSeq] = useState(0)

  useEffect(() => {
    return window.ezzy.onVoiceState((state) => {
      if (state.kind === 'idle') {
        setLeaving(true)
        return
      }
      setLeaving(false)
      setShown(state)
      setSeq((n) => n + 1)
    })
  }, [])

  if (!shown) return null
  const message = statusText(shown)
  if (message === null) return null

  return (
    <div className="toast">
      <div
        key={seq}
        className={`toast__card toast__card--${shown.kind}${leaving ? ' is-leaving' : ''}`}
      >
        <span className="toast__glyph" aria-hidden="true">
          <Glyph kind={shown.kind} />
        </span>
        <span className="toast__lines">
          {/* What was heard, above what is being done about it. Quoted and dimmed because it
              is a transcript and not a sentence Ezzy is saying — when whisper mangles a name
              this line is the only thing that explains the answer underneath it. */}
          {heardText(shown) && <span className="toast__heard">“{heardText(shown)}”</span>}
          <span className="toast__message">{message}</span>
        </span>
        <span className="toast__sheen" aria-hidden="true" />
      </div>
    </div>
  )
}

/** The transcript, when there is one. */
function heardText(state: VoiceState): string | null {
  if (state.kind === 'done') return state.heard
  if (state.kind === 'error') return state.heard ?? null
  return null
}

/** The same words the search bar uses for the states it shares, so the surface swapping out
 *  from under a message does not change its wording. */
function statusText(state: VoiceState): string | null {
  switch (state.kind) {
    case 'downloading':
      return `Downloading the speech model… ${state.percent}%`
    case 'listening':
      return 'Listening…'
    case 'thinking':
      return 'One moment…'
    case 'done':
      return state.message
    case 'error':
      return state.message
    default:
      return null
  }
}

/** 20px, currentColor — the card tints it by state. */
function Glyph({ kind }: { kind: VoiceState['kind'] }): React.JSX.Element {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 } as const
  switch (kind) {
    case 'done':
      return (
        <svg viewBox="0 0 20 20">
          <path d="M4.5 10.4 8.3 14.2 15.5 6.4" {...stroke} strokeLinecap="round" />
        </svg>
      )
    case 'error':
      return (
        <svg viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="7.2" {...stroke} />
          <path d="M10 6.2v5" {...stroke} strokeLinecap="round" />
          <circle cx="10" cy="13.9" r="0.95" fill="currentColor" />
        </svg>
      )
    case 'downloading':
      return (
        <svg viewBox="0 0 20 20">
          <path d="M10 3.5v9" {...stroke} strokeLinecap="round" />
          <path d="M6.2 9 10 12.8 13.8 9" {...stroke} strokeLinecap="round" />
          <path d="M4.5 15.5h11" {...stroke} strokeLinecap="round" />
        </svg>
      )
    case 'thinking':
      // Three dots rather than a ring: this is a wait of a few hundred milliseconds, and a
      // spinner at that length reads as something having gone wrong.
      return (
        <svg viewBox="0 0 20 20" className="toast__dots">
          <circle cx="4.6" cy="10" r="1.5" fill="currentColor" />
          <circle cx="10" cy="10" r="1.5" fill="currentColor" />
          <circle cx="15.4" cy="10" r="1.5" fill="currentColor" />
        </svg>
      )
    default:
      // Listening — the same mark the search bar shows, so the microphone looks like one
      // thing wherever it appears.
      return (
        <svg viewBox="0 0 20 20">
          <rect x="7.4" y="2.8" width="5.2" height="9.4" rx="2.6" {...stroke} />
          <path d="M4.8 9.2a5.2 5.2 0 0 0 10.4 0" {...stroke} strokeLinecap="round" />
          <path d="M10 14.4v2.8" {...stroke} strokeLinecap="round" />
        </svg>
      )
  }
}

export default Toast
