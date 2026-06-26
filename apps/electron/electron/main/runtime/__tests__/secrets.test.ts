import { describe, it, expect, afterEach } from 'vitest'
import { encryptSensitive, decryptSensitive } from '../secrets'

describe('runtime/secrets', () => {
  const original = { ...process.env }
  afterEach(() => { process.env = { ...original } })

  it('round-trips a value when a key is configured', () => {
    process.env.HIDOCK_SECRET_KEY = 'test-key-please-change'
    const enc = encryptSensitive('sk-secret-123')
    expect(enc.startsWith('__enc__')).toBe(true)
    expect(enc).not.toContain('sk-secret-123')
    expect(decryptSensitive(enc)).toBe('sk-secret-123')
  })

  it('never double-wraps an already-encrypted value', () => {
    process.env.HIDOCK_SECRET_KEY = 'test-key-please-change'
    const enc = encryptSensitive('abc')
    expect(encryptSensitive(enc)).toBe(enc)
  })

  it('falls back to plaintext when no key is set', () => {
    delete process.env.HIDOCK_SECRET_KEY
    expect(encryptSensitive('abc')).toBe('abc')
    expect(decryptSensitive('abc')).toBe('abc')
  })

  it('returns empty string unchanged', () => {
    process.env.HIDOCK_SECRET_KEY = 'test-key-please-change'
    expect(encryptSensitive('')).toBe('')
  })
})
