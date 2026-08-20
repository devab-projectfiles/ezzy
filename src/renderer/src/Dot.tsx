import { useRef, useState } from 'react'

/** Pointer travel below this is a click with a shaky hand, not a drag. */
const DRAG_THRESHOLD = 4

function Dot(): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)

  // Screen coordinates are reported from here rather than read in the main process: as the
  // window moves under a still cursor, clientX and screenLeft shift by equal and opposite
  // amounts, so screenX stays put where a main-process cursor read does not.
  const finish = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!origin.current) return
    const wasDrag = moved.current
    origin.current = null
    moved.current = false
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    window.ezzy.endDotDrag()
    if (!wasDrag) window.ezzy.clickDot()
  }

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
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

  return (
    <button
      type="button"
      aria-label="Ezzy"
      className={dragging ? 'dot dot--dragging' : 'dot'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    >
      <span className="dot__glyph" />
    </button>
  )
}

export default Dot
