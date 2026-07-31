import '@mantine/core/styles.css'
import '@mantine/dropzone/styles.css'

import { MantineProvider } from '@mantine/core'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AppLayout } from './layout/AppLayout'
import { ChatPage } from './pages/ChatPage'
import { ChunksPage } from './pages/ChunksPage'
import { DashboardPage } from './pages/DashboardPage'
import { UploadPage } from './pages/UploadPage'
import { cssVariablesResolver, theme } from './theme'

export function App() {
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
      <BrowserRouter>
        <AppLayout>
          <Routes>
            <Route path="/" element={<Navigate to="/upload" replace />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/chunks" element={<ChunksPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
          </Routes>
        </AppLayout>
      </BrowserRouter>
    </MantineProvider>
  )
}
