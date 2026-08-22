/** Adaptive contrast, renderer half (PLAN.md §6). The main process decides which way the
 *  glass paints; this puts the answer where the CSS can see it.
 *
 *  One attribute on <html>, not React state: every surface in the window is themed by it, it
 *  is the same answer for all of them, and nothing in the tree needs to re-render when it
 *  changes — base.css swaps a token block and the 220ms transitions do the rest. Passing it
 *  through props would have every component re-render to change a colour CSS already owns. */

import type { BackdropTheme } from '../../shared/types'

export function followBackdropTheme(): void {
  const apply = (theme: BackdropTheme): void => {
    // No attribute at all is the dark set, so the first paint before this resolves is dark —
    // the same fallback the main process starts from.
    document.documentElement.dataset.backdrop = theme
  }
  // Asked for once, then pushed on every change: the push alone would leave a window that
  // loaded over a white desktop sitting dark until the backdrop happened to move.
  void window.ezzy.getBackdropTheme().then(apply)
  window.ezzy.onBackdropTheme(apply)
}
