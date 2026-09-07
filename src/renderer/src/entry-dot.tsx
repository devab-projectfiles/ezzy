import './styles/dot.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary, watchRendererErrors } from './errors'
import Dot from './Dot'
import { listenForCapture } from './recorder'
import { followAppearance } from './appearance'

// Push-to-talk records here rather than in the search bar: this is the one window that is
// always alive. Nothing about it is drawn — see recorder.ts.
listenForCapture()

// A crash in a transparent, frameless window is otherwise invisible.
watchRendererErrors('dot')

// Every window paints itself from the same tokens, so every window has to be told which
// set to use. See appearance.ts.
followAppearance()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary page="dot">
      <Dot />
    </ErrorBoundary>
  </StrictMode>
)
