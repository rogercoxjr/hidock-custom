import { randomUUID } from 'crypto'

export interface OidcUser { email: string; emailVerified: boolean; sub: string }
export interface LoginContext { state: string; nonce: string; codeVerifier: string }
export interface OidcService {
  beginLogin(): Promise<{ redirectUrl: string } & LoginContext>
  completeLogin(currentUrl: string, ctx: LoginContext): Promise<OidcUser>
}

const GOOGLE_ISSUER = 'https://accounts.google.com'
const SCOPE = 'openid email profile'

/**
 * Real Google OIDC client. openid-client v6 is ESM-only and discovery() hits the
 * network, so it is loaded lazily via dynamic import and the Configuration is
 * memoized. NOT unit-tested (needs live Google creds) — verified live by the operator.
 */
export function createGoogleOidc(cfg: { clientId: string; clientSecret: string; publicUrl: string }): OidcService {
  const redirectUri = `${cfg.publicUrl}/auth/callback`
  let configPromise: Promise<unknown> | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lib = (): Promise<any> => import('openid-client')
  const getConfig = async (): Promise<unknown> => {
    if (!configPromise) {
      const client = await lib()
      configPromise = client.discovery(new URL(GOOGLE_ISSUER), cfg.clientId, cfg.clientSecret)
        .catch((err: unknown) => { configPromise = null; throw err })
    }
    return configPromise
  }

  return {
    async beginLogin() {
      const client = await lib()
      const config = await getConfig()
      const codeVerifier: string = client.randomPKCECodeVerifier()
      const codeChallenge: string = await client.calculatePKCECodeChallenge(codeVerifier)
      const state: string = client.randomState()
      const nonce: string = client.randomNonce()
      const url: URL = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce
      })
      return { redirectUrl: url.href, state, nonce, codeVerifier }
    },
    async completeLogin(currentUrl, ctx) {
      const client = await lib()
      const config = await getConfig()
      const tokens = await client.authorizationCodeGrant(config, new URL(currentUrl), {
        pkceCodeVerifier: ctx.codeVerifier,
        expectedState: ctx.state,
        expectedNonce: ctx.nonce
      })
      const claims = tokens.claims()
      if (!claims?.email) throw new Error('OIDC: no email claim')
      return { email: String(claims.email), emailVerified: claims.email_verified === true, sub: String(claims.sub) }
    }
  }
}

/**
 * Deterministic in-memory fake for route tests. completeLogin asserts it received
 * the exact context beginLogin issued, so a route that fails to stash/retrieve
 * state/nonce/code_verifier across the redirect fails the test.
 */
export function createFakeOidc(result: OidcUser, opts: { failComplete?: boolean } = {}): OidcService {
  let issued: LoginContext | null = null
  return {
    async beginLogin() {
      issued = { state: randomUUID(), nonce: randomUUID(), codeVerifier: randomUUID() }
      return { redirectUrl: 'https://accounts.google.com/o/oauth2/v2/auth?fake=1', ...issued }
    },
    async completeLogin(_currentUrl, ctx) {
      if (opts.failComplete) throw new Error('OIDC exchange failed')
      if (!issued) throw new Error('OIDC: completeLogin called before beginLogin')
      if (ctx.state !== issued.state || ctx.nonce !== issued.nonce || ctx.codeVerifier !== issued.codeVerifier) {
        throw new Error('OIDC: login context mismatch (state/nonce/verifier)')
      }
      return result
    }
  }
}
