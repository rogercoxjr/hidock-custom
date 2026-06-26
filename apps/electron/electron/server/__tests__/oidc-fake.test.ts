import { describe, it, expect } from 'vitest'
import { createFakeOidc } from '../oidc'

describe('createFakeOidc', () => {
  it('beginLogin returns a redirect URL + login context', async () => {
    const oidc = createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's1' })
    const r = await oidc.beginLogin()
    expect(r.redirectUrl).toContain('http')
    expect(r.state).toBeTruthy(); expect(r.nonce).toBeTruthy(); expect(r.codeVerifier).toBeTruthy()
  })

  it('completeLogin returns the canned user when given the issued context', async () => {
    const oidc = createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's1' })
    const ctx = await oidc.beginLogin()
    const u = await oidc.completeLogin('https://hub.example.com/auth/callback?code=x&state=' + ctx.state, ctx)
    expect(u).toEqual({ email: 'a@x.com', emailVerified: true, sub: 's1' })
  })

  it('completeLogin throws when the context does not match what was issued', async () => {
    const oidc = createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's1' })
    await oidc.beginLogin()
    await expect(oidc.completeLogin('https://hub.example.com/auth/callback',
      { state: 'wrong', nonce: 'wrong', codeVerifier: 'wrong' })).rejects.toThrow(/context/)
  })

  it('completeLogin can be forced to fail (exchange error)', async () => {
    const oidc = createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's1' }, { failComplete: true })
    const ctx = await oidc.beginLogin()
    await expect(oidc.completeLogin('https://hub.example.com/auth/callback', ctx)).rejects.toThrow()
  })
})
