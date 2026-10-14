/** Every app Windows lists in its media flyout — browsers, Spotify, Media Player — with its
 *  real play state, through the WinRT session manager. A window title only tells Spotify's
 *  state, so before this a YouTube video or a song in Media Player played straight through
 *  the recording.
 *
 *  PowerShell is the one thing on every install that reaches WinRT without a native module,
 *  and starting it is slow — measured 315-520ms to the first answer — so one copy is started
 *  on the first press of the hotkey and kept, after which each request takes 1-3ms. It holds
 *  on to the sessions it paused, so a resume touches exactly those and can never start
 *  something that was already stopped before the hold. */

import { ChildProcess, spawn } from 'child_process'
import { createInterface } from 'readline'
import { log } from './verbose'

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
  "  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and",
  "  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'",
  '})[0]',
  'function Await($op, [Type]$type) {',
  '  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))',
  '  if ($task.Wait(2000)) { $task.Result } else { $null }',
  '}',
  '$Manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]',
  '$Playing = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing',
  '$manager = Await ($Manager::RequestAsync()) $Manager',
  '$paused = @()',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  '  $done = @()',
  "  if ($line -eq 'pause') {",
  '    $paused = @()',
  '    foreach ($s in $manager.GetSessions()) {',
  '      try {',
  '        if ($s.GetPlaybackInfo().PlaybackStatus -ne $Playing) { continue }',
  '        if (Await ($s.TryPauseAsync()) ([bool])) { $paused += $s; $done += $s.SourceAppUserModelId }',
  '      } catch {}',
  '    }',
  "  } elseif ($line -eq 'resume') {",
  '    foreach ($s in $paused) {',
  '      try { if (Await ($s.TryPlayAsync()) ([bool])) { $done += $s.SourceAppUserModelId } } catch {}',
  '    }',
  '    $paused = @()',
  '  }',
  '  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ apps = @($done) }))',
  '  [Console]::Out.Flush()',
  '}'
].join('\n')

/** Covers a cold start, measured at 520ms to the first answer, with room for a slow disk. */
const REPLY_TIMEOUT_MS = 3_000

interface Helper {
  child: ChildProcess
  waiting: Array<(apps: string[] | null) => void>
}

let helper: Helper | null = null

export function warmMediaSessions(): void {
  start()
}

/** The apps it paused, or null when the helper could not answer and the caller should fall
 *  back to what it can do without it. */
export function pausePlaying(): Promise<string[] | null> {
  return ask('pause')
}

/** Starts again only what the last pausePlaying stopped. */
export function resumePaused(): Promise<string[] | null> {
  return ask('resume')
}

export function stopMediaSessions(): void {
  helper?.child.kill()
}

function start(): Helper {
  if (helper) return helper
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(SCRIPT, 'utf16le').toString('base64')
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
  )
  const started: Helper = { child, waiting: [] }
  helper = started

  const end = (why: string): void => {
    if (helper === started) helper = null
    for (const settle of started.waiting.splice(0)) settle(null)
    log(`media sessions: helper ${why}`)
  }
  // A write to a helper that has already gone is an EPIPE on stdin, which would otherwise be
  // an unhandled error event — the exit handler has settled everyone by then.
  child.stdin?.on('error', () => {})
  child.on('error', (err) => end(`could not start: ${err.message}`))
  child.on('exit', (code) => end(`exited with code ${code}`))
  if (child.stdout) {
    createInterface({ input: child.stdout }).on('line', (line) =>
      started.waiting.shift()?.(parse(line))
    )
  }
  return started
}

function ask(command: 'pause' | 'resume'): Promise<string[] | null> {
  const { child, waiting } = start()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log(`media sessions: no answer to ${command} in ${REPLY_TIMEOUT_MS}ms, restarting`)
      child.kill()
    }, REPLY_TIMEOUT_MS)
    waiting.push((apps) => {
      clearTimeout(timer)
      resolve(apps)
    })
    child.stdin?.write(`${command}\n`)
  })
}

function parse(line: string): string[] | null {
  try {
    const reply = JSON.parse(line) as { apps?: unknown }
    if (!Array.isArray(reply.apps)) return null
    return reply.apps.filter((app): app is string => typeof app === 'string')
  } catch {
    return null
  }
}
