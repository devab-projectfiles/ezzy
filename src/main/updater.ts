import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { sep } from 'path'
import { UpdateStatus } from '../shared/types'
import { log } from './verbose'
import { setQuitting } from './windows'

const FIRST_CHECK_MS = 10_000
const INTERVAL_MS = 6 * 60 * 60 * 1000
const ERROR_SHOWN_MS = 12_000

let status: UpdateStatus = { kind: 'idle' }
let listeners: Array<(status: UpdateStatus) => void> = []
let timer: ReturnType<typeof setInterval> | null = null
let clearErrorTimer: ReturnType<typeof setTimeout> | null = null
// Only a check someone asked for reports a failure; the background ones fail silently.
let manualCheck = false

export function updateStatus(): UpdateStatus {
  return status
}

export function onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
  listeners.push(listener)
  return () => void (listeners = listeners.filter((other) => other !== listener))
}

function setStatus(next: UpdateStatus): void {
  if (clearErrorTimer) clearTimeout(clearErrorTimer)
  clearErrorTimer = null
  status = next
  for (const listener of listeners) listener(next)
}

export function startUpdater(): void {
  if (!supported()) return
  // Not wired to onError: electron-updater logs a delta-download fallback at error level
  // even when the full download succeeds right after.
  autoUpdater.logger = { info: log, warn: log, error: log, debug: log }
  autoUpdater.forceDevUpdateConfig = !app.isPackaged
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-not-available', () => {
    manualCheck = false
    setStatus({ kind: 'current', version: app.getVersion() })
  })
  autoUpdater.on('update-available', (info) => {
    manualCheck = false
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

export function checkForUpdates(): void {
  if (!supported()) return
  if (status.kind === 'available' || status.kind === 'downloading' || status.kind === 'ready') {
    return
  }
  manualCheck = true
  setStatus({ kind: 'checking' })
  check()
}

// A failed check both emits 'error' and rejects; the event is the one that reports it.
function check(): void {
  autoUpdater.checkForUpdates().catch(() => {})
}

// setQuitting first, same as the tray's Quit — every window intercepts its own `close` and
// hides to the tray otherwise, so the installer would never run.
export function installUpdate(): void {
  if (status.kind !== 'ready') return
  log('installing update and restarting')
  setQuitting(true)
  autoUpdater.quitAndInstall()
}

function onError(raw: string): void {
  console.error(`[ezzy] update check failed: ${raw.replace(/\s+/g, ' ').slice(0, 300)}`)
  const wasManual = manualCheck
  manualCheck = false
  if (!wasManual) {
    if (
      status.kind === 'checking' ||
      status.kind === 'available' ||
      status.kind === 'downloading'
    ) {
      setStatus({ kind: 'idle' })
    }
    return
  }
  setStatus({ kind: 'error', message: describeFailure(raw) })
  clearErrorTimer = setTimeout(() => setStatus({ kind: 'idle' }), ERROR_SHOWN_MS)
}

// electron-updater's message is the whole HTTP exchange, headers and all — fine for the log,
// unreadable in a settings row.
function describeFailure(raw: string): string {
  if (/\b404\b|releases\.atom|latest\.yml|No published versions/i.test(raw)) {
    return 'No updates have been published yet'
  }
  if (
    /ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i.test(raw)
  ) {
    return 'Couldn’t reach the update server — check your connection'
  }
  return 'Couldn’t check for updates right now'
}

function supported(): boolean {
  // A Scoop install is a portable zip; electron-updater on Windows can only install the NSIS
  // installer, which would put a second Ezzy in %LOCALAPPDATA%. Scoop updates itself instead.
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
