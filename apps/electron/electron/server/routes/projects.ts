import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import {
  getProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
  getMeetingsForProject,
  getProjectsForMeeting,
  tagMeetingToProject,
  untagMeetingFromProject,
  getTopicsForProjectMeetings,
  getKnowledgeIdsForProject,
  getPersonIdsForProject,
  getMeetingById
} from '../../main/services/database'
import { NotFoundError } from './_errors'

const listQ = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().optional(),
  status: z.string().optional()
})

const createBody = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional()
})

const patchBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: z.string().optional()
}).refine((d) => Object.keys(d).length > 0, { message: 'at least one field required' })

export async function registerProjects(app: FastifyInstance): Promise<void> {
  // GET /api/projects?search&status&limit&offset -> { items, total }
  app.get('/api/projects', { preHandler: [app.requireAuth] }, async (req) => {
    const q = listQ.parse(req.query)
    const result = getProjects(q.search, q.limit, q.offset, q.status)
    return { items: result.projects, total: result.total }
  })

  // GET /api/projects/:id -> project + meetings + topics + knowledgeIds + personIds
  app.get('/api/projects/:id', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const dbProject = getProjectById(id)
    if (!dbProject) throw new NotFoundError('project not found')

    const meetings = getMeetingsForProject(id)

    const topicsSet = new Set<string>()
    const topicsJsonStrings = getTopicsForProjectMeetings(id)
    for (const topicsJson of topicsJsonStrings) {
      try {
        const meetingTopics = JSON.parse(topicsJson) as string[]
        meetingTopics.forEach((topic) => topicsSet.add(topic))
      } catch {
        // Invalid JSON — skip
      }
    }

    const knowledgeIds = getKnowledgeIdsForProject(id)
    const personIds = getPersonIdsForProject(id)

    return {
      project: { ...dbProject, knowledgeIds, personIds },
      meetings,
      topics: Array.from(topicsSet)
    }
  })

  // POST /api/projects
  app.post('/api/projects', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req, reply) => {
    const body = createBody.parse(req.body)
    const id = randomUUID()
    createProject({
      id,
      name: body.name,
      description: body.description ?? null,
      status: 'active'
    })
    const project = getProjectById(id)
    return reply.code(201).send(project)
  })

  // PATCH /api/projects/:id
  app.patch('/api/projects/:id', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    const existing = getProjectById(id)
    if (!existing) throw new NotFoundError('project not found')

    const body = patchBody.parse(req.body)
    updateProject(id, body.name, body.description, body.status)
    return getProjectById(id)
  })

  // DELETE /api/projects/:id
  app.delete('/api/projects/:id', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    const existing = getProjectById(id)
    if (!existing) throw new NotFoundError('project not found')
    deleteProject(id)
    return { ok: true }
  })

  // POST /api/meetings/:meetingId/projects/:projectId  (tag)
  app.post(
    '/api/meetings/:meetingId/projects/:projectId',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { meetingId, projectId } = req.params as { meetingId: string; projectId: string }
      const meeting = getMeetingById(meetingId)
      if (!meeting) throw new NotFoundError('meeting not found')
      const project = getProjectById(projectId)
      if (!project) throw new NotFoundError('project not found')
      tagMeetingToProject(meetingId, projectId)
      return { ok: true }
    }
  )

  // DELETE /api/meetings/:meetingId/projects/:projectId  (untag)
  app.delete(
    '/api/meetings/:meetingId/projects/:projectId',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { meetingId, projectId } = req.params as { meetingId: string; projectId: string }
      const meeting = getMeetingById(meetingId)
      if (!meeting) throw new NotFoundError('meeting not found')
      const project = getProjectById(projectId)
      if (!project) throw new NotFoundError('project not found')
      untagMeetingFromProject(meetingId, projectId)
      return { ok: true }
    }
  )

  // GET /api/meetings/:meetingId/projects  (projects for meeting)
  app.get('/api/meetings/:meetingId/projects', { preHandler: [app.requireAuth] }, async (req) => {
    const { meetingId } = req.params as { meetingId: string }
    const meeting = getMeetingById(meetingId)
    if (!meeting) throw new NotFoundError('meeting not found')
    return getProjectsForMeeting(meetingId)
  })
}
