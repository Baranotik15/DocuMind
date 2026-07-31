import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Self-hosted fonts (no Google Fonts CDN - the app must work offline/in
// Docker without external network calls at runtime). Only the weights
// actually used are pulled in to keep bundle size reasonable: 400/500/600
// for UI chrome (IBM Plex Sans), 400/500 for content/data (IBM Plex Mono).
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

import { App } from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
