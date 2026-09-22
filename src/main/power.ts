/** Sleeping, hibernating and shutting the machine down — in their own file since these
 *  three are the only commands in the app that cannot be undone.
 *
 *  Two mechanisms: suspend is a Win32 call (`SetSuspendState`), since no command-line
 *  tool sleeps a machine; shutdown is `shutdown.exe`, since ExitWindowsEx requires the
 *  calling process to hold and enable SE_SHUTDOWN_NAME first, which `shutdown.exe`
 *  already does — getting that dance wrong means a call that silently returns false. */

import { execFile } from 'child_process'
import { log } from './verbose'
import { suspend } from './win32'

/** Put the machine to sleep. */
export function sleepMachine(): boolean {
  log('sleeping the machine')
  return suspend(false)
}

export function hibernateMachine(): boolean {
  log('hibernating the machine')
  return suspend(true)
}

/** Shut the machine down, immediately (`/t 0`). No confirmation step and no undo — the
 *  only guard is that the phrase has to be said in full. Windows still closes
 *  applications the ordinary way, so unsaved work gets its own dialog to stop it. */
export function shutDownMachine(): Promise<boolean> {
  log('shutting the machine down')
  return run(['/s', '/t', '0'])
}

function run(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('shutdown.exe', args, { windowsHide: true }, (error) => {
      if (error) {
        console.error(`[ezzy] shutdown.exe ${args.join(' ')} failed:`, error)
        resolve(false)
        return
      }
      resolve(true)
    })
  })
}
