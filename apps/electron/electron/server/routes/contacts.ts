import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import {
  getContacts,
  getContactById,
  getMeetingById,
  getMeetingsForContact,
  getContactsForMeeting,
  upsertContact,
  updateContact,
  deleteContact,
  setSelfContact,
  clearSelfContact,
  getSelfContactId,
  Contact
} from '../../main/services/database'
import { NotFoundError } from './_errors'

// ─── Validation schemas ────────────────────────────────────────────────────────

const listQ = z.object({
  search: z.string().optional(),
  type: z.enum(['team', 'candidate', 'customer', 'external', 'unknown', 'all']).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0)
})

const createBody = z.object({
  name: z.string().trim().min(1).max(500),
  email: z.string().email().max(500).nullable().optional(),
  type: z.enum(['team', 'candidate', 'customer', 'external', 'unknown']).optional(),
  role: z.string().max(500).nullable().optional(),
  company: z.string().max(500).nullable().optional()
})

const patchBody = z
  .object({
    name: z.string().min(1).max(500).optional(),
    email: z.string().email().max(500).nullable().optional(),
    notes: z.string().max(10000).nullable().optional(),
    type: z.enum(['team', 'candidate', 'customer', 'external', 'unknown']).optional(),
    role: z.string().max(500).nullable().optional(),
    company: z.string().max(500).nullable().optional(),
    tags: z.array(z.string()).optional()
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.email !== undefined ||
      d.notes !== undefined ||
      d.type !== undefined ||
      d.role !== undefined ||
      d.company !== undefined ||
      d.tags !== undefined,
    { message: 'at least one field must be provided' }
  )

const setSelfBody = z.object({
  contactId: z.string().nullable()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapContact(contact: Contact): Record<string, unknown> {
  let tags: string[] = []
  if (contact.tags) {
    try {
      tags = JSON.parse(contact.tags)
    } catch {
      tags = []
    }
  }
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email ?? null,
    type: contact.type,
    role: contact.role ?? null,
    company: contact.company ?? null,
    notes: contact.notes ?? null,
    tags,
    isSelf: contact.is_self === 1,
    firstSeenAt: contact.first_seen_at,
    lastSeenAt: contact.last_seen_at,
    interactionCount: contact.interaction_count ?? contact.meeting_count,
    createdAt: contact.created_at,
    voiceprintCount: contact.voiceprint_count ?? 0
  }
}

// ─── Route registration ────────────────────────────────────────────────────────

export async function registerContacts(app: FastifyInstance): Promise<void> {
  // GET /api/contacts?search&type&limit&offset
  app.get('/api/contacts', { preHandler: [app.requireAuth] }, async (req) => {
    const q = listQ.parse(req.query)
    const result = getContacts(q.search, q.type, q.limit, q.offset)
    return { items: result.contacts.map(mapContact), total: result.total }
  })

  // GET /api/contacts/self — must be registered before /:id to avoid route conflict
  app.get('/api/contacts/self', { preHandler: [app.requireAuth] }, async () => {
    const selfId = getSelfContactId()
    if (!selfId) return null
    const contact = getContactById(selfId)
    if (!contact) return null
    return mapContact(contact)
  })

  // PUT /api/contacts/self  { contactId: string | null }
  app.put('/api/contacts/self', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { contactId } = setSelfBody.parse(req.body)
    if (contactId === null) {
      clearSelfContact()
      return null
    }
    const contact = getContactById(contactId)
    if (!contact) throw new NotFoundError('contact not found')
    setSelfContact(contactId)
    return mapContact(contact)
  })

  // POST /api/contacts
  app.post('/api/contacts', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req, reply) => {
    const body = createBody.parse(req.body)
    const now = new Date().toISOString()
    const created = upsertContact({
      id: randomUUID(),
      name: body.name,
      email: body.email ?? null,
      type: body.type ?? 'unknown',
      role: body.role ?? null,
      company: body.company ?? null,
      notes: null,
      tags: null,
      first_seen_at: now,
      last_seen_at: now,
      meeting_count: 0,
      is_self: 0
    })
    return reply.code(201).send(mapContact(created))
  })

  // GET /api/contacts/:id
  app.get('/api/contacts/:id', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const contact = getContactById(id)
    if (!contact) throw new NotFoundError('contact not found')
    const meetings = getMeetingsForContact(id)
    let totalMeetingTimeMinutes = 0
    for (const meeting of meetings) {
      const start = new Date(meeting.start_time).getTime()
      const end = new Date(meeting.end_time).getTime()
      totalMeetingTimeMinutes += Math.round((end - start) / 60000)
    }
    return { contact: mapContact(contact), meetings, totalMeetingTimeMinutes }
  })

  // PATCH /api/contacts/:id
  app.patch('/api/contacts/:id', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    const contact = getContactById(id)
    if (!contact) throw new NotFoundError('contact not found')
    const body = patchBody.parse(req.body)

    const updates: Partial<Contact> = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.email !== undefined) updates.email = body.email
    if (body.notes !== undefined) updates.notes = body.notes
    if (body.type !== undefined) updates.type = body.type
    if (body.role !== undefined) updates.role = body.role
    if (body.company !== undefined) updates.company = body.company
    if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags)

    updateContact(id, updates)
    const updated = getContactById(id)!
    return mapContact(updated)
  })

  // DELETE /api/contacts/:id
  app.delete('/api/contacts/:id', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    const contact = getContactById(id)
    if (!contact) throw new NotFoundError('contact not found')
    deleteContact(id)
    return { ok: true }
  })

  // GET /api/meetings/:id/contacts
  // (contacts:getForMeeting — nested under meetings for REST resource model)
  app.get('/api/meetings/:id/contacts', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const meeting = getMeetingById(id)
    if (!meeting) throw new NotFoundError('meeting not found')
    const contacts = getContactsForMeeting(id)
    return contacts.map(mapContact)
  })
}
