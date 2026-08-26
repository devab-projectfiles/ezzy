import './styles/settings.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary, watchRendererErrors } from './errors'
import Settings from './Settings'

watchRendererErrors('settings')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The only window with a fallback worth drawing: it has a frame, so an empty one would
        sit there looking like a bug with no way to tell what happened. */}
    <ErrorBoundary
      page="settings"
      fallback={
        <div className="settings settings--broken">
          Settings could not be shown. The details are in the log file — open it from the tray menu.
        </div>
      }
    >
      <Settings />
    </ErrorBoundary>
  </StrictMode>
)
