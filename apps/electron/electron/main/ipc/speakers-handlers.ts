/**
 * Speakers IPC Handlers (speaker diarization — D3)
 *
 * speakers:assign writes a recording_speakers row (source='user'). The voiceprint
 * capture hook is wired in D4 (see TODO below) — D3 does NOT import voiceprint-service.
 */

import { ipcMain } from 'electron'
import {
  upsertRecordingSpeaker,
  deleteRecordingSpeaker,
  getRecordingSpeakers,
  getContactById,
  getTranscriptByRecordingId,
  updateTranscriptTurns
} from '../services/database'
import type { Turn } from '../services/asr/asr-provider'
import { success, error, Result } from '../types/api'
import { z } from 'zod'

const AssignSpeakerSchema = z.object({
  recordingId: z.string().min(1),
  fileLabel: z.string().min(1),
  contactId: z.string().min(1)
})

const MergeSpeakerSchema = z
  .object({
    recordingId: z.string().min(1),
    fromLabel: z.string().min(1),
    toLabel: z.string().min(1)
  })
  .refine((d) => d.fromLabel !== d.toLabel, { message: 'fromLabel and toLabel must differ' })

/** Strict per-turn shape — mirrors the `Turn` interface. A malformed payload is
 *  rejected here so it can never be JSON.stringified into transcripts.turns and
 *  corrupt the column. */
const TurnSchema = z.object({
  speaker: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
  words: z
    .array(
      z.object({
        text: z.string(),
        startMs: z.number(),
        endMs: z.number()
      })
    )
    .optional(),
  sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']).optional()
})

const UpdateTurnsSchema = z.object({
  recordingId: z.string().min(1),
  turns: z.array(TurnSchema)
})

const GetForRecordingSchema = z.string().min(1)

/** Parse the JSON turns column into a typed array (tolerant of NULL/garbage). */
function parseTurns(raw: string | null | undefined): Turn[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Turn[]) : []
  } catch {
    return []
  }
}

export function registerSpeakersHandlers(): void {
  /**
   * Map a recording's speaker label (file_label, e.g. "A") to a contact.
   * Writes recording_speakers(source='user'); the D4 voiceprint hook fires here (TODO).
   */
  ipcMain.handle(
    'speakers:assign',
    async (_, request: unknown): Promise<Result<{ recordingId: string; fileLabel: string; contactId: string }>> => {
      try {
        const parsed = AssignSpeakerSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid speaker assignment request', parsed.error.format())
        }

        const { recordingId, fileLabel, contactId } = parsed.data

        const contact = getContactById(contactId)
        if (!contact) {
          return error('NOT_FOUND', `Contact with ID ${contactId} not found`)
        }

        upsertRecordingSpeaker({
          recording_id: recordingId,
          file_label: fileLabel,
          contact_id: contactId,
          source: 'user'
        })

        // TODO(D4): fire voiceprint capture hook here
        //   (voiceprint-service.captureVoiceprint(recordingId, fileLabel, contactId))
        //   — capture-only; never throws into this handler; respects isVoiceprintAvailable().

        return success({ recordingId, fileLabel, contactId })
      } catch (err) {
        console.error('speakers:assign error:', err)
        return error('DATABASE_ERROR', 'Failed to assign speaker', err)
      }
    }
  )

  /**
   * Merge speaker fromLabel into toLabel (§6.3 / Integration Corrections: "merge is
   * done IN THE HANDLER"). Server-side so the edit actually persists:
   *   1. Load the recording's turns, rewrite every `speaker===fromLabel` to toLabel,
   *      and persist via updateTranscriptTurns.
   *   2. Carry fromLabel's contact mapping onto toLabel ONLY if toLabel has no row yet
   *      (preserve the mapping when collapsing).
   *   3. Delete fromLabel's recording_speakers row so no orphan remains (Issue 3).
   */
  ipcMain.handle(
    'speakers:merge',
    async (
      _,
      request: unknown
    ): Promise<Result<{ recordingId: string; fromLabel: string; toLabel: string; turns: Turn[] }>> => {
      try {
        const parsed = MergeSpeakerSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid speaker merge request', parsed.error.format())
        }

        const { recordingId, fromLabel, toLabel } = parsed.data

        const transcript = getTranscriptByRecordingId(recordingId)
        const turns = parseTurns(transcript?.turns)
        if (turns.length === 0) {
          return error('NOT_FOUND', `No diarized turns found for recording ${recordingId}`)
        }

        // 1. Rewrite turns: every fromLabel becomes toLabel.
        const rewritten = turns.map((t) => (t.speaker === fromLabel ? { ...t, speaker: toLabel } : t))
        updateTranscriptTurns(recordingId, rewritten)

        // 2. Preserve the mapping: if toLabel has no row but fromLabel does, carry it over.
        const rows = getRecordingSpeakers(recordingId)
        const toRow = rows.find((r) => r.file_label === toLabel)
        const fromRow = rows.find((r) => r.file_label === fromLabel)
        if (!toRow && fromRow) {
          upsertRecordingSpeaker({
            recording_id: recordingId,
            file_label: toLabel,
            contact_id: fromRow.contact_id,
            confidence: fromRow.confidence,
            source: 'user'
          })
        }

        // 3. Remove the now-orphaned fromLabel mapping.
        deleteRecordingSpeaker(recordingId, fromLabel)

        return success({ recordingId, fromLabel, toLabel, turns: rewritten })
      } catch (err) {
        console.error('speakers:merge error:', err)
        return error('DATABASE_ERROR', 'Failed to merge speakers', err)
      }
    }
  )

  /**
   * Return the recording's speaker mappings joined to contact names, keyed by
   * file_label: `{ [label]: { contactId, contactName } }`. Powers the SpeakersPanel
   * "→ <name>" display and the live refresh after assign/merge/reassign. Rows with a
   * null contact_id, or whose contact no longer resolves, are omitted.
   */
  ipcMain.handle(
    'speakers:getForRecording',
    async (
      _,
      recordingId: unknown
    ): Promise<Result<Record<string, { contactId: string; contactName: string }>>> => {
      try {
        const parsed = GetForRecordingSchema.safeParse(recordingId)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid recordingId', parsed.error.format())
        }

        const rows = getRecordingSpeakers(parsed.data)
        const map: Record<string, { contactId: string; contactName: string }> = {}
        for (const row of rows) {
          if (!row.contact_id) continue
          const contact = getContactById(row.contact_id)
          if (!contact) continue
          map[row.file_label] = { contactId: row.contact_id, contactName: contact.name }
        }

        return success(map)
      } catch (err) {
        console.error('speakers:getForRecording error:', err)
        return error('DATABASE_ERROR', 'Failed to load recording speakers', err)
      }
    }
  )

  /**
   * Persist an edited turns array (per-turn reassign, §6.3 / AC3). The renderer
   * computes the new turns (e.g. one turn's speaker changed to another existing
   * label) and sends the full array; this only writes transcripts.turns.
   */
  ipcMain.handle(
    'transcripts:updateTurns',
    async (_, request: unknown): Promise<Result<{ recordingId: string }>> => {
      try {
        const parsed = UpdateTurnsSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid update-turns request', parsed.error.format())
        }

        const { recordingId, turns } = parsed.data
        updateTranscriptTurns(recordingId, turns as Turn[])
        return success({ recordingId })
      } catch (err) {
        console.error('transcripts:updateTurns error:', err)
        return error('DATABASE_ERROR', 'Failed to update turns', err)
      }
    }
  )
}
