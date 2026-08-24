/** What the panel shows, assembled from the sources that feed it.
 *
 *  This exists so the window tracker, the app index and the launcher never have to know
 *  about each other: "which apps are not running", "what matches what was typed" and "is
 *  this query actually a URL" are all questions about more than one of them, and they are
 *  answered in exactly one place rather than in the renderer.
 *
 *  It also owns the current query. The query is typed in the search-bar window and drawn in
 *  the panel window, so neither renderer can be the one that holds it. */

import { PanelData } from '../shared/types'
import { appsNotRunning, onAppsChanged } from './app-index'
import { resolveDirect } from './launcher'
import { search } from './search'
import { listWindows, onWindowsChanged } from './window-tracker'

let query = ''

export function panelData(): PanelData {
  const windows = listWindows()
  const apps = appsNotRunning(windows.map((entry) => entry.app))
  const matched = search(query, windows, apps)
  return { ...matched, direct: resolveDirect(query), query }
}

/** The query changed. Returns the results for it, so the caller does not have to ask again. */
export function setQuery(next: string): PanelData {
  query = next
  return panelData()
}

/** The panel is closing or opening. Clearing here rather than waiting for the search bar's
 *  own reset means the next open cannot briefly show the previous session's results. */
export function clearQuery(): void {
  query = ''
}

/** Any source changing re-publishes everything, because a window opening also removes its
 *  app from the "not running" list, and an icon landing changes a row that is already on
 *  screen. */
export function onPanelDataChanged(listener: (data: PanelData) => void): void {
  const publish = (): void => listener(panelData())
  onWindowsChanged(publish)
  onAppsChanged(publish)
}
