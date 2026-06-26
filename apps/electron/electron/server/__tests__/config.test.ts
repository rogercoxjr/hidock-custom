import { describe, it, expect, afterEach } from 'vitest'
import { getServerConfig } from '../config'

const REQUIRED = {
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret',
  PUBLIC_URL: 'https://hub.example.com', SESSION_SECRET: 'a-very-long-secret-value'
}

describe('getServerConfig', () => {
  const orig = { ...process.env }
  afterEach(() => { process.env = { ...orig } })

  it('reads required + defaulted values', () => {
    Object.assign(process.env, REQUIRED)
    delete process.env.ADMIN_EMAIL; delete process.env.PORT
    const c = getServerConfig()
    expect(c.googleClientId).toBe('cid')
    expect(c.publicUrl).toBe('https://hub.example.com')
    expect(c.adminEmail).toBe('rogercoxjr@gmail.com') // default
    expect(c.port).toBe(8788)                          // default
  })

  it('strips a trailing slash from PUBLIC_URL', () => {
    Object.assign(process.env, REQUIRED, { PUBLIC_URL: 'https://hub.example.com/' })
    expect(getServerConfig().publicUrl).toBe('https://hub.example.com')
  })

  it('throws when a required var is missing', () => {
    Object.assign(process.env, REQUIRED); delete process.env.GOOGLE_CLIENT_ID
    expect(() => getServerConfig()).toThrow(/GOOGLE_CLIENT_ID/)
  })

  it('throws when SESSION_SECRET is too short', () => {
    Object.assign(process.env, REQUIRED, { SESSION_SECRET: 'short' })
    expect(() => getServerConfig()).toThrow(/SESSION_SECRET/)
  })
})
