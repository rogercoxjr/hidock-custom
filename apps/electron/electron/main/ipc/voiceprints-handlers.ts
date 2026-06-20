/**
 * Voiceprints IPC Handlers
 *
 * Read/manage speaker voiceprint embeddings. All renderer-facing payloads are
 * projections that NEVER include the raw embedding BLOB (privacy + size).
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  getVoiceprintsByContactId,
  getVoiceprintsBySource,
  getRecordingById,
  getKnowledgeCaptureByRecordingId,
  disableVoiceprint,
  enableVoiceprint,
  deleteVoiceprint,
  deleteVoiceprintsByContactId,
  deleteAllVoiceprints,
  Voiceprint
} from '../services/database'
import type { VoiceprintSummary } from '../types/database'
import { success, error, Result } from '../types/api'
import { UUIDSchema } from '../validation/common'

const ContactIdRequestSchema = z.object({
  contactId: UUIDSchema
})

const VoiceprintIdRequestSchema = z.object({
  id: UUIDSchema
})

const FindBySourceRequestSchema = z.object({
  recordingId: UUIDSchema,
  fileLabel: z.string().min(1),
  contactId: UUIDSchema.optional()
})

function resolveSourceRecordingTitle(recordingId: string | null): string | null {
  if (!recordingId) return null
  const recording = getRecordingById(recordingId)
  if (!recording) return null
  // Prefer the knowledge-capture title if present; fall back to filename.
  const capture = getKnowledgeCaptureByRecordingId(recordingId)
  return capture?.title ?? recording.filename ?? null
}

function projectVoiceprint(vp: Voiceprint): VoiceprintSummary {
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

export function registerVoiceprintsHandlers(): void {
  /**
   * List all voiceprints (active + disabled) for a contact. BLOB is never returned.
   */
  ipcMain.handle(
    'voiceprints:listForContact',
    async (_, request: unknown): Promise<Result<VoiceprintSummary[]>> => {
      try {
        const parsed = ContactIdRequestSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid contact ID', parsed.error.format())
        }

        const vps = getVoiceprintsByContactId(parsed.data.contactId)
        return success(vps.map(projectVoiceprint))
      } catch (err) {
        console.error('voiceprints:listForContact error:', err)
        return error('DATABASE_ERROR', 'Failed to list voiceprints', err)
      }
    }
  )

  /**
   * Disable a voiceprint (reversible — sets disabled_at).
   */
  ipcMain.handle(
    'voiceprints:disable',
    async (_, request: unknown): Promise<Result<void>> => {
      try {
        const parsed = VoiceprintIdRequestSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid voiceprint ID', parsed.error.format())
        }

        disableVoiceprint(parsed.data.id)
        return success(undefined)
      } catch (err) {
        console.error('voiceprints:disable error:', err)
        return error('DATABASE_ERROR', 'Failed to disable voiceprint', err)
      }
    }
  )

  /**
   * Re-enable a disabled voiceprint (clears disabled_at).
   */
  ipcMain.handle(
    'voiceprints:enable',
    async (_, request: unknown): Promise<Result<void>> => {
      try {
        const parsed = VoiceprintIdRequestSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid voiceprint ID', parsed.error.format())
        }

        enableVoiceprint(parsed.data.id)
        return success(undefined)
      } catch (err) {
        console.error('voiceprints:enable error:', err)
        return error('DATABASE_ERROR', 'Failed to enable voiceprint', err)
      }
    }
  )

  /**
   * Hard-delete a single voiceprint (AC12 un-bank).
   */
  ipcMain.handle(
    'voiceprints:delete',
    async (_, request: unknown): Promise<Result<void>> => {
      try {
        const parsed = VoiceprintIdRequestSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid voiceprint ID', parsed.error.format())
        }

        deleteVoiceprint(parsed.data.id)
        return success(undefined)
      } catch (err) {
        console.error('voiceprints:delete error:', err)
        return error('DATABASE_ERROR', 'Failed to delete voiceprint', err)
      }
    }
  )

  /**
   * Delete all voiceprints for a contact ("Forget this person's voice").
   */
  ipcMain.handle(
    'voiceprints:clearAllForContact',
    async (_, request: unknown): Promise<Result<{ deleted: number }>> => {
      try {
        const parsed = ContactIdRequestSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid contact ID', parsed.error.format())
        }

        const deleted = deleteVoiceprintsByContactId(parsed.data.contactId)
        return success({ deleted })
      } catch (err) {
        console.error('voiceprints:clearAllForContact error:', err)
        return error('DATABASE_ERROR', 'Failed to clear voiceprints for contact', err)
      }
    }
  )

  /**
   * Delete every voiceprint in the library (global panic button).
   */
  ipcMain.handle(
    'voiceprints:clearAll',
    async (): Promise<Result<{ deleted: number }>> => {
      try {
        const deleted = deleteAllVoiceprints()
        return success({ deleted })
      } catch (err) {
        console.error('voiceprints:clearAll error:', err)
        return error('DATABASE_ERROR', 'Failed to clear all voiceprints', err)
      }
    }
  )

  /**
   * Find voiceprints by (recordingId, fileLabel) provenance, optionally scoped to one
   * contact. Returns a list (the table is many-rows per provenance across contacts).
   */
  ipcMain.handle(
    'voiceprints:findBySource',
    async (_, request: unknown): Promise<Result<VoiceprintSummary[]>> => {
      try {
        const parsed = FindBySourceRequestSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid find-by-source request', parsed.error.format())
        }

        const vps = getVoiceprintsBySource(parsed.data.recordingId, parsed.data.fileLabel, parsed.data.contactId)
        return success(vps.map(projectVoiceprint))
      } catch (err) {
        console.error('voiceprints:findBySource error:', err)
        return error('DATABASE_ERROR', 'Failed to find voiceprints by source', err)
      }
    }
  )
}
