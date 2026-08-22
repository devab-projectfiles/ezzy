import './styles/dot.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Dot from './Dot'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Dot />
  </StrictMode>
)
