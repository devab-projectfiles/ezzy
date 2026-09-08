/** Rasterises the two brand marks into every icon file the app and the installer need.
 *
 *  Run with `npm run make:icons`. It is Electron rather than Node because rasterising an SVG
 *  needs a renderer, and Chromium is already a dependency — adding an image library to draw
 *  five files that change about once a year is not worth the install.
 *
 *  Two marks, two jobs:
 *
 *  - `icon.svg` carries the brand gradient and goes on the dark squircle. That is the app
 *    icon: the window's title bar, the taskbar button, the Start menu entry, the installer.
 *    Windows shows one icon per app there and never swaps it for the theme, which is what
 *    the squircle is for — a solid plate that reads on a light desktop and a dark one.
 *  - `icon-mono.svg` is the same paths with `fill="currentColor"`, so it can be painted
 *    either way. That is the tray, which sits *inside* the taskbar and therefore does have
 *    to match it: a near-black mark on a light taskbar, a white one on a dark taskbar.
 *
 *  The paths are used exactly as drawn — nothing here re-traces them. What does move is the
 *  viewBox: the ink does not fill the 64x64 box it is drawn in, and centring the box is not
 *  the same as centring the mark. See inkFitted.
 */

import { app, BrowserWindow } from 'electron'
import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(ROOT, 'src', 'renderer', 'assets')

const iconSvg = readFileSync(join(ASSETS, 'icon.svg'), 'utf8')
const monoSvg = readFileSync(join(ASSETS, 'icon-mono.svg'), 'utf8')

/** The sizes Windows picks between for the exe, the title bar and the Alt-Tab card. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** The installer and the auto-updater both want one big square. */
const APP_PNG = 512
/** Rendered at twice the 16px the tray actually draws at, so a 125% or 150% display has
 *  real pixels to scale down from rather than a blurred upscale. */
const TRAY = 32

/** How much of the plate the mark fills. Enough to read at 16px without touching the
 *  rounded corners at 256. */
const MARK_ON_PLATE = 72
/** The tray mark has no plate to sit inside, so it takes almost the whole box. */
const MARK_BARE = 88

function page(size, stageCss, svg, markPercent) {
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    .stage{width:${size}px;height:${size}px;box-sizing:border-box;display:flex;
           align-items:center;justify-content:center;${stageCss}}
    .stage svg{display:block;width:${markPercent}%;height:${markPercent}%}
  </style><div class="stage">${svg}</div>`
}

/** The dark plate. The hairline rim keeps the silhouette from dissolving into a dark
 *  taskbar; it is below a pixel under 128px and simply stops being drawn there. */
function squircle(size) {
  const rim = Math.max(1, Math.round(size / 128))
  return `border-radius:23%;background:#181818;box-shadow:inset 0 0 0 ${rim}px rgba(255,255,255,0.07);`
}

let win = null
let tmpDir = ''
let counter = 0

/** Renders one page and returns its PNG bytes at exactly `size`.
 *
 *  Capture comes back at the display's scale factor, not the CSS size — 704px for a 512px
 *  window at 1.375 — so it is always resized down to the size actually asked for. Down, not
 *  up: the window is laid out at the target size and the extra pixels are free detail.
 */
async function render(size, html) {
  const file = join(tmpDir, `icon-${counter++}.html`)
  writeFileSync(file, html, 'utf8')
  win.setContentSize(size, size)
  await win.loadFile(file)
  // The first paint after a resize is not always ready the moment the load resolves, and a
  // capture taken then comes back 0x0. Ask again rather than guessing at a sleep long
  // enough for every machine.
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 120))
    const shot = await win.webContents.capturePage()
    const got = shot.getSize()
    if (got.width === 0 || got.height === 0) continue
    const exact =
      got.width === size ? shot : shot.resize({ width: size, height: size, quality: 'best' })
    return exact.toPNG()
  }
  throw new Error(`capture never painted at ${size}px`)
}

