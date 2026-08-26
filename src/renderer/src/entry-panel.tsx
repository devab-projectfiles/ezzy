import './styles/panel.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary, watchRendererErrors } from './errors'
import Panel from './Panel'

// §8 chunk F: a crash in a transparent, frameless window is otherwise invisible.
watchRendererErrors('panel')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary page="panel">
      <Panel />
    </ErrorBoundary>
  </StrictMode>
)
