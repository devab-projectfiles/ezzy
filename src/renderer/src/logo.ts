// The dot draws its mark with `dangerouslySetInnerHTML` on a window carrying the preload
// bridge, and an SVG can carry `<script>`, event handlers, `<use href="http…">`. The rule
// below is a whitelist, not a blacklist — a tag or attribute nobody thought of fails closed.
const ALLOWED_TAGS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'defs',
  'clippath',
  'title',
  'desc'
])

// Notably absent: every `on*`, `href`/`xlink:href`, and `style` — style can carry `url(...)`.
const ALLOWED_ATTRS = new Set([
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'width',
  'height',
  'points',
  'transform',
  'viewbox',
  'preserveaspectratio',
  'fill',
  'fill-rule',
  'fill-opacity',
  'clip-rule',
  'clip-path',
  'opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-opacity',
  'id'
])

export type CleanedLogo = { kind: 'ok'; markup: string } | { kind: 'problem'; message: string }

export function cleanLogo(raw: string): CleanedLogo {
  const parsed = new DOMParser().parseFromString(raw, 'image/svg+xml')
  if (parsed.querySelector('parsererror') !== null) {
    return { kind: 'problem', message: 'That file is not valid SVG.' }
  }
  const svg = parsed.documentElement
  if (svg.tagName.toLowerCase() !== 'svg') {
    return { kind: 'problem', message: 'That file is not an SVG image.' }
  }
  if (parsed.querySelector('image') !== null) {
    return {
      kind: 'problem',
      message:
        'That SVG is a photo in a wrapper, not a drawing. The dot needs real shapes, so it can be tinted and stay sharp at 32px.'
    }
  }

  scrub(svg)
  if (svg.querySelector('path, circle, ellipse, rect, line, polyline, polygon') === null) {
    return { kind: 'problem', message: 'There are no shapes in that file to draw.' }
  }

  // getBBox needs the document in the page, so it goes in hidden and comes straight back out.
  svg.setAttribute('width', '256')
  svg.setAttribute('height', '256')
  const stage = document.createElement('div')
  stage.setAttribute('aria-hidden', 'true')
  stage.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:256px;height:256px'
  stage.appendChild(svg)
  document.body.appendChild(stage)
  let box: DOMRect
  try {
    box = (svg as unknown as SVGGraphicsElement).getBBox()
  } finally {
    document.body.removeChild(stage)
  }
  if (box.width === 0 || box.height === 0) {
    return { kind: 'problem', message: 'That mark has no visible shapes in it.' }
  }

  // Padding beyond the ink: an <svg> clips to its own viewport, so a shape fitted exactly
  // loses its half-covered boundary pixels.
  const pad = Math.max(box.width, box.height) * 0.02
  const r = (v: number): number => Math.round(v * 1000) / 1000
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  svg.setAttribute(
    'viewBox',
    `${r(box.x - pad)} ${r(box.y - pad)} ${r(box.width + pad * 2)} ${r(box.height + pad * 2)}`
  )
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.setAttribute('overflow', 'visible')
  return { kind: 'ok', markup: new XMLSerializer().serializeToString(svg) }
}

// Children are walked from a copied list because removing an element mutates the live
// collection underneath the loop.
function scrub(element: Element): void {
  for (const child of Array.from(element.children)) {
    if (!ALLOWED_TAGS.has(child.tagName.toLowerCase())) {
      child.remove()
      continue
    }
    scrub(child)
  }
  for (const attr of Array.from(element.attributes)) {
    const name = attr.name.toLowerCase()
    if (name === 'xmlns') continue
    if (!ALLOWED_ATTRS.has(name)) {
      element.removeAttribute(attr.name)
      continue
    }
    // `none` is a real instruction (how a shape becomes a hole) and survives; everything else
    // becomes the dot's own ink.
    if ((name === 'fill' || name === 'stroke') && attr.value.trim().toLowerCase() !== 'none') {
      element.setAttribute(attr.name, 'currentColor')
    }
  }
  const tag = element.tagName.toLowerCase()
  if (tag !== 'svg' && tag !== 'g' && tag !== 'defs' && !element.hasAttribute('fill')) {
    element.setAttribute('fill', 'currentColor')
  }
}