/** Returns the mark with its viewBox tightened onto the ink it actually draws.
 *
 *  The marks are drawn inside a 64x64 viewBox but do not fill it: measured, the ink sits 18
 *  units right of centre and covers 278x345 of a 512px render. Dropped straight onto a square
 *  plate that reads as a small mark pushed to one side, which is exactly what it looked like
 *  in the title bar at 16px.
 *
 *  Nothing here re-traces, re-scales or re-centres the artwork — the paths are untouched and
 *  the files on disk are not written to. Only the window onto them moves, so the renderer's
 *  own `preserveAspectRatio` does the centring and the plate gets a mark that fills it.
 *
 *  The box comes from `getBBox()` rather than from counting pixels: it is the exact geometry
 *  the renderer will use, at no resolution in particular.
 */
async function inkFitted(name, svg) {
  const file = join(tmpDir, `measure-${name}.html`)
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><body>${svg}</body>`, 'utf8')
  await win.loadFile(file)
  // Asked of the <svg>, not of the <g> inside it. getBBox reports in the element's own user
  // space, excluding that element's transform but including its descendants' — and the mark
  // carries a translate+scale on the group. Measuring the group returns its raw path space
  // (450x559 units here), which is not the space a viewBox is written in.
  const box = await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('svg').getBBox();
      return { x: b.x, y: b.y, width: b.width, height: b.height } })()`
  )
  const round = (value) => Math.round(value * 1000) / 1000
  const viewBox = `${round(box.x)} ${round(box.y)} ${round(box.width)} ${round(box.height)}`
  console.log(
    `  ${name}: ink ${round(box.width)}x${round(box.height)} at ${round(box.x)},${round(box.y)}`
  )
  return svg.replace(/viewBox="[^"]*"/, `viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet"`)
}

/** A multi-resolution .ico holding one PNG per size.
 *
 *  Windows has read PNG-compressed icon entries since Vista, so each size is simply the PNG
 *  we already rendered — no BMP encoding, no AND mask. Width and height are one byte each,
 *  and 256 does not fit in a byte: it is written as 0, which is what the format defines it
 *  to mean.
 */
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length
  entries.forEach((entry, index) => {
    const at = index * 16
    const dimension = entry.size >= 256 ? 0 : entry.size
    directory.writeUInt8(dimension, at)
    directory.writeUInt8(dimension, at + 1)
    directory.writeUInt8(0, at + 2)
    directory.writeUInt8(0, at + 3)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

function save(target, bytes) {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  console.log(`  ${target.slice(ROOT.length + 1).replace(/\\/g, '/')} — ${bytes.length} bytes`)
}

app.whenReady().then(async () => {
  tmpDir = join(app.getPath('temp'), 'ezzy-make-icons')
  mkdirSync(tmpDir, { recursive: true })

  win = new BrowserWindow({
    width: APP_PNG,
    height: APP_PNG,
    // Off-screen and never focused: this is a build step, not something to throw a window
    // in front of whoever is using the machine.
    x: -3000,
    y: -3000,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    show: false
  })
  win.showInactive()

  try {
    console.log('measuring the marks')
    const brand = await inkFitted('icon', iconSvg)
    const mono = await inkFitted('icon-mono', monoSvg)

    console.log('app icon — brand gradient on the dark squircle')
    const appPng = await render(APP_PNG, page(APP_PNG, squircle(APP_PNG), brand, MARK_ON_PLATE))
    save(join(ROOT, 'resources', 'icon.png'), appPng)
    save(join(ROOT, 'build', 'icon.png'), appPng)

    const entries = []
    for (const size of ICO_SIZES) {
      // Rendered at its own size rather than downscaled from one master: a 16px squircle
      // laid out at 16px keeps a crisp edge that a 512-to-16 reduction turns to mush.
      entries.push({
        size,
        png: await render(size, page(size, squircle(size), brand, MARK_ON_PLATE))
      })
    }
    save(join(ROOT, 'build', 'icon.ico'), encodeIco(entries))

    console.log('tray icons — the mono mark, one per taskbar theme')
    const onLight = await render(TRAY, page(TRAY, 'color:#1a1a1a;', mono, MARK_BARE))
    save(join(ROOT, 'resources', 'tray-on-light.png'), onLight)
    const onDark = await render(TRAY, page(TRAY, 'color:#ffffff;', mono, MARK_BARE))
    save(join(ROOT, 'resources', 'tray-on-dark.png'), onDark)
  } catch (error) {
    console.error(`make:icons failed — ${error.message}`)
    process.exitCode = 1
  } finally {
    win.destroy()
    app.quit()
  }
})
