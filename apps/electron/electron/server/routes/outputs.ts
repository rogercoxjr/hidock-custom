import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { getOutputGeneratorService } from '../../main/services/output-generator'
import { queryOne, runNoSave, runInTransaction } from '../../main/services/database'
import { NotFoundError, BadRequestError } from './_errors'

// ---------------------------------------------------------------------------
// Rate limiting (mirrors B-ACT-001 from the IPC handler)
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 5
const generationTimestamps: Map<string, number[]> = new Map()

function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const timestamps = generationTimestamps.get(key) ?? []
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    generationTimestamps.set(key, recent)
    return false
  }
  recent.push(now)
  generationTimestamps.set(key, recent)
  return true
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const OUTPUT_TEMPLATE_IDS = [
  'meeting_minutes',
  'interview_feedback',
  'project_status',
  'action_items'
] as const

const generateBody = z
  .object({
    templateId: z.enum(OUTPUT_TEMPLATE_IDS),
    meetingId: z.string().optional(),
    projectId: z.string().optional(),
    contactId: z.string().optional(),
    knowledgeCaptureId: z.string().optional(),
    actionableId: z.string().optional()
  })
  .refine((d) => d.meetingId || d.projectId || d.contactId || d.knowledgeCaptureId, {
    message: 'At least one context (meetingId, projectId, contactId, or knowledgeCaptureId) must be provided'
  })

const downloadBody = z.object({
  content: z.string(),
  filename: z.string().optional()
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function registerOutputs(app: FastifyInstance): Promise<void> {
  const generator = getOutputGeneratorService()

  // GET /api/outputs/templates — list all available templates (read)
  app.get('/api/outputs/templates', { preHandler: [app.requireAuth] }, async () => {
    return generator.getTemplates()
  })

  // POST /api/outputs/generate — generate output via a template (write/action)
  app.post('/api/outputs/generate', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const body = generateBody.parse(req.body)

    // B-ACT-001: server-side rate limiting per actionable/knowledge capture
    const rateLimitKey = body.actionableId ?? body.knowledgeCaptureId ?? 'global'
    if (!checkRateLimit(rateLimitKey)) {
      throw new BadRequestError(
        'Rate limit exceeded. Maximum 5 generations per minute. Please wait before trying again.'
      )
    }

    let result: { content: string; templateId: string; generatedAt: string }
    try {
      result = await generator.generate(body)
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not available')) throw new BadRequestError(err.message)
        if (err.message.includes('not found') || err.message.includes('No transcripts')) {
          throw new NotFoundError(err.message)
        }
      }
      throw err
    }

    // If actionableId was provided, persist the output row and link it
    if (body.actionableId) {
      const outputId = randomUUID()
      const now = new Date().toISOString()
      try {
        runInTransaction(() => {
          runNoSave(
            'INSERT INTO outputs (id, knowledge_capture_id, template_id, template_name, content, generated_at) VALUES (?, ?, ?, ?, ?, ?)',
            [outputId, body.knowledgeCaptureId ?? '', body.templateId, body.templateId, result.content, now]
          )
          runNoSave(
            'UPDATE actionables SET status = ?, artifact_id = ?, generated_at = ?, updated_at = ? WHERE id = ?',
            ['generated', outputId, now, now, body.actionableId]
          )
        })
      } catch {
        // Non-fatal — still return the generated content
      }
    }

    return {
      content: result.content,
      templateId: result.templateId,
      generatedAt: result.generatedAt
    }
  })

  // GET /api/actionables/:id/output — fetch existing output for an actionable
  app.get('/api/actionables/:id/output', { preHandler: [app.requireAuth] }, async (req) => {
    const { id: actionableId } = req.params as { id: string }

    const actionable = queryOne<{ artifact_id: string | null }>(
      'SELECT artifact_id FROM actionables WHERE id = ?',
      [actionableId]
    )
    if (!actionable) throw new NotFoundError('actionable not found')

    if (!actionable.artifact_id) {
      // No output generated yet — return null (not a 404; 404 means the actionable is absent)
      return null
    }

    const output = queryOne<{
      content: string
      template_id: string
      generated_at: string
    }>('SELECT content, template_id, generated_at FROM outputs WHERE id = ?', [actionable.artifact_id])

    if (!output) {
      // Stale artifact_id reference
      return null
    }

    return {
      content: output.content,
      templateId: output.template_id,
      generatedAt: output.generated_at
    }
  })

  // POST /api/outputs/download — return content as a browser download (write)
  // Replaces native dialog from `outputs:saveToFile`; defers file-system dialog to the browser.
  app.post('/api/outputs/download', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req, reply) => {
    const body = downloadBody.parse(req.body)
    const filename = body.filename ?? `output-${new Date().toISOString().slice(0, 10)}.md`
    const sanitised = filename.replace(/[/\\?%*:|"<>]/g, '-')

    return reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${sanitised}"`)
      .send(body.content)
  })
}
