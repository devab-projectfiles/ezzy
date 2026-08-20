import { useRef, useState } from 'react'

/** Pointer travel below this is a click with a shaky hand, not a drag. */
const DRAG_THRESHOLD = 4

function Dot(): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    origin.current = { x: event.screenX, y: event.screenY }
    moved.current = false
    setDragging(true)
    window.ezy.startDotDrag()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const start = origin.current
    if (!start) return
    if (!moved.current) {
      const travel = Math.abs(event.screenX - start.x) + Math.abs(event.screenY - start.y)
      if (travel < DRAG_THRESHOLD) return
      moved.current = true
    }
    window.ezy.moveDotDrag()
  }

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!origin.current) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    origin.current = null
    setDragging(false)
    window.ezy.endDotDrag()
    if (!moved.current) window.ezy.clickDot()
  }

  return (
    <button
      type="button"
      aria-label="Ezy"
      className={dragging ? 'dot dot--dragging' : 'dot'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className="dot__glyph" />
    </button>
  )
}

export default Dot
