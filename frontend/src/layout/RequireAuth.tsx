import type { JSX, ReactNode } from 'react'

import { useEffect, useState } from 'react'

import { Center, Loader } from '@mantine/core'

import { apiClient } from '../api/client'
import { setStoredEmail } from '../utils/authStorage'

interface RequireAuthProps {
  children: ReactNode
}

/**
 * Gate in front of the AppLayout-wrapped route tree (see App.tsx's `/*`
 * route). Closes the last gap left open through every prior feature/admin-
 * auth slice: some pages (e.g. RelevancePage.tsx, which is search-first and
 * never calls the API on mount) would otherwise never make a request that
 * could 401, so nothing would ever trigger httpClient.ts's global
 * redirect-on-401 for a visitor who isn't actually logged in.
 *
 * On mount, makes exactly one authenticated call (GET /internal/auth/me) to
 * find out. While it's in flight, renders a centered Loader instead of
 * `children` - not `null` - so a genuinely unauthenticated visitor never sees
 * a flash of protected UI before the redirect below can take effect; this
 * should resolve almost instantly on localhost. On success, refreshes
 * authStorage's stored email (covers it being stale/missing) and renders
 * `children` (AppLayout + its nested Routes) completely unchanged.
 *
 * On failure (401), this component does NOT navigate itself - httpClient.ts's
 * shared request helpers already redirect to /login for any 401 except the
 * login endpoint's own expected "wrong password" case, and that covers this
 * call too. This just swallows the rejection so it doesn't surface as an
 * unhandled promise rejection, and leaves the Loader rendered until that
 * navigation takes effect.
 */
export function RequireAuth({ children }: RequireAuthProps): JSX.Element {
  const [isAuthenticated, setIsAuthenticated] = useState(false)

  useEffect(() => {
    let cancelled = false

    apiClient
      .getCurrentUser()
      .then((user) => {
        if (cancelled) {
          return
        }
        setStoredEmail(user.email)
        setIsAuthenticated(true)
      })
      .catch(() => {
        // Unauthenticated - httpClient.ts's global 401 handling already
        // redirects to /login; nothing further to do here.
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (!isAuthenticated) {
    return (
      <Center mih="100dvh">
        <Loader />
      </Center>
    )
  }

  return <>{children}</>
}
