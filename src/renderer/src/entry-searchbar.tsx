import './styles/searchbar.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary, watchRendererErrors } from './errors'
import SearchBar from './SearchBar'

// §8 chunk F: a crash in a transparent, frameless window is otherwise invisible.
watchRendererErrors('search bar')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary page="search bar">
      <SearchBar />
    </ErrorBoundary>
  </StrictMode>
)
