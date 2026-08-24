import './styles/dot.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Dot from './Dot'
import { listenForCapture } from './recorder'

// Push-to-talk records here rather than in the search bar: this is the one window that is
// always alive. Nothing about it is drawn — see recorder.ts.
listenForCapture()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Dot />
  </StrictMode>
)
