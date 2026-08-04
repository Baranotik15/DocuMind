import '@mantine/core/styles.css'
import '@mantine/dropzone/styles.css'
import '@mantine/dates/styles.css'
import './global.css'

import { MantineProvider } from '@mantine/core'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AppLayout } from './layout/AppLayout'
import { ChatPage } from './pages/ChatPage'
import { ChunkPreviewPage } from './pages/ChunkPreviewPage'
import { DashboardPage } from './pages/DashboardPage'
import { RelevancePage } from './pages/RelevancePage'
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
            {/* Not in the sidebar nav - only reachable via a document's edit
                (pencil) action on the Upload page. */}
            <Route path="/upload/:documentId/chunks" element={<ChunkPreviewPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/relevance" element={<RelevancePage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
          </Routes>
        </AppLayout>
      </BrowserRouter>
    </MantineProvider>
  )
}
