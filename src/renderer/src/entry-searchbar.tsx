import './styles/searchbar.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary, watchRendererErrors } from './errors'
import SearchBar from './SearchBar'
import { followAppearance } from './appearance'

// A crash in a transparent, frameless window is otherwise invisible.
watchRendererErrors('search bar')

// Every window paints itself from the same tokens, so every window has to be told which
// set to use. See appearance.ts.
followAppearance()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary page="search bar">
      <SearchBar />
    </ErrorBoundary>
  </StrictMode>
)
