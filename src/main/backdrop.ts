/** Adaptive contrast (PLAN.md §6): which way each glass surface paints itself, decided from
 *  the desktop underneath it.
 *
 *  §6 deferred this to v2 and shipped dark glass unconditionally instead, on the reasoning
 *  that dark-over-anything at least stays readable. It does — but readable is not the same as
 *  right: over a white window a near-opaque dark slab reads as a hole punched in the screen
 *  rather than as glass. §6 has been reconciled to match.
 *
 *  The mechanism: read the band of desktop just OUTSIDE each surface, take the median
 *  lightness of it, and cross that against two thresholds rather than one. Nothing here reads
 *  the OS theme — a light Windows theme over a dark wallpaper is still a dark backdrop.
 *
 *  §6 describes this as sampling eight pixels in a ring, and that shape is why it was costed
 *  as a v2 item. It is the wrong shape: reading the desktop costs one vblank sync per blit
 *  and GetPixel is a blit, so eight points is eight syncs — 133ms, measured. One capture of
 *  the whole band costs one sync, 16.7ms, and the band is a far better description of the
 *  backdrop than eight points were. All the targets share that one capture, so a second
 *  surface is free.
 *
 *  No policy about *which* surfaces exist lives here. windows.ts owns the geometry and the
 *  IPC and hands them over as targets, which is what keeps this file and windows.ts from
 *  importing each other. */

import { screen } from 'electron'
import type { BackdropTheme } from '../shared/types'
import { captureScreenRegion, releaseScratch } from './win32'
import { log, since } from './verbose'

/** How wide the band around the surface is. Wide enough to describe what the surface is
 *  sitting on, narrow enough that it is still that and not the next window over. It starts
 *  one pixel out, so an anti-aliased rim pixel is never part of the reading. */
const BAND = 10

/** §6 asks for a polling loop, and this is its whole cost: one screen capture per pass, at
 *  this rate, however many surfaces are on screen. 16.7ms of blocked main thread every 700ms
 *  — the sync is unavoidable, so the lever is how often it is paid, not how much is read. */
const POLL_MS = 700

/** Every other pixel on both axes. The scan is cheap enough not to need it at panel size
 *  (0.24ms), but the band scales with the surface and this quarters it for nothing. */
const STRIDE = 2

/** The hysteresis §6 asks for, as the gap between two thresholds rather than a margin around
 *  one. A backdrop has to be convincingly light to flip the glass over and convincingly dark
 *  to flip it back; anything in the band between them leaves the surface as it is. Without
 *  that gap a mid-grey backdrop — or a video, or a scrolling page — sits on the threshold and
 *  strobes the whole UI at the poll rate. */
const TO_LIGHT = 0.66
const TO_DARK = 0.52

/** One glass surface, from the point of view of the sampler. */
export interface BackdropTarget {
  /** Identifies the target to `backdropTheme`. */
  name: string
  /** Where the surface is, in DIPs, or null when there is nothing to decide.
   *
   *  Note that this is asked for whether or not the surface is *visible*: the panel is
   *  sampled at the position it would open at, so it opens already the right way round
   *  instead of correcting itself a poll later. Every target shares one capture, so a target
   *  that is only sometimes on screen costs nothing to keep current. */
  rect(): Electron.Rectangle | null
  /** Called only when the theme actually changes, never on every pass. */
  apply(theme: BackdropTheme): void
}

interface Watched {
  target: BackdropTarget
  theme: BackdropTheme
}

interface PhysicalRect {
  x: number
  y: number
  width: number
  height: number
}

let watched: Watched[] = []
let timer: ReturnType<typeof setInterval> | null = null

/** What every surface is painted as before the first pass lands, and what it falls back to if
 *  sampling fails outright. Dark over a light desktop is merely heavy; light over a dark one
 *  is unreadable, so the safe default is this way round. */
const DEFAULT_THEME: BackdropTheme = 'dark'

export function watchBackdrops(targets: BackdropTarget[]): void {
  watched = targets.map((target) => ({ target, theme: DEFAULT_THEME }))
  timer = setInterval(pass, POLL_MS)
  // Once immediately, so a window that starts up over a white desktop is right within a frame
  // or two rather than at the end of the first interval.
  pass()
}

export function stopWatchingBackdrops(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  releaseScratch()
}

export function backdropTheme(name: string): BackdropTheme {
  return watched.find((candidate) => candidate.target.name === name)?.theme ?? DEFAULT_THEME
}

/** One capture, then every surface reads its own band out of it.
 *
 *  The capture is the union of the bands, which is why the two surfaces are not sampled
 *  separately: a second blit would double the only expensive part of this, where a bigger
 *  blit costs the same as a small one. */
