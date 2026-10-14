import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  DOT_VISUAL,
  PILL_VISUAL,
  STATUS_VISUAL,
  type BuiltInLogo,
  type DotMark,
  type PillDirection,
  type VoiceState
} from '../../shared/types'
import cards from '../assets/dot.svg?raw'
import orbit from '../assets/dots/orbit.svg?raw'
import cluster from '../assets/dots/cluster.svg?raw'
import panels from '../assets/dots/panels.svg?raw'
import { initSpeech, speak } from './speech'

const DRAG_THRESHOLD = 4

// A choice of 'custom' with nothing saved falls back to the default rather than an empty circle.
function glyphFor(mark: DotMark): string {
  if (mark.markup !== null) return mark.markup
  return GLYPHS[mark.logo as BuiltInLogo] ?? GLYPHS.cards
}

// Inlined rather than loaded as files so the dot can tint them with `currentColor`.
const GLYPHS: Record<BuiltInLogo, string> = { cards, orbit, cluster, panels }

function Dot(): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [instant, setInstant] = useState(false)
  const [side, setSide] = useState<PillDirection>('left')
  const [hotkey, setHotkey] = useState('')
  const [pillWidth, setPillWidth] = useState(PILL_VISUAL)
  const [voice, setVoice] = useState<VoiceState>({ kind: 'idle' })
  const [mark, setMark] = useState<DotMark>({ logo: 'cards', markup: null })

  const contentRef = useRef<HTMLSpanElement>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  // Set when a drag ends: the cursor is still on the pill, and reopening under it isn't a
  // hover the user asked for.
  const suppressed = useRef(false)

  useEffect(() => {
    const stopWatchingVoices = initSpeech()
    const stopListening = window.ezzy.onSpeak(speak)
    return () => {
      stopWatchingVoices()
      stopListening()
    }
  }, [])

  useEffect(() => {
    return window.ezzy.onVoiceState(setVoice)
  }, [])

  useEffect(() => {
    window.ezzy.getHotkey().then((accelerator) => setHotkey(accelerator.split('+').join(' + ')))
  }, [])

  useEffect(() => {
    window.ezzy.getPillSide().then(setSide)
    return window.ezzy.onPillSide(setSide)
  }, [])

  useEffect(() => {
    void window.ezzy.getDotLogo().then(setMark)
    return window.ezzy.onDotLogo(setMark)
  }, [])

  const status = statusFor(voice)
  const expanded = hovered || status !== null
  // Pulled out as strings: `status` is a fresh object every render, and depending on it would
  // re-measure on every pointer move of a drag.
  const message = status?.message ?? null
  const heard = status?.heard ?? null

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const cap = message === null ? PILL_VISUAL : STATUS_VISUAL
    const width = Math.min(DOT_VISUAL + content.offsetWidth, cap)
    setPillWidth(width)
    window.ezzy.setPillWidth(width)
  }, [hotkey, message, heard])

  // Hover comes from the main process: the window is click-through while idle so its
  // mostly-empty rectangle doesn't swallow clicks.
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

  useEffect(() => {
    if (!instant) return
    const id = setTimeout(() => setInstant(false), 0)
    return () => clearTimeout(id)
  }, [instant])

  // Screen coordinates come from here, not the main process: as the window moves under a
  // still cursor, screenX stays put where a main-process cursor read would not.
  const finish = (event: React.PointerEvent<HTMLButtonElement>, released = false): void => {
    if (!origin.current) return
    const wasDrag = moved.current
    origin.current = null
    moved.current = false
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    window.ezzy.endDotDrag()
    suppressed.current = true
    // A press and release that never became a drag; main decides whether that opens the panel.
    if (released && !wasDrag) window.ezzy.clickDot()
  }

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
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
    // A pointerup that never arrives would leave the dot dragging forever, so live button
    // state is treated as ground truth.
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
        onPointerUp={(event) => finish(event, true)}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      >
        {status ? (
          <span className="pill__glyph pill__glyph--state">
            <StateGlyph kind={voice.kind} />
          </span>
        ) : (
          <span className="pill__glyph" dangerouslySetInnerHTML={{ __html: glyphFor(mark) }} />
        )}

        {status ? (
          <span className="pill__status" ref={contentRef}>
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

function statusFor(voice: VoiceState): { message: string; heard: string | null } | null {
  switch (voice.kind) {
    case 'downloading':
      return { message: `Downloading speech… ${voice.percent}%`, heard: null }
    // Not "Listening…": the microphone is still opening.
    case 'arming':
      return { message: 'Getting ready…', heard: null }
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
    case 'arming':
      return (
        <svg viewBox="0 0 20 20" className="pill__dots pill__dots--arming">
          <circle cx="4.6" cy="10" r="1.5" fill="currentColor" />
          <circle cx="10" cy="10" r="1.5" fill="currentColor" />
          <circle cx="15.4" cy="10" r="1.5" fill="currentColor" />
        </svg>
      )
    case 'thinking':
      return (
        <svg viewBox="0 0 20 20" className="pill__dots">
          <circle cx="4.6" cy="10" r="1.5" fill="currentColor" />
          <circle cx="10" cy="10" r="1.5" fill="currentColor" />
          <circle cx="15.4" cy="10" r="1.5" fill="currentColor" />
        </svg>
      )
    default:
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
