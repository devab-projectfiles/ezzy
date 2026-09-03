/** Timing instrumentation for the budgets, behind `--verbose`. */

const enabled = process.argv.includes('--verbose') || process.env['EZZY_VERBOSE'] === '1'

export function log(message: string): void {
  if (!enabled) return
  console.log(`[ezzy] ${message}`)
}

/** Log elapsed time since a `performance.now()` mark. */
export function since(label: string, startedAt: number): void {
  if (!enabled) return
  console.log(`[ezzy] ${label}: ${(performance.now() - startedAt).toFixed(1)}ms`)
}
