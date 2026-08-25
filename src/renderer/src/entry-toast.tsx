import './styles/toast.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Toast from './Toast'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Toast />
  </StrictMode>
)
