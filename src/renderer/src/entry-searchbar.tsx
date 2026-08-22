import './styles/searchbar.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import SearchBar from './SearchBar'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SearchBar />
  </StrictMode>
)
