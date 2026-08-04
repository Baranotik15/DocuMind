import '@mantine/core/styles.css'
import '@mantine/dropzone/styles.css'
import '@mantine/dates/styles.css'
import './global.css'

import { MantineProvider } from '@mantine/core'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AppLayout } from './layout/AppLayout'
import { RequireAuth } from './layout/RequireAuth'
import { ChatPage } from './pages/ChatPage'
import { ChunkPreviewPage } from './pages/ChunkPreviewPage'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { RelevancePage } from './pages/RelevancePage'
import { UploadPage } from './pages/UploadPage'
import { cssVariablesResolver, theme } from './theme'

export function App() {
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
      <BrowserRouter>
        <Routes>
          {/* Sits outside/parallel to the AppLayout-wrapped block below, not
              nested inside it - an unauthenticated visitor shouldn't see the
              nav sidebar or "system ok" header (see LoginPage.tsx). */}
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/*"
            element={
              // RequireAuth checks GET /internal/auth/me on mount and only
              // renders AppLayout (+ its nested Routes) once that succeeds -
              // see RequireAuth.tsx. A 401 here (or from any page's own data
              // call, e.g. an expired session mid-use) is handled uniformly
              // by httpClient.ts's shared request helpers, which redirect to
              // /login themselves.
              <RequireAuth>
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
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </MantineProvider>
  )
}
