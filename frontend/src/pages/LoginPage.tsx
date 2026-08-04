import type { FormEvent, JSX } from 'react'

import { useState } from 'react'

import { Alert, Button, Group, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core'
import { useNavigate } from 'react-router-dom'

import classes from './LoginPage.module.css'
import { apiClient } from '../api/client'
import { BrandMark } from '../layout/AppLayout'
import { setStoredEmail } from '../utils/authStorage'

/**
 * Wires up to the real `POST /internal/auth/login` endpoint (see
 * feature/admin-auth). On success, navigates to `/` (which redirects to
 * `/upload` - see App.tsx). This page intentionally renders OUTSIDE
 * AppLayout (see App.tsx's `/login` route): an unauthenticated visitor
 * shouldn't see the nav sidebar or the "system ok" header, so it carries its
 * own BrandMark + wordmark instead.
 *
 * Every other page is now gated behind RequireAuth.tsx (see App.tsx) plus
 * httpClient.ts's global redirect-on-401, which lands a visitor back here
 * whenever there's no valid session - this page's own 401 handling above
 * (the "Invalid credentials" alert) is the one path deliberately excluded
 * from that global redirect, since it's this page's own expected outcome,
 * not a "you got logged out" case.
 */
export function LoginPage(): JSX.Element {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [loginFailed, setLoginFailed] = useState(false)
  const [unexpectedError, setUnexpectedError] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setLoginFailed(false)
    setUnexpectedError(false)
    setIsSubmitting(true)

    try {
      const response = await apiClient.login(email, password)
      setStoredEmail(response.email)
      navigate('/')
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_credentials') {
        setLoginFailed(true)
      } else {
        setUnexpectedError(true)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className={classes.page}>
      <Stack gap="xl" align="center" className={classes.card}>
        <Group gap="xs">
          <BrandMark />
          <Title order={1} fz="1.5rem" fw={700} c="var(--doc-text)">
            DocuMind
          </Title>
        </Group>

        {/* Same elevated-surface panel treatment as UploadPage's table panel
            (Paper[withBorder], surface background, soft bottom-weighted
            shadow) rather than a bare/default Mantine form. */}
        <Paper
          component="form"
          onSubmit={handleSubmit}
          radius="lg"
          p="xl"
          bg="var(--doc-surface)"
          withBorder
          w="100%"
          style={{ boxShadow: '0 24px 48px -24px rgba(0, 0, 0, 0.55)' }}
        >
          <Stack gap="lg">
            <Stack gap={4}>
              <Title order={2} fz="1.375rem">
                Log in
              </Title>
              <Text size="sm" c="dimmed">
                Sign in with your DocuMind account to continue.
              </Text>
            </Stack>

            {loginFailed ? (
              <Alert
                color="alertMagenta"
                variant="light"
                radius="lg"
                title="Invalid credentials"
                withCloseButton
                onClose={() => setLoginFailed(false)}
              >
                That email or password wasn't recognized. Please try again.
              </Alert>
            ) : null}

            {unexpectedError ? (
              <Alert
                color="alertMagenta"
                variant="light"
                radius="lg"
                title="Log in failed"
                withCloseButton
                onClose={() => setUnexpectedError(false)}
              >
                Something went wrong. Please try again.
              </Alert>
            ) : null}

            <TextInput
              label="Email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              required
              radius="md"
              size="lg"
            />

            <PasswordInput
              label="Password"
              placeholder="Your password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              required
              radius="md"
              size="lg"
            />

            <Button type="submit" radius="xl" size="lg" fullWidth loading={isSubmitting} disabled={isSubmitting}>
              Log in
            </Button>
          </Stack>
        </Paper>
      </Stack>
    </div>
  )
}
