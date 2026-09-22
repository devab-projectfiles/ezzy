import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { sep } from 'path'
import { UpdateStatus } from '../shared/types'
import { log } from './verbose'
import { setQuitting } from './windows'

const FIRST_CHECK_MS = 10_000
const INTERVAL_MS = 6 * 60 * 60 * 1000

let status: UpdateStatus = { kind: 'idle' }
let listeners: Array<(status: UpdateStatus) => void> = []
let timer: ReturnType<typeof setInterval> | null = null

export function updateStatus(): UpdateStatus {
  return status
}

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
  // Not wired to onError: electron-updater logs a delta-download fallback at error level
  // even when the full download succeeds right after.
  autoUpdater.logger = { info: log, warn: log, error: log, debug: log }
  autoUpdater.forceDevUpdateConfig = !app.isPackaged
  autoUpdater.autoDownload = true
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

export function checkForUpdates(): void {
  if (!supported()) return
  check()
}

function check(): void {
  autoUpdater.checkForUpdates().catch((err: Error) => onError(err.message))
}

// setQuitting first, same as the tray's Quit — every window intercepts its own `close` and
// hides to the tray otherwise, so the installer would never run.
export function installUpdate(): void {
  if (status.kind !== 'ready') return
  log('installing update and restarting')
  setQuitting(true)
  autoUpdater.quitAndInstall()
}

function onError(message: string): void {
  console.error(`[ezzy] update check failed: ${message}`)
  setStatus({ kind: 'error', message })
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
