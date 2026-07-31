import type { JSX, ReactNode } from 'react'

import { AppShell, Box, Group, Stack, Text, Title } from '@mantine/core'
import { NavLink } from 'react-router-dom'

import classes from './AppLayout.module.css'

interface NavItem {
  to: string
  label: string
}

const NAV_ITEMS: NavItem[] = [
  { to: '/upload', label: 'Upload' },
  { to: '/chunks', label: 'Chunks' },
  { to: '/chat', label: 'Chat' },
  { to: '/dashboard', label: 'Dashboard' },
]

/**
 * Small decorative "graph" mark next to the wordmark - three connected nodes
 * in the two brand accents, a literal nod to DocuMind being a network of
 * connected documents/chunks. Purely decorative, hidden from assistive tech.
 */
function BrandMark(): JSX.Element {
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

          {/* Static/decorative for now - no real health-check wiring behind
              it, this phase is visual only (see .claude/specs and the
              approved design plan). */}
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
