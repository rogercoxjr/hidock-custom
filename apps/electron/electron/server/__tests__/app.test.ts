import { describe, it, expect } from 'vitest'
import { buildApp, AppDeps } from '../app'
import { createFakeOidc } from '../oidc'

export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    oidc: createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's' }),
    sessionSecret: 'a-very-long-secret-value',
    adminEmail: 'boss@x.com',
    publicUrl: 'https://hub.example.com',
    cookieSecure: false, // inject() has no TLS — a Secure cookie would not round-trip
    ...overrides
  }
}

describe('buildApp', () => {
  it('serves /healthz', async () => {
    const app = await buildApp(testDeps())
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
    await app.close()
  })
})
