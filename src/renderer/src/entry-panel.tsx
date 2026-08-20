import './styles/panel.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Panel from './Panel'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Panel />
  </StrictMode>
)
