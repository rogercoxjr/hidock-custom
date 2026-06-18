/**
 * Speakers IPC Handlers (speaker diarization — D3)
 *
 * speakers:assign writes a recording_speakers row (source='user'). The voiceprint
 * capture hook is wired in D4 (see TODO below) — D3 does NOT import voiceprint-service.
 */

import { ipcMain } from 'electron'
import { upsertRecordingSpeaker, getContactById } from '../services/database'
import { success, error, Result } from '../types/api'
import { z } from 'zod'

const AssignSpeakerSchema = z.object({
  recordingId: z.string().min(1),
  fileLabel: z.string().min(1),
  contactId: z.string().min(1)
})

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
}
