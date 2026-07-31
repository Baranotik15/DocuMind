import { describe, expect, it, vi } from 'vitest'

import { fireEvent, waitFor } from '@testing-library/react'

import { ChunksPage } from './ChunksPage'
import { apiClient } from '../api/client'
import { renderWithProviders, screen } from '../test-utils'

describe('ChunksPage', () => {
  it('renders the default document chunks, allows in-place editing, and saves the edited content', async () => {
    // Spy on (rather than replace) the real apiClient - saveChunks is the
    // external boundary this test asserts against, but the mock client's
    // own store/branching logic still runs for real, per
    // .claude/docs/testing.md's "mock at the right level" guidance.
    const saveChunksSpy = vi.spyOn(apiClient, 'saveChunks')

    renderWithProviders(<ChunksPage />)

    // Seeded chunks for the default document (doc-1, see mockClient.ts)
    // load asynchronously after the initial listDocuments()/getChunks() calls.
    const firstChunkTextarea = await screen.findByDisplayValue(
      'Section 1: Introduction to the system architecture.',
    )
    expect(await screen.findByDisplayValue('Section 2: Data flow between services.')).toBeInTheDocument()
    expect(await screen.findByDisplayValue('Section 3: Deployment topology.')).toBeInTheDocument()

    fireEvent.change(firstChunkTextarea, { target: { value: 'Edited introduction section.' } })

    expect(await screen.findByDisplayValue('Edited introduction section.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(saveChunksSpy).toHaveBeenCalledWith(
        'doc-1',
        expect.arrayContaining([expect.objectContaining({ id: 'chunk-1', editedContent: 'Edited introduction section.' })]),
      )
    })

    saveChunksSpy.mockRestore()
  })
})
