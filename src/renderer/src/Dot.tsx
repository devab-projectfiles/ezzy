import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DOT_VISUAL, PILL_VISUAL, type PillDirection } from '../../shared/types'
import glyph from '../assets/dot.svg?raw'
import { initSpeech, speak } from './speech'

/** Pointer travel below this is a click with a shaky hand, not a drag. */
const DRAG_THRESHOLD = 4

function Dot(): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const [expanded, setExpanded] = useState(false)
  /** Suppresses the width transition, so a press can snap the pill shut with no animation. */
  const [instant, setInstant] = useState(false)
  const [side, setSide] = useState<PillDirection>('left')
  const [hotkey, setHotkey] = useState('')
  const [pillWidth, setPillWidth] = useState(PILL_VISUAL)

  const labelRef = useRef<HTMLSpanElement>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  /** Set when a drag ends. The cursor is still on the pill then, and reopening under it is
   *  not a hover the user asked for — so the pill stays shut until the cursor leaves. */
  const suppressed = useRef(false)

  // §5: `speechSynthesis` is renderer-only, and this is the renderer that never goes away —
  // a confirmation almost always arrives just after the panel has been dismissed. Nothing
  // about it is decided here; main/speech.ts sends the finished sentence.
  useEffect(() => {
    initSpeech()
    return window.ezzy.onSpeak(speak)
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

  // Open to exactly the content's width rather than a fixed 212px, so there is no dead space
  // after the shortcut chip. Capped so the pill can never outgrow its window.
  useLayoutEffect(() => {
    const label = labelRef.current
    if (!label) return
    const width = Math.min(DOT_VISUAL + label.offsetWidth, PILL_VISUAL)
    setPillWidth(width)
    // The main process hit-tests the cursor against this same rectangle.
    window.ezzy.setPillWidth(width)
  }, [hotkey])

  // Hover comes from the main process: the window is click-through while idle so that its
  // mostly-empty rectangle does not swallow clicks, and a click-through window is never
  // sent mouse events of its own.
  useEffect(() => {
    return window.ezzy.onDotHover((isHovered) => {
      if (isHovered) {
        if (!suppressed.current) setExpanded(true)
        return
      }
      suppressed.current = false
      setExpanded(false)
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
    setExpanded(false)
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
        {/* dot.svg is the single source of truth for the mark; its three card ids are what
            dot.css animates, and fill="currentColor" is what inverts it in light mode. */}
        <span className="pill__glyph" dangerouslySetInnerHTML={{ __html: glyph }} />
        <span className="pill__label" ref={labelRef}>
          <span className="pill__name">Ezzy</span>
          {hotkey && <span className="pill__chip">{hotkey}</span>}
        </span>
        <span className="pill__sheen" aria-hidden="true" />
      </button>
    </div>
  )
}

export default Dot
