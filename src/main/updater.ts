/** Auto-update against GitHub Releases.
 *
 *  Is the reason this is in v1 rather than v2: "expect three embarrassing bugs in the first
 *  48 hours after posting". Ezzy ships unsigned through Scoop and a raw installer, so there is
 *  no store to push a fix through — without this, a bug that gets past release stays on every
 *  machine that downloaded it.
 *
 *  Downloads happen in the background and install on the next quit, which for a tray app that
 *  is meant to be permanent is usually the next reboot. The settings window offers to restart
 *  now; nothing here ever restarts the app on its own, because Ezzy is furniture and furniture
 *  does not disappear mid-sentence. */

import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { sep } from 'path'
import { UpdateStatus } from '../shared/types'
import { log } from './verbose'
import { setQuitting } from './windows'

/** Long enough that the window list, the app index and the tray are all up first — an update
 *  check is the least urgent thing Ezzy does at startup: the first panel owns the
 *  startup budget, and this must not spend any of it. */
const FIRST_CHECK_MS = 10_000
/** Ezzy is running whenever Windows is, so a session can last weeks. */
const INTERVAL_MS = 6 * 60 * 60 * 1000

let status: UpdateStatus = { kind: 'idle' }
let listeners: Array<(status: UpdateStatus) => void> = []
let timer: ReturnType<typeof setInterval> | null = null

export function updateStatus(): UpdateStatus {
  return status
}

/** The settings window and the tray both draw this, and either can be gone at any moment —
 *  the tray menu is rebuilt on every change and the window may never have been opened. */
export function onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
  listeners.push(listener)
  return () => void (listeners = listeners.filter((other) => other !== listener))
}

function setStatus(next: UpdateStatus): void {
  status = next
  for (const listener of listeners) listener(next)
}

export function startUpdater(): void {
  if (!supported()) return
  // Straight to the file: `console` is teed there (see logger.ts), and electron-updater is
  // chatty enough to be worth having when an update does not arrive.
  //
  // Its `error` channel is deliberately NOT wired to `onError`. Measured against a real feed:
  // electron-updater logs "Cannot download differentially, fallback to full download" at error
  // level, which is not a failure at all — it is the delta path giving up because the OLD
  // version's blockmap is not on the feed, and the full download then succeeds. Routing that
  // to the status put "Update check failed" in the settings window and the tray while the
  // update was downloading normally behind it. Only the `error` EVENT below is a real failure.
  autoUpdater.logger = { info: log, warn: log, error: log, debug: log }
  // Without this an unpackaged build refuses to check at all, and EZZY_DEV_UPDATES could not
  // be used to test the feed before cutting a release.
  autoUpdater.forceDevUpdateConfig = !app.isPackaged
  autoUpdater.autoDownload = true
  // The install itself waits for a quit rather than interrupting one. Combined with the tray's
  // Quit — which is the only way out of Ezzy — this means updates land when the user has
  // decided to stop using it, which is the only moment it is not in the way.
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => setStatus({ kind: 'checking' }))
  autoUpdater.on('update-not-available', () => {
    setStatus({ kind: 'current', version: app.getVersion() })
  })
  autoUpdater.on('update-available', (info) => {
    setStatus({ kind: 'available', version: info.version })
  })
  autoUpdater.on('download-progress', (progress) => {
    const version = 'version' in status ? status.version : app.getVersion()
    setStatus({ kind: 'downloading', version, percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => setStatus({ kind: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => onError(err.message))

  setTimeout(() => {
    check()
    timer = setInterval(check, INTERVAL_MS)
  }, FIRST_CHECK_MS)
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** The settings window's button. Also the answer to "did it work?" — the plan says to test an actual
 *  update rather than assume, and this is what makes that testable without waiting six hours. */
export function checkForUpdates(): void {
  if (!supported()) return
  check()
}

function check(): void {
  autoUpdater.checkForUpdates().catch((err: Error) => onError(err.message))
}

/** Restart into the update the user has already downloaded.
 *
 *  `setQuitting` first, for the same reason the tray's Quit does it: every window intercepts
 *  its own `close` and hides to the tray instead, so without this the app would
 *  refuse to go and the installer would never run. */
export function installUpdate(): void {
  if (status.kind !== 'ready') return
  log('installing update and restarting')
  setQuitting(true)
  autoUpdater.quitAndInstall()
}

function onError(message: string): void {
  console.error(`[ezzy] update check failed: ${message}`)
  // Deliberately not a dialog and not a balloon. An update that cannot be reached is the
  // machine's problem far more often than ours — an offline laptop, a corporate proxy — and
  // interrupting someone about it every six hours would be its own bug. It sits in the
  // settings window and the log for whoever goes looking.
  setStatus({ kind: 'error', message })
}

/** In dev there is no installed app to replace, and electron-updater throws rather than
 *  no-ops. The settings window says as much instead of showing a button that cannot work.
 *
 *  `dev-app-update.yml` in the repo root is what lets this be tested without packaging: set
 *  EZZY_DEV_UPDATES=1 and electron-updater reads its feed from there. */
function supported(): boolean {
  // A Scoop install is a portable zip unpacked into scoop/apps/ezzy/<version>, and the only
  // thing electron-updater can install on Windows is the NSIS installer — which would put a
  // SECOND Ezzy in %LOCALAPPDATA% and leave Scoop pointing at the old one. Scoop updates
  // itself, from the same GitHub release, through the manifest's checkver.
  if (installedWithScoop()) {
    setStatus({ kind: 'unsupported', reason: 'Installed with Scoop — run: scoop update ezzy' })
    return false
  }
  if (app.isPackaged || process.env['EZZY_DEV_UPDATES'] === '1') return true
  setStatus({ kind: 'unsupported', reason: 'Updates are only checked in an installed build' })
  return false
}

function installedWithScoop(): boolean {
  return app.getPath('exe').toLowerCase().includes(`${sep}scoop${sep}apps${sep}`)
}
