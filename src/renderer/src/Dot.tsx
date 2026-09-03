import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  DOT_VISUAL,
  PILL_VISUAL,
  STATUS_VISUAL,
  type PillDirection,
  type VoiceState
} from '../../shared/types'
import glyph from '../assets/dot.svg?raw'
import { initSpeech, speak } from './speech'

/** Pointer travel below this is a click with a shaky hand, not a drag. */
const DRAG_THRESHOLD = 4

function Dot(): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  /** Suppresses the width transition, so a press can snap the pill shut with no animation. */
  const [instant, setInstant] = useState(false)
  const [side, setSide] = useState<PillDirection>('left')
  const [hotkey, setHotkey] = useState('')
  const [pillWidth, setPillWidth] = useState(PILL_VISUAL)
  const [voice, setVoice] = useState<VoiceState>({ kind: 'idle' })

  const contentRef = useRef<HTMLSpanElement>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  /** Set when a drag ends. The cursor is still on the pill then, and reopening under it is
   *  not a hover the user asked for — so the pill stays shut until the cursor leaves. */
  const suppressed = useRef(false)

  // `speechSynthesis` is renderer-only, and this is the renderer that never goes away —
  // a confirmation almost always arrives just after the panel has been dismissed. Nothing
  // about it is decided here; main/speech.ts sends the finished sentence.
  useEffect(() => {
    const stopWatchingVoices = initSpeech()
    const stopListening = window.ezzy.onSpeak(speak)
    return () => {
      stopWatchingVoices()
      stopListening()
    }
  }, [])

  // the plan, "the hover pill": "later the same pill carries state — a waveform while listening,
  // 'didn't catch that' on a failed command. Keep it as one reusable component."
  //
  // So chunk E's visual feedback is this, and not a card of its own. The main process only
  // sends a state here when the search bar is not up to draw it — the two never both speak.
  useEffect(() => {
    return window.ezzy.onVoiceState(setVoice)
  }, [])

  // The pill shows the hotkey actually in force, which is not always the configured one.
  useEffect(() => {
    window.ezzy.getHotkey().then((accelerator) => setHotkey(accelerator.split('+').join(' + ')))
  }, [])

  // Which window edge the circle rides on. It flips when the dot is dragged close enough to
  // the left of a display that the pill would open off-screen.
  useEffect(() => {
    window.ezzy.getPillSide().then(setSide)
    return window.ezzy.onPillSide(setSide)
  }, [])

  const status = statusFor(voice)
  /** A status holds the pill open on its own — that is the whole point of it. */
  const expanded = hovered || status !== null
  // Pulled out as strings because the effect below is keyed on them: `status` is a fresh
  // object every render, and depending on it would re-measure and re-send the width on every
  // pointer move of a drag.
  const message = status?.message ?? null
  const heard = status?.heard ?? null

  // Open to exactly the content's width rather than a fixed 212px, so there is no dead space
  // after the shortcut chip. Capped so the pill can never outgrow its window — and the cap
  // differs by content: the hover label is short and fixed, a status is a whole sentence.
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const cap = message === null ? PILL_VISUAL : STATUS_VISUAL
    const width = Math.min(DOT_VISUAL + content.offsetWidth, cap)
    setPillWidth(width)
    // The main process hit-tests the cursor against this same rectangle.
    window.ezzy.setPillWidth(width)
  }, [hotkey, message, heard])

  // Hover comes from the main process: the window is click-through while idle so that its
  // mostly-empty rectangle does not swallow clicks, and a click-through window is never
  // sent mouse events of its own.
  useEffect(() => {
    return window.ezzy.onDotHover((isHovered) => {
      if (isHovered) {
        if (!suppressed.current) setHovered(true)
        return
      }
      suppressed.current = false
      setHovered(false)
    })
  }, [])

  // Restore the transition once the snapped-shut frame has been painted.
  useEffect(() => {
    if (!instant) return
    const id = setTimeout(() => setInstant(false), 0)
    return () => clearTimeout(id)
  }, [instant])

  // Screen coordinates are reported from here rather than read in the main process: as the
  // window moves under a still cursor, clientX and screenLeft shift by equal and opposite
  // amounts, so screenX stays put where a main-process cursor read does not.
  const finish = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!origin.current) return
    origin.current = null
    moved.current = false
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    window.ezzy.endDotDrag()
    // The cursor is sitting on the pill wherever it was dropped. Reopening now would be the
    // app talking to itself, so wait for the cursor to leave and come back.
    suppressed.current = true
  }

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    // Shut instantly on press — an animated close under a double-click reads as a stutter.
    setInstant(true)
    setHovered(false)
    origin.current = { x: event.screenX, y: event.screenY }
    moved.current = false
    setDragging(true)
    window.ezzy.startDotDrag(event.screenX, event.screenY)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const start = origin.current
    if (!start) return
    // A pointerup that never arrives would otherwise leave the dot dragging forever, so
    // the live button state is treated as the ground truth.
    if (event.buttons === 0) {
      finish(event)
      return
    }
    if (!moved.current) {
      const travel = Math.abs(event.screenX - start.x) + Math.abs(event.screenY - start.y)
      if (travel < DRAG_THRESHOLD) return
      moved.current = true
    }
    window.ezzy.moveDotDrag(event.screenX, event.screenY)
  }

  const classes = ['pill']
  if (expanded) classes.push('pill--expanded')
  if (instant) classes.push('pill--instant')
  if (dragging) classes.push('pill--dragging')
  if (status) classes.push(`pill--${voice.kind}`)

  return (
    <div className={`dot-shell dot-shell--open-${side}`}>
      <button
        type="button"
        aria-label="Ezzy"
        className={classes.join(' ')}
        style={{ width: expanded ? pillWidth : DOT_VISUAL }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      >
        {/* The leading 56px is the mark's slot, and while a command is in flight it is the
            state's instead — a tick, a mic, a failure. The pill saying something is the same
            gesture as the pill showing its name, which is what keeps this one component. */}
        {status ? (
          <span className="pill__glyph pill__glyph--state">
            <StateGlyph kind={voice.kind} />
          </span>
        ) : (
          // dot.svg is the single source of truth for the mark; its three card ids are what
          // dot.css animates.
          <span className="pill__glyph" dangerouslySetInnerHTML={{ __html: glyph }} />
        )}

        {status ? (
          <span className="pill__status" ref={contentRef}>
            {/* What was heard, above what is being done about it. A mangled name is the
                commonest reason a command misses, and "I couldn't find Sigma" only makes
                sense next to the word that produced it. */}
            {heard && <span className="pill__heard">“{heard}”</span>}
            <span className="pill__message">{message}</span>
          </span>
        ) : (
          <span className="pill__label" ref={contentRef}>
            <span className="pill__name">Ezzy</span>
            {hotkey && <span className="pill__chip">{hotkey}</span>}
          </span>
        )}
        <span className="pill__sheen" aria-hidden="true" />
      </button>
    </div>
  )
}

/** What the pill should be saying, or null when it should just be the dot. */
function statusFor(voice: VoiceState): { message: string; heard: string | null } | null {
  switch (voice.kind) {
    case 'downloading':
      return { message: `Downloading speech… ${voice.percent}%`, heard: null }
    case 'listening':
      return { message: 'Listening…', heard: null }
    case 'thinking':
      return { message: 'One moment…', heard: null }
    case 'done':
      return { message: voice.message, heard: voice.heard }
    case 'error':
      return { message: voice.message, heard: voice.heard ?? null }
    default:
      return null
  }
}

/** 22px in the mark's slot, currentColor — the pill tints it by state. */
function StateGlyph({ kind }: { kind: VoiceState['kind'] }): React.JSX.Element {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 } as const
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
        <svg viewBox="0 0 20 20" className="pill__dots">
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

export default Dot
