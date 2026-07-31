import { describe, expect, it } from 'vitest'

import { fireEvent } from '@testing-library/react'

import { UploadPage } from './UploadPage'
import { renderWithProviders, screen } from '../test-utils'

describe('UploadPage', () => {
  it('lists seeded documents and appends a newly uploaded document', async () => {
    const { container } = renderWithProviders(<UploadPage />)

    // Seeded documents (see mockClient.ts) load asynchronously.
    expect(await screen.findByText('architecture-guide.pdf')).toBeInTheDocument()
    expect(await screen.findByText('onboarding-notes.docx')).toBeInTheDocument()
    expect(await screen.findByText('release-plan.md')).toBeInTheDocument()

    const file = new File(['contents'], 'new-report.pdf', { type: 'application/pdf' })
    // Mantine's FileInput renders a visually-hidden native <input type="file">
    // behind a styled trigger button, so the accessible-name query used above
    // for the seeded rows doesn't apply here - the hidden input carries no
    // label of its own, only the visible trigger button does.
    const input = container.querySelector('input[type="file"]')
    expect(input).not.toBeNull()

    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } })

    expect(await screen.findByText('new-report.pdf')).toBeInTheDocument()
  })
})