function pass(): void {
  const startedAt = performance.now()
  const active: { entry: Watched; outer: PhysicalRect; inner: PhysicalRect }[] = []
  for (const entry of watched) {
    const rect = entry.target.rect()
    if (!rect) continue
    const inner = toPhysical(rect)
    const outer = toPhysical(bandBounds(rect))
    // A surface hard against a display edge has its band clipped on that side; with no band
    // left at all there is nothing to read.
    if (outer.width <= inner.width && outer.height <= inner.height) continue
    active.push({ entry, outer, inner })
  }
  if (active.length === 0) return

  const region = union(active.map((candidate) => candidate.outer))
  const capture = captureScreenRegion(region.x, region.y, region.width, region.height)
  if (!capture) return

  for (const { entry, outer, inner } of active) {
    const luma = bandMedian(capture, region, outer, inner)
    if (luma === null) continue
    const next: BackdropTheme = luma >= TO_LIGHT ? 'light' : luma <= TO_DARK ? 'dark' : entry.theme
    if (next === entry.theme) continue
    entry.theme = next
    log(`backdrop ${entry.target.name}: luma ${luma.toFixed(2)} -> ${next}`)
    entry.target.apply(next)
  }
  since(`backdrop pass (${active.length} surfaces)`, startedAt)
}

/** The surface grown by BAND on every side, clamped into its own display.
 *
 *  Clamped to the display's bounds and not the virtual screen's: a band running off the side
 *  of one monitor in a two-monitor setup is still inside the desktop rectangle, and reading it
 *  would theme this surface from what is on the other screen. */
function bandBounds(rect: Electron.Rectangle): Electron.Rectangle {
  const area = screen.getDisplayMatching(rect).bounds
  const left = Math.max(rect.x - BAND, area.x)
  const top = Math.max(rect.y - BAND, area.y)
  const right = Math.min(rect.x + rect.width + BAND, area.x + area.width)
  const bottom = Math.min(rect.y + rect.height + BAND, area.y + area.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** DIPs to physical pixels, by converting both corners rather than scaling the size: the two
 *  corners can be on displays with different scale factors, and only Electron knows where
 *  those boundaries are. */
function toPhysical(rect: Electron.Rectangle): PhysicalRect {
  const topLeft = screen.dipToScreenPoint({ x: rect.x, y: rect.y })
  const bottomRight = screen.dipToScreenPoint({
    x: rect.x + rect.width,
    y: rect.y + rect.height
  })
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(bottomRight.x - topLeft.x, 1),
    height: Math.max(bottomRight.y - topLeft.y, 1)
  }
}

function union(rects: PhysicalRect[]): PhysicalRect {
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Lightness buckets. 64 is finer than the thresholds need and costs the same as 8. */
const BUCKETS = 64

/** The median lightness of `outer` minus `inner`, or null if the band came out empty.
 *
 *  Median rather than a mean. A mean is dragged around by whatever is most extreme in the
 *  band — a black taskbar along one edge pulls a white page down toward the threshold — where
 *  the median answers the question actually being asked, which is what MOST of the backdrop
 *  is like. Taken off a histogram rather than a sort because the band can be a hundred
 *  thousand pixels and none of them need to be kept.
 *
 *  `inner` is skipped because on a visible surface it is our own glass, and feeding the
 *  material its own colour would latch it in whichever theme it happened to start in. */
function bandMedian(
  capture: { width: number; bits: Buffer },
  region: PhysicalRect,
  outer: PhysicalRect,
  inner: PhysicalRect
): number | null {
  const histogram = new Uint32Array(BUCKETS)
  let counted = 0

  const startY = outer.y - region.y
  const startX = outer.x - region.x
  for (let y = startY; y < startY + outer.height; y += STRIDE) {
    const screenY = y + region.y
    const insideRows = screenY >= inner.y && screenY < inner.y + inner.height
    for (let x = startX; x < startX + outer.width; x += STRIDE) {
      if (insideRows) {
        const screenX = x + region.x
        if (screenX >= inner.x && screenX < inner.x + inner.width) continue
      }
      const offset = (y * capture.width + x) * 4
      // BGRA. Weighted as stored rather than linearised: linearising is correct for a contrast
      // ratio and wrong here, because it puts mid-grey at 0.22 and every threshold above would
      // have to be a number that looks like it means something else. This puts mid-grey at
      // 0.50, where the thresholds read as what they are.
      const luma =
        (0.0722 * capture.bits[offset] +
          0.7152 * capture.bits[offset + 1] +
          0.2126 * capture.bits[offset + 2]) /
        255
      histogram[Math.min(Math.floor(luma * BUCKETS), BUCKETS - 1)]++
      counted++
    }
  }
  if (counted === 0) return null

  const half = counted / 2
  let running = 0
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    running += histogram[bucket]
    if (running >= half) return (bucket + 0.5) / BUCKETS
  }
  return null
}
