/** The renderer half of PLAN.md §8 chunk F's "error boundary + a log file".
 *
 *  Ezzy's windows are frameless, transparent and have no console anyone will ever open, so a
 *  React error is normally invisible twice over: React unmounts the tree, and the window is
 *  transparent, so the failure looks exactly like the dot having disappeared. Both halves of
 *  this file exist to turn that into a line in the log file the tray can open.
 *
 *  Nothing here tries to recover. A boundary that re-renders the same broken tree loops, and
 *  the panel is rebuilt from scratch on every open anyway — the honest fallback for an overlay
 *  is to draw nothing and say so in the log. */

import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  /** Which window this is, so the log line names it. */
  page: string
  children: ReactNode
  /** What to draw instead. Nothing, for the three glass surfaces: they are furniture, and a
   *  broken piece of furniture should be absent rather than wrong. */
  fallback?: ReactNode
}

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    report(this.props.page, `${error.stack ?? error.message}${info.componentStack ?? ''}`)
  }

  render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children
  }
}

/** Everything a boundary cannot catch: event handlers, timers, and the IPC callbacks that
 *  most of these windows are actually driven by. Those throw straight past React. */
export function watchRendererErrors(page: string): void {
  window.addEventListener('error', (event) => {
    report(page, event.error instanceof Error ? (event.error.stack ?? '') : event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason
    report(page, reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
  })
}

function report(page: string, message: string): void {
  // Both: the console line is teed to the log file by the main process only for main-process
  // output, so the renderer has to send its own — and the console still helps in dev.
  console.error(`[ezzy] ${page}:`, message)
  window.ezzy.reportError(page, message)
}
