/** Sleeping, hibernating and shutting the machine down.
 *
 *  Not in PLAN.md's command set — asked for after chunk D, and the registry is where a request
 *  like this is supposed to land (§4). It lives in its own file rather than in `builtin.ts`
 *  because "how does Windows go to sleep" is a different question from "what did the user
 *  say", and because these three are the only commands in the app that cannot be undone.
 *
 *  Two mechanisms, for the two things Windows treats differently:
 *
 *   * **Suspend** is a Win32 call (`SetSuspendState`), because there is no command-line tool
 *     that sleeps a machine — `shutdown.exe` has no flag for it.
 *   * **Shutdown** is `shutdown.exe`, because ExitWindowsEx requires the calling process to
 *     hold SE_SHUTDOWN_NAME and to enable it first. `shutdown.exe` does that dance already,
 *     and getting it wrong means a call that silently returns false. */

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

/** Shut the machine down.
 *
 *  `/t 0` — immediately, which is what "shut down the pc" means. There is no confirmation step
 *  and no undo; the only guard is that the phrase has to be said in full, and a spoken command
 *  that is not understood does nothing rather than something approximate.
 *
 *  Windows still closes applications the ordinary way, so anything with unsaved work gets to
 *  put its dialog up and stop the shutdown itself. */
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
