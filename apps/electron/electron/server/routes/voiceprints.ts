import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  getVoiceprintsByContactId,
  getVoiceprintsBySource,
  enableVoiceprint,
  disableVoiceprint,
  deleteVoiceprint,
  deleteVoiceprintsByContactId,
  deleteAllVoiceprints,
  getRecordingById,
  getKnowledgeCaptureByRecordingId,
  Voiceprint
} from '../../main/services/database'
import type { VoiceprintSummary } from '../../main/types/database'
import { BadRequestError } from './_errors'

// ------------------------------------------------------------------
// Projection (never exposes the raw embedding BLOB)
// ------------------------------------------------------------------

function resolveSourceRecordingTitle(recordingId: string | null): string | null {
  if (!recordingId) return null
  const recording = getRecordingById(recordingId)
  if (!recording) return null
  const capture = getKnowledgeCaptureByRecordingId(recordingId)
  return capture?.title ?? recording.filename ?? null
}

function project(vp: Voiceprint): VoiceprintSummary {
  return {
    id: vp.id,
    contactId: vp.contact_id,
    modelId: vp.model_id,
    createdAt: vp.created_at,
    sourceRecordingId: vp.source_recording_id ?? null,
    sourceRecordingTitle: resolveSourceRecordingTitle(vp.source_recording_id ?? null),
    sourceLabel: vp.source_label ?? null,
    cleanSpeechMs: vp.clean_speech_ms ?? null,
    createdFrom: vp.created_from ?? null,
    disabledAt: vp.disabled_at ?? null
  }
}

// ------------------------------------------------------------------
// Query schemas
// ------------------------------------------------------------------

const findBySourceQ = z.object({
  recordingId: z.string().min(1),
  fileLabel: z.string().min(1),
  contactId: z.string().optional()
})

const enabledBody = z.object({
  enabled: z.boolean()
})

// ------------------------------------------------------------------
// Router
// ------------------------------------------------------------------

export async function registerVoiceprints(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/contacts/:contactId/voiceprints
   * List all voiceprints (active + disabled) for a contact.
   */
  app.get(
    '/api/contacts/:contactId/voiceprints',
    { preHandler: [app.requireAuth] },
    async (req) => {
      const { contactId } = req.params as { contactId: string }
      const vps = getVoiceprintsByContactId(contactId)
      return vps.map(project)
    }
  )

  /**
   * GET /api/voiceprints?recordingId=&fileLabel=&contactId=
   * Find voiceprints by (recordingId, fileLabel) provenance, optionally scoped to one contact.
   */
  app.get(
    '/api/voiceprints',
    { preHandler: [app.requireAuth] },
    async (req) => {
      const q = findBySourceQ.safeParse(req.query)
      if (!q.success) throw new BadRequestError('recordingId and fileLabel query params required')
      const vps = getVoiceprintsBySource(q.data.recordingId, q.data.fileLabel, q.data.contactId)
      return vps.map(project)
    }
  )

  /**
   * PATCH /api/voiceprints/:id   { enabled: boolean }
   * Enable or disable a voiceprint (reversible).
   */
  app.patch(
    '/api/voiceprints/:id',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      const body = enabledBody.parse(req.body)
      if (body.enabled) {
        enableVoiceprint(id)
      } else {
        disableVoiceprint(id)
      }
      return { ok: true }
    }
  )

  /**
   * DELETE /api/voiceprints/:id
   * Hard-delete a single voiceprint.
   */
  app.delete(
    '/api/voiceprints/:id',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      deleteVoiceprint(id)
      return { ok: true }
    }
  )

  /**
   * DELETE /api/voiceprints?contactId=
   * Delete all voiceprints for a contact.
   * Also handles the "clear all" case when contactId is absent (global panic button).
   * Design: DELETE /api/voiceprints?contactId= → clear for contact; DELETE /api/voiceprints (no params) → clear all.
   */
  app.delete(
    '/api/voiceprints',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { contactId } = req.query as { contactId?: string }
      if (contactId !== undefined && contactId !== '') {
        const deleted = deleteVoiceprintsByContactId(contactId)
        return { deleted }
      }
      // No contactId → global clear
      const deleted = deleteAllVoiceprints()
      return { deleted }
    }
  )
}
