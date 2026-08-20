/** Timing instrumentation for the budgets in PLAN.md §7, behind `--verbose`. */

const enabled = process.argv.includes('--verbose') || process.env['EZY_VERBOSE'] === '1'

export function log(message: string): void {
  if (!enabled) return
  console.log(`[ezy] ${message}`)
}

/** Log elapsed time since a `performance.now()` mark. */
export function since(label: string, startedAt: number): void {
  if (!enabled) return
  console.log(`[ezy] ${label}: ${(performance.now() - startedAt).toFixed(1)}ms`)
}
