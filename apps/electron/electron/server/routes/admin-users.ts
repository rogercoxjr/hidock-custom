import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  listAllowedUsers, upsertAllowedUser, setAllowedUserStatus, getAllowedUser, countActiveAdmins
} from '../../main/services/database'

const inviteSchema = z.object({ email: z.email(), role: z.enum(['admin', 'member']).optional() })
const patchSchema = z.object({
  email: z.email(),
  role: z.enum(['admin', 'member']).optional(),
  status: z.enum(['active', 'revoked']).optional()
})

export async function registerAdminUsers(app: FastifyInstance): Promise<void> {
  const read = { preHandler: [app.requireAuth, app.requireAdmin] }
  const write = { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] }

  app.get('/api/admin/users', read, async () => ({ users: listAllowedUsers() }))

  app.post('/api/admin/users', write, async (req, reply) => {
    const body = inviteSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid', details: body.error.flatten() })
    upsertAllowedUser({ email: body.data.email, role: body.data.role, invitedBy: req.user!.email })
    return reply.code(201).send({ user: getAllowedUser(body.data.email) })
  })

  app.patch('/api/admin/users', write, async (req, reply) => {
    const body = patchSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid', details: body.error.flatten() })
    const current = getAllowedUser(body.data.email)
    if (!current) return reply.code(404).send({ error: 'not found' })

    // Last-admin guard: block a change that removes the final active admin.
    const willRemoveAdmin =
      current.role === 'admin' && current.status === 'active' &&
      ((body.data.role && body.data.role !== 'admin') || body.data.status === 'revoked')
    if (willRemoveAdmin && countActiveAdmins() <= 1) {
      return reply.code(409).send({ error: 'cannot remove the last active admin' })
    }

    if (body.data.role) upsertAllowedUser({ email: body.data.email, role: body.data.role })
    if (body.data.status) setAllowedUserStatus(body.data.email, body.data.status)
    return reply.send({ user: getAllowedUser(body.data.email) })
  })
}
