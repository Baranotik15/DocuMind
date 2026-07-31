import '@mantine/core/styles.css'

import { MantineProvider } from '@mantine/core'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AppLayout } from './layout/AppLayout'
import { ChunksPage } from './pages/ChunksPage'
import { UploadPage } from './pages/UploadPage'

export function App() {
  return (
    <MantineProvider>
      <BrowserRouter>
        <AppLayout>
          <Routes>
            <Route path="/" element={<Navigate to="/upload" replace />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/chunks" element={<ChunksPage />} />
            <Route path="/chat" element={<div>Chat page</div>} />
            <Route path="/dashboard" element={<div>Dashboard page</div>} />
          </Routes>
        </AppLayout>
      </BrowserRouter>
    </MantineProvider>
  )
}
