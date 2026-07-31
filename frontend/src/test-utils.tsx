import type { ReactElement } from 'react'

import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

interface RenderWithProvidersOptions {
  route?: string
}

export function renderWithProviders(
  ui: ReactElement,
  options?: RenderWithProvidersOptions,
): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[options?.route ?? '/']}>{ui}</MemoryRouter>
    </MantineProvider>,
  )
}

export { render, screen }
