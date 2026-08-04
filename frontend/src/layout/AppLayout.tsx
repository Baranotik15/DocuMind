import type { JSX, ReactNode } from 'react'

import { useState } from 'react'

import { AppShell, Box, Button, Group, Stack, Text, Title } from '@mantine/core'
import { NavLink, useNavigate } from 'react-router-dom'

import classes from './AppLayout.module.css'
import { apiClient } from '../api/client'
import { clearStoredEmail, getStoredEmail } from '../utils/authStorage'

interface NavItem {
  to: string
  label: string
}

// No standalone "Chunks" tab - chunk review/editing opens per-document from
// the Upload page's edit (pencil) action instead, see UploadPage.tsx.
const NAV_ITEMS: NavItem[] = [
  { to: '/upload', label: 'Upload' },
  { to: '/chat', label: 'Chat' },
  { to: '/relevance', label: 'Relevance Preview' },
  { to: '/dashboard', label: 'Logs & Stats' },
]

/**
 * Small decorative "graph" mark next to the wordmark - three connected nodes
 * in the two brand accents, a literal nod to DocuMind being a network of
 * connected documents/chunks. Purely decorative, hidden from assistive tech.
 *
 * Exported so LoginPage.tsx (which renders outside AppLayout and has no
 * header of its own) can reuse the exact same mark next to its own wordmark,
 * instead of forking a second copy of this SVG.
 */
export function BrandMark(): JSX.Element {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true" focusable="false">
      <line x1="8" y1="22" x2="22" y2="9" stroke="var(--mantine-color-signalBlue-4)" strokeWidth="2" />
      <line x1="8" y1="22" x2="22" y2="22" stroke="var(--mantine-color-sparkOrange-4)" strokeWidth="2" />
      <circle cx="22" cy="9" r="4" fill="var(--mantine-color-signalBlue-5)" />
      <circle cx="22" cy="22" r="4" fill="var(--mantine-color-signalBlue-5)" />
      <circle cx="8" cy="22" r="4.5" fill="var(--mantine-color-sparkOrange-6)" />
    </svg>
  )
}

interface AppLayoutProps {
  children: ReactNode
}

export function AppLayout({ children }: AppLayoutProps) {
  // Read once on mount via the lazy initializer (not a plain module-level
  // read) so a same-tab login/logout updates the header immediately without
  // requiring a full page reload - see authStorage.ts for what this value
  // does/doesn't mean (display-only, not a real auth check).
  const [storedEmail, setStoredEmailState] = useState<string | null>(() => getStoredEmail())
  const navigate = useNavigate()

  async function handleLogout(): Promise<void> {
    await apiClient.logout()
    clearStoredEmail()
    setStoredEmailState(null)
    navigate('/login')
  }

  return (
    <AppShell header={{ height: 68 }} navbar={{ width: 240, breakpoint: 'sm' }} padding="lg">
      <AppShell.Header
        style={{
          backgroundColor: 'var(--doc-surface)',
          borderBottom: '1px solid var(--doc-hairline)',
          // Scope Mantine's text-color variable to the bright text token for
          // this subtree so every child (Title, Text, future icons/badges)
          // defaults to readable-on-dark without each one needing its own
          // override.
          '--mantine-color-text': 'var(--doc-text)',
        }}
      >
        <Group h="100%" px="lg" justify="space-between">
          <Group gap="xs">
            <BrandMark />
            <Title order={1} fz="1.5rem" fw={700} c="var(--doc-text)">
              DocuMind
            </Title>
          </Group>

          {storedEmail === null ? (
            // Static/decorative for now - no real health-check wiring behind
            // it, this phase is visual only (see .claude/specs and the
            // approved design plan). AppLayout only ever mounts once
            // RequireAuth.tsx's guard has succeeded (see App.tsx), and that
            // guard sets the stored email before rendering AppLayout - so in
            // practice this branch is effectively unreachable in the real
            // app now, kept only as a defensive fallback (e.g. this
            // component rendered standalone, as in AppLayout.test.tsx).
            <Group gap={8} aria-hidden="true">
              <Box
                w={9}
                h={9}
                style={{
                  borderRadius: '50%',
                  backgroundColor: 'var(--mantine-color-teal-4)',
                  boxShadow: '0 0 8px rgba(56, 217, 169, 0.65)',
                  flexShrink: 0,
                }}
              />
              <Text size="sm" style={{ color: 'var(--doc-text-muted)' }}>
                system ok
              </Text>
            </Group>
          ) : (
            <Group gap={12}>
              <Text size="sm" style={{ color: 'var(--doc-text-muted)' }}>
                {storedEmail}
              </Text>
              <Button type="button" variant="outline" color="signalBlue" radius="xl" size="xs" onClick={handleLogout}>
                Log out
              </Button>
            </Group>
          )}
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md" className={classes.navbar} aria-label="Main navigation">
        <Stack gap={4}>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={classes.navLink}
              style={({ isActive }) => ({
                color: isActive ? 'var(--doc-text)' : 'var(--doc-text-muted)',
                fontWeight: isActive ? 700 : 500,
                borderColor: isActive ? 'var(--mantine-color-sparkOrange-5)' : 'transparent',
                boxShadow: isActive ? 'var(--doc-mark-glow)' : 'none',
                backgroundColor: isActive ? 'rgba(10, 14, 26, 0.35)' : 'transparent',
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  )
}
