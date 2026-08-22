import './styles/dot.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Dot from './Dot'
import { followBackdropTheme } from './backdrop'

// §6 adaptive contrast: before the first render, so the surface paints the right way round
// rather than flipping once React has settled.
followBackdropTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Dot />
  </StrictMode>
)
