/** Turning a file someone chose into a mark the dot can safely wear.
 *
 *  Runs in a renderer because there is a real parser here — the main process has no DOM,
 *  so anything it did to SVG markup would be regex against a format regex cannot parse.
 *  `DOMParser` is inert: it builds a tree without running anything in it.
 *
 *  Security matters because the dot draws its mark with `dangerouslySetInnerHTML` on a
 *  window that carries the preload bridge. An SVG is a document, not a picture — it can
 *  carry `<script>`, event handlers, `<use href="http…">`, `<foreignObject>` full of
 *  HTML. `innerHTML` will not run an inserted `<script>`, but it will fire an `onload` on
 *  an `<image>`, so a downloaded file could reach `window.ezzy`. The rule below is a
 *  whitelist, not a blacklist — a tag or attribute nobody thought of fails closed.
 *
 *  The mark is also flattened to one colour: the dot tints its glyph (dims with the
 *  pill, brightens on hover), and a mark with its own fills would ignore that and sit
 *  there looking like a sticker. */

/** Shapes and the scaffolding that positions them. No `use`, no `image`, no `foreignObject`,
 *  no `style`, no animation elements: each of those either fetches something, embeds a
 *  document, or carries a handler. */
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

/** Geometry and painting only. Notably absent: every `on*`, `href`/`xlink:href`, and `style`
 *  — a style attribute can carry `url(...)`, which is a fetch. */
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

/** Strips everything that is not a shape, repaints what is left in one colour, and fits the
 *  viewBox to the ink so the mark is centred on whatever it is drawn into. */
export function cleanLogo(raw: string): CleanedLogo {
  const parsed = new DOMParser().parseFromString(raw, 'image/svg+xml')
  if (parsed.querySelector('parsererror') !== null) {
    return { kind: 'problem', message: 'That file is not valid SVG.' }
  }
  const svg = parsed.documentElement
  if (svg.tagName.toLowerCase() !== 'svg') {
    return { kind: 'problem', message: 'That file is not an SVG image.' }
  }
  // Worth its own sentence rather than being silently stripped: a traced logo is the common
  // case, and "nothing happened" would be baffling when the file plainly looks like a picture.
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

  // Measured, not guessed: the document has to be in the page for getBBox to answer, so it
  // goes in hidden, is measured, and comes straight back out.
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

  // Air beyond the ink, because an <svg> clips to its own viewport and a shape sitting on the
  // boundary loses the half-covered pixel row there — which is what flattened the tops and
  // bottoms of the built-in circles when their boxes were fitted exactly.
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

/** Depth-first, removing as it goes. Children are walked from a copied list because removing
 *  an element mutates the live collection underneath the loop. */
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
    // `xmlns` is kept so the serialised markup still parses as SVG when it is injected.
    if (name === 'xmlns') continue
    if (!ALLOWED_ATTRS.has(name)) {
      element.removeAttribute(attr.name)
      continue
    }
    // One colour, taken from the dot. `none` is a real instruction — it is how a shape is
    // made a hole — so it survives; everything else becomes the dot's own ink.
    if ((name === 'fill' || name === 'stroke') && attr.value.trim().toLowerCase() !== 'none') {
      element.setAttribute(attr.name, 'currentColor')
    }
  }
  // A shape that never said what colour it is defaults to black, which on the dot's dark
  // surface is an invisible mark rather than a missing one — harder to explain than a bug.
  const tag = element.tagName.toLowerCase()
  if (tag !== 'svg' && tag !== 'g' && tag !== 'defs' && !element.hasAttribute('fill')) {
    element.setAttribute('fill', 'currentColor')
  }
}
