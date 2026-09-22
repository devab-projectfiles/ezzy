/** The log file users attach to issues. Ezzy runs without a console — a tray app,
 *  usually started by Windows at login — so `console` is teed to a file rather than
 *  replaced: everything the app already logs lands there for free, and stdout still
 *  works when a terminal is attached.
 *
 *  Written synchronously and deliberately — a crash is exactly when the last line
 *  matters most, and an async write is the one that never gets flushed. */

import { app, shell } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

/** One rotation at half a megabyte, so the file a user attaches stays attachable and a
 *  runaway loop cannot fill a disk overnight. Two files is the whole retention policy. */
const MAX_BYTES = 512 * 1024

let path: string | null = null
let bytes = 0
/** Set while writing to the file, so an error raised by the write itself cannot recurse
 *  through the patched console back into the write. */
let writing = false

export function logFilePath(): string {
  return path ?? join(app.getPath('userData'), 'logs', 'ezzy.log')
}

/** Call before anything else in `whenReady` — what happens during startup tends to be
 *  worth reading afterwards. */
export function startLogging(): void {
  if (path) return
  path = logFilePath()
  try {
    mkdirSync(join(app.getPath('userData'), 'logs'), { recursive: true })
    bytes = statSync(path).size
  } catch {
    bytes = 0
  }
  tee('log', console.log)
  tee('warn', console.warn)
  tee('error', console.error)
  watchForCrashes()
  write('info', [`--- Ezzy ${app.getVersion()} started ${new Date().toISOString()} ---`])
}

/** Ezzy should not take itself down over an uncaught error — a tray app that vanishes
 *  is a worse bug than whatever threw. Written down instead. */
function watchForCrashes(): void {
  process.on('uncaughtException', (err) => {
    console.error('[ezzy] uncaught exception:', err.stack ?? err.message)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[ezzy] unhandled rejection:', reason)
  })
}

/** A crash in one of the renderers, reported over IPC — the error object itself cannot cross
 *  the bridge, so it arrives as the page it happened on and what it said. */
export function logRendererError(page: string, message: string): void {
  console.error(`[ezzy] renderer error in ${page}: ${message}`)
}

export async function openLogFile(): Promise<void> {
  const file = logFilePath()
  // .log has no default handler on plenty of machines, and openPath then does nothing at all.
  const error = await shell.openPath(file)
  if (error) shell.showItemInFolder(file)
}

type Level = 'info' | 'log' | 'warn' | 'error'

function tee(level: 'log' | 'warn' | 'error', original: (...args: unknown[]) => void): void {
  console[level] = (...args: unknown[]): void => {
    original(...args)
    write(level, args)
  }
}

function write(level: Level, args: unknown[]): void {
  if (!path || writing) return
  writing = true
  try {
    rotateIfFull()
    const line = `${new Date().toISOString()} [${level}] ${args.map(render).join(' ')}\n`
    appendFileSync(path, line, 'utf8')
    bytes += Buffer.byteLength(line)
  } catch {
    // A log that cannot be written is not worth crashing the app over, and reporting it
    // through console would come straight back here.
  } finally {
    writing = false
  }
}

function rotateIfFull(): void {
  if (!path || bytes < MAX_BYTES) return
  const previous = `${path}.old`
  try {
    unlinkSync(previous)
  } catch {
    // There was no previous rotation, which is the usual case.
  }
  renameSync(path, previous)
  bytes = 0
}

/** Errors are the one thing here worth spending characters on: `String(err)` on an Error
 *  gives up the stack, which is the only part of a crash report anyone can act on. */
function render(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
