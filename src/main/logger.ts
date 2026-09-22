// Written synchronously and deliberately: a crash is exactly when the last line matters
// most, and an async write is the one that never gets flushed.

import { app, shell } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

const MAX_BYTES = 512 * 1024

let path: string | null = null
let bytes = 0
// Set while writing so an error raised by the write itself can't recurse through the
// patched console back into the write.
let writing = false

export function logFilePath(): string {
  return path ?? join(app.getPath('userData'), 'logs', 'ezzy.log')
}

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

function watchForCrashes(): void {
  process.on('uncaughtException', (err) => {
    console.error('[ezzy] uncaught exception:', err.stack ?? err.message)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[ezzy] unhandled rejection:', reason)
  })
}

export function logRendererError(page: string, message: string): void {
  console.error(`[ezzy] renderer error in ${page}: ${message}`)
}

export async function openLogFile(): Promise<void> {
  const file = logFilePath()
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
    // Not worth crashing over, and reporting it through console would come straight back here.
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
    // No previous rotation, the usual case.
  }
  renameSync(path, previous)
  bytes = 0
}

// String(err) on an Error gives up the stack, the part of a crash report anyone can act on.
function render(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
