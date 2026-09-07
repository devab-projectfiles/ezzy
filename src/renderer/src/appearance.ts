/** Which surface treatment this window wears.
 *
 *  The whole difference between the two is CSS custom properties, so applying one is setting a
 *  single attribute on `<html>` and letting the stylesheet do the rest — see the
 *  `[data-appearance='glass']` block in base.css. Nothing here knows what either looks like.
 *
 *  Every window runs this, because every window is its own document with its own copy of the
 *  stylesheet: there is no shared root to set it on once. It both asks on load and subscribes,
 *  and it needs both — a window opened after a change would miss the broadcast, and a window
 *  already open when the change is made would never ask again. */

import { Appearance } from '../../shared/types'

function apply(appearance: Appearance): void {
  document.documentElement.dataset.appearance = appearance
}

/** Returns a disposer, so a caller inside an effect can clean up after itself. The entry
 *  points call this once at startup and never dispose it, which is correct for them — the
 *  listener should outlive everything they render. */
export function followAppearance(): () => void {
  // Applied before the first paint where possible. `getAppearance` is a round trip, so the
  // window is briefly whatever the stylesheet's default is; that default is `flat`, and the
  // windows are only shown once React has rendered, so nothing flashes on screen.
  void window.ezzy.getAppearance().then(apply)
  return window.ezzy.onAppearance(apply)
}
