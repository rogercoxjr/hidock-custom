import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getAllowedUser } from '../main/services/database'

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const { oidc, publicUrl } = app.appDeps

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    const email = req.session.get('email') as string | undefined
    if (!email) return reply.code(401).send({ error: 'unauthenticated' })
    const u = getAllowedUser(email)
    if (!u || u.status !== 'active') {
      req.session.delete()
      return reply.code(401).send({ error: 'unauthorized' })
    }
    req.user = { email: u.email, role: u.role }
  })

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || req.user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
  })

  // CSRF defense-in-depth: a present-but-foreign Origin on a mutating request is rejected.
  app.decorate('requireSameOrigin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (MUTATING.has(req.method)) {
      const origin = req.headers.origin
      if (origin && origin !== publicUrl) return reply.code(403).send({ error: 'bad origin' })
    }
  })

  app.get('/auth/login', async (req, reply) => {
    const { redirectUrl, state, nonce, codeVerifier } = await oidc.beginLogin()
    req.session.set('oidc', { state, nonce, codeVerifier })
    return reply.redirect(redirectUrl, 302)
  })

  app.get('/auth/callback', async (req, reply) => {
    const ctx = req.session.get('oidc') as { state: string; nonce: string; codeVerifier: string } | undefined
    if (!ctx) return reply.code(400).send({ error: 'no login in progress' })
    // Build the callback URL from PUBLIC_URL (not req.host — that is the internal proxy address).
    const currentUrl = new URL(req.url, publicUrl).href
    let user
    try {
      user = await oidc.completeLogin(currentUrl, ctx)
    } catch {
      req.session.set('oidc', undefined)
      return reply.code(400).send({ error: 'oidc exchange failed' })
    }
    req.session.set('oidc', undefined)
    if (!user.emailVerified) return reply.code(403).send({ error: 'email not verified' })
    const allowed = getAllowedUser(user.email)
    if (!allowed || allowed.status !== 'active') {
      req.session.delete()
      return reply.code(403).send({ error: 'not invited — contact the administrator' })
    }
    req.session.set('email', user.email)
    return reply.redirect('/', 302)
  })

  app.post('/auth/logout', async (req, reply) => {
    req.session.delete()
    return reply.code(204).send()
  })

  app.get('/api/me', { preHandler: [app.requireAuth] }, async (req) => {
    return { email: req.user!.email, role: req.user!.role }
  })
}
