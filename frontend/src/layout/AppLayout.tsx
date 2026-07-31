import type { ReactNode } from 'react'

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

interface AppLayoutProps {
  children: ReactNode
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <AppShell header={{ height: 60 }} navbar={{ width: 240, breakpoint: 'sm' }} padding="md">
      <AppShell.Header
        style={{
          backgroundColor: 'var(--doc-ink)',
          // Scope Mantine's text-color variable to paper for this subtree so
          // every child (Title, Text, future icons/badges) defaults to
          // readable-on-dark without each one needing its own override.
          '--mantine-color-text': 'var(--doc-paper)',
        }}
      >
        <Group h="100%" px="md" justify="space-between">
          <Title order={1} fz="lg" fw={600} c="var(--doc-paper)">
            DocuMind
          </Title>

          {/* Static/decorative for now - no real health-check wiring behind
              it, this phase is visual only (see .claude/specs and the
              approved design plan). */}
          <Group gap={8} aria-hidden="true">
            <Box
              w={8}
              h={8}
              style={{ borderRadius: '50%', backgroundColor: 'var(--mantine-color-teal-4)', flexShrink: 0 }}
            />
            <Text size="xs" style={{ color: 'rgba(245, 243, 238, 0.7)' }}>
              system ok
            </Text>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md" aria-label="Main navigation">
        <Stack gap="xs">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={classes.navLink}
              style={({ isActive }) => ({
                color: isActive ? 'var(--mantine-color-signalBlue-7)' : 'var(--doc-ink)',
                fontWeight: isActive ? 600 : 400,
                borderLeftColor: isActive ? 'var(--mantine-color-markAmber-6)' : 'transparent',
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
