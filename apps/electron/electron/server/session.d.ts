// Augments SessionData in @fastify/secure-session to declare known session keys.
declare module '@fastify/secure-session' {
  interface SessionData {
    email: string
    oidc: { state: string; nonce: string; codeVerifier: string }
  }
}
