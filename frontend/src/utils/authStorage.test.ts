import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearStoredEmail, getStoredEmail, setStoredEmail } from './authStorage'

describe('authStorage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('returns null when no email has been stored', () => {
    expect(getStoredEmail()).toBeNull()
  })

  it('returns the most recently stored email', () => {
    setStoredEmail('admin@documind.dev')

    expect(getStoredEmail()).toBe('admin@documind.dev')
  })

  it('overwrites a previously stored email with the latest one set', () => {
    setStoredEmail('first@documind.dev')
    setStoredEmail('second@documind.dev')

    expect(getStoredEmail()).toBe('second@documind.dev')
  })

  it('returns null again after clearing', () => {
    setStoredEmail('admin@documind.dev')

    clearStoredEmail()

    expect(getStoredEmail()).toBeNull()
  })
})
