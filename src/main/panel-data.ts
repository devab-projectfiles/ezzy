/** What the panel shows, assembled from the two sources that feed it.
 *
 *  This exists so the window tracker and the app index never have to know about each other:
 *  "which apps are not running" is a question about both, and it is answered in exactly one
 *  place rather than in the renderer. */

import { PanelData } from '../shared/types'
import { appsNotRunning, onAppsChanged } from './app-index'
import { listWindows, onWindowsChanged } from './window-tracker'

export function panelData(): PanelData {
  const windows = listWindows()
  return { windows, apps: appsNotRunning(windows.map((entry) => entry.app)) }
}

/** Either source changing re-publishes both halves, because a window opening also removes
 *  its app from the "not running" list. */
export function onPanelDataChanged(listener: (data: PanelData) => void): void {
  const publish = (): void => listener(panelData())
  onWindowsChanged(publish)
  onAppsChanged(publish)
}
