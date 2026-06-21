/**
 * Speakers IPC Handlers (speaker diarization — D3)
 *
 * speakers:assign writes a recording_speakers row (source='user'). The voiceprint
 * capture hook is wired in D4 (see TODO below) — D3 does NOT import voiceprint-service.
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  upsertRecordingSpeaker,
  deleteRecordingSpeaker,
  getRecordingSpeaker,
  getRecordingSpeakers,
  getContactById,
  getTranscriptByRecordingId,
  updateTranscriptTurns,
  deleteVoiceprintsBySource,
  getPendingSuggestions,
  getSelfContactId,
  deleteLabelEmbeddingsForRecording,
  expireSuggestionsForRecording,
  acceptSuggestion as dbAcceptSuggestion,
  dismissSuggestion as dbDismissSuggestion,
  type SpeakerSuggestion
} from '../services/database'
import { captureVoiceprint, embedRecordingLabels } from '../services/voiceprint-service'
import { runMatcher, type MatcherResult } from '../services/voiceprint/speaker-matcher'
import type { Turn } from '../services/asr/asr-provider'
import { success, error, Result } from '../types/api'
import { z } from 'zod'

let mainWindow: BrowserWindow | null = null
export function setMainWindowForSpeakers(win: BrowserWindow): void {
  mainWindow = win
}

/**
 * Per-recording single-flight for the expensive getSuggestions compute (spec §5). getSuggestions
 * fires on recording-change AND every onChanged edit, and two IPC calls can overlap; the renderer
 * token guard does not abort in-flight calls. Dedupe the WHOLE embedRecordingLabels+runMatcher
 * sequence by recordingId so two first-opens can't both decode/embed or mint distinct run ids.
 */
const getSuggestionsInFlight = new Map<string, Promise<MatcherResult>>()

function getSuggestionsSequence(recordingId: string): Promise<MatcherResult> {
  const existing = getSuggestionsInFlight.get(recordingId)
  if (existing) return existing
  const p = (async (): Promise<MatcherResult> => {
    await embedRecordingLabels(recordingId)
    return (await runMatcher(recordingId)) as MatcherResult
  })()
  getSuggestionsInFlight.set(recordingId, p)
  // Clear on settle (success OR failure) so a later call re-computes; a rejection is shared by all
  // current awaiters (the handler try/catch maps it to []), then evicted here.
  p.finally(() => {
    if (getSuggestionsInFlight.get(recordingId) === p) getSuggestionsInFlight.delete(recordingId)
  }).catch(() => { /* rejection already surfaced to awaiters; nothing to do here */ })
  return p
}

/** Evict any in-flight getSuggestions compute for a recording. Called by mutation handlers (merge,
 *  updateTurns) AFTER they delete embeddings, so a compute that started pre-edit is not adopted by
 *  the renderer's post-edit refresh — the next getSuggestions starts fresh. */
export function clearSuggestionsInFlight(recordingId: string): void {
  getSuggestionsInFlight.delete(recordingId)
}

const AssignSpeakerSchema = z.object({
  recordingId: z.string().min(1),
  fileLabel: z.string().min(1),
  contactId: z.string().min(1),
  source: z.enum(['user', 'confirmed', 'suggestion_confirmed']).optional().default('user')
})

const MergeSpeakerSchema = z
  .object({
    recordingId: z.string().min(1),
    fromLabel: z.string().min(1),
    toLabel: z.string().min(1)
  })
  .refine((d) => d.fromLabel !== d.toLabel, { message: 'fromLabel and toLabel must differ' })

const GetSuggestionsSchema = z.string().min(1)

const SuggestionIdSchema = z.string().min(1)

const SetSelfSchema = z.object({
  recordingId: z.string().min(1),
  fileLabel: z.string().min(1)
})

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

const UnassignSpeakerSchema = z.object({
  recordingId: z.string().min(1),
  fileLabel: z.string().min(1)
})

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

/** Flat suggestion row returned to the renderer. */
interface SuggestionView {
  id: string
  kind: 'identity' | 'merge' | 'mixed'
  targetLabel: string
  targetLabel2?: string | null
  contactId?: string | null
  contactName?: string | null
  contactName2?: string | null
  score: number | null
  rank: number | null
  rationale: string | null
  requiresWarning: boolean
}

/** Derive the warning flag from a persisted suggestion row. The conflict policy
 *  tags cross-contact merge rationale with "merges X and Y"; we also accept an
 *  explicit "requiresWarning" token so future policy changes stay compatible. */
function getSuggestionRequiresWarning(row: SpeakerSuggestion): boolean {
  const r = row.rationale ?? ''
  if (r.includes('requiresWarning')) return true
  if (row.kind === 'merge' && r.startsWith('merges ') && r.includes(' and ')) return true
  return false
}

/** Schedule a voiceprint capture out-of-band and notify the renderer.
 *  Used by both assign and set-self so every confirmed/user mapping banks a print
 *  without blocking the IPC response. */
function scheduleCaptureAndNotify(
  recordingId: string,
  fileLabel: string,
  contactId: string,
  createdFrom: 'manual' | 'confirmed' | 'self',
  priorContactId?: string | null,
  purgedCount?: number
): void {
  setImmediate(() => {
    captureVoiceprint(recordingId, fileLabel, contactId, createdFrom)
      .then((r) => {
        const payload = {
          recordingId,
          fileLabel,
          contactId,
          captured: r.captured,
          reason: r.reason,
          cleanSpeechMs: r.cleanSpeechMs,
          voiceprintId: r.voiceprintId,
          purgedPriorContactId: priorContactId !== contactId ? priorContactId ?? undefined : undefined,
          purgedCount: purgedCount && purgedCount > 0 ? purgedCount : undefined
        }
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('voiceprint:captured', payload)
          }
        } catch (e) {
          console.warn(`[Voiceprint] send failed (${recordingId}/${fileLabel}): ${(e as Error).message}`)
        }
        if (!r.captured) console.log(`[Voiceprint] skipped (${recordingId}/${fileLabel}): ${r.reason}`)
      })
      .catch((e) => console.warn(`[Voiceprint] capture error (${recordingId}/${fileLabel}): ${(e as Error).message}`))
  })
}

export function registerSpeakersHandlers(): void {
  /**
   * Map a recording's speaker label (file_label, e.g. "A") to a contact.
   * Writes recording_speakers(source='user'); the D4 voiceprint hook fires here.
   * On a genuine reassign-to-a-different-contact, the prior contact's stranded
   * voiceprints for this provenance are purged synchronously before the new
   * contact's capture fires (§3.6, AC12 leak-free correction).
   */
  ipcMain.handle(
    'speakers:assign',
    async (_, request: unknown): Promise<Result<{ recordingId: string; fileLabel: string; contactId: string }>> => {
      try {
        const parsed = AssignSpeakerSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid speaker assignment request', parsed.error.format())
        }

        const { recordingId, fileLabel, contactId, source } = parsed.data

        const contact = getContactById(contactId)
        if (!contact) {
          return error('NOT_FOUND', `Contact with ID ${contactId} not found`)
        }

        // Read the prior attribution BEFORE mutating so we can detect a real contact change.
        const prior = getRecordingSpeaker(recordingId, fileLabel)
        const priorContactId = prior?.contact_id ?? null

        upsertRecordingSpeaker({
          recording_id: recordingId,
          file_label: fileLabel,
          contact_id: contactId,
          source
        })

        // Reassign correction: if the label was previously mapped to a DIFFERENT contact,
        // purge that contact's voiceprints for this exact provenance so no wrong-attribution
        // biometric print survives. Runs synchronously before the deferred capture for the
        // new contact so the new bank never collides with stale prints.
        let purgedCount = 0
        if (priorContactId && priorContactId !== contactId) {
          purgedCount = deleteVoiceprintsBySource(recordingId, fileLabel, priorContactId)
        }

        // Voiceprint capture (§6.7): NEVER blocks or fails the mapping.
        scheduleCaptureAndNotify(
          recordingId,
          fileLabel,
          contactId,
          source === 'suggestion_confirmed' ? 'confirmed' : 'manual',
          priorContactId,
          purgedCount
        )

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

        // A merge changes the label set for this diarization run; drop stale embeddings
        // and suggestions so the next panel-open mints a fresh run id and re-matches.
        deleteLabelEmbeddingsForRecording(recordingId)
        expireSuggestionsForRecording(recordingId)

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
   * Clear a label's speaker assignment, returning it to "Unassigned".
   */
  ipcMain.handle(
    'speakers:unassign',
    async (_, request: unknown): Promise<Result<{ recordingId: string; fileLabel: string }>> => {
      try {
        const parsed = UnassignSpeakerSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid speaker unassign request', parsed.error.format())
        }

        const { recordingId, fileLabel } = parsed.data
        // Read prior attribution so callers/UI can react to the contact that was removed.
        getRecordingSpeaker(recordingId, fileLabel)
        deleteRecordingSpeaker(recordingId, fileLabel)
        return success({ recordingId, fileLabel })
      } catch (err) {
        console.error('speakers:unassign error:', err)
        return error('DATABASE_ERROR', 'Failed to unassign speaker', err)
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

  /**
   * Lazy matcher trigger: ensure per-label embeddings exist, run the matcher,
   * then return pending suggestions with resolved contact names. Never throws;
   * a privacy-disabled or failure path simply returns an empty list so the panel
   * never breaks.
   */
  ipcMain.handle(
    'speakers:getSuggestions',
    async (_, recordingId: unknown): Promise<Result<SuggestionView[]>> => {
      try {
        const parsed = GetSuggestionsSchema.safeParse(recordingId)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid recordingId', parsed.error.format())
        }

        const id = parsed.data
        const { diarizationRunId } = await getSuggestionsSequence(id)

        const rows = getPendingSuggestions(id, diarizationRunId)
        const views: SuggestionView[] = rows
          .filter((r): r is Omit<SpeakerSuggestion, 'kind'> & { kind: SuggestionView['kind'] } =>
            r.kind === 'identity' || r.kind === 'merge' || r.kind === 'mixed'
          )
          .map((r) => {
            const contact = r.contact_id ? getContactById(r.contact_id) : undefined
            const contact2 = r.contact_id_2 ? getContactById(r.contact_id_2) : undefined
            return {
              id: r.id,
              kind: r.kind,
              targetLabel: r.target_label ?? '',
              targetLabel2: r.target_label_2 ?? null,
              contactId: r.contact_id ?? null,
              contactName: contact?.name ?? null,
              contactName2: contact2?.name ?? null,
              score: r.score ?? null,
              rank: r.rank ?? null,
              rationale: r.rationale ?? null,
              requiresWarning: getSuggestionRequiresWarning(r)
            }
          })

        return success(views)
      } catch (err) {
        console.error('speakers:getSuggestions error:', err)
        return success([])
      }
    }
  )

  /**
   * Persist a suggestion dismissal (status='dismissed'). A dismissal is scoped to
   * the current diarization run, so a re-transcribe mints a fresh run and stale
   * dismissals never suppress new suggestions.
   */
  ipcMain.handle(
    'speakers:dismissSuggestion',
    async (_, suggestionId: unknown): Promise<Result<{ id: string }>> => {
      try {
        const parsed = SuggestionIdSchema.safeParse(suggestionId)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid suggestion id', parsed.error.format())
        }

        dbDismissSuggestion(parsed.data)
        return success({ id: parsed.data })
      } catch (err) {
        console.error('speakers:dismissSuggestion error:', err)
        return error('DATABASE_ERROR', 'Failed to dismiss suggestion', err)
      }
    }
  )

  /**
   * Mark a suggestion as accepted. The renderer already performed the actual
   * assign/merge; this just resolves the suggestion lifecycle.
   */
  ipcMain.handle(
    'speakers:acceptSuggestion',
    async (_, suggestionId: unknown): Promise<Result<{ id: string }>> => {
      try {
        const parsed = SuggestionIdSchema.safeParse(suggestionId)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid suggestion id', parsed.error.format())
        }

        dbAcceptSuggestion(parsed.data)
        return success({ id: parsed.data })
      } catch (err) {
        console.error('speakers:acceptSuggestion error:', err)
        return error('DATABASE_ERROR', 'Failed to accept suggestion', err)
      }
    }
  )

  /**
   * Mark a label as the current self-contact and bank a self voiceprint.
   * Depends on sub-project A's self-contact primitive; if none exists, the caller
   * is told to create one first.
   */
  ipcMain.handle(
    'speakers:setSelf',
    async (
      _,
      request: unknown
    ): Promise<Result<{ selfAssigned: boolean; needsSelfContact?: boolean; contactId?: string }>> => {
      try {
        const parsed = SetSelfSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid set-self request', parsed.error.format())
        }

        const { recordingId, fileLabel } = parsed.data
        const selfContactId = getSelfContactId()
        if (!selfContactId) {
          return success({ selfAssigned: false, needsSelfContact: true })
        }

        upsertRecordingSpeaker({
          recording_id: recordingId,
          file_label: fileLabel,
          contact_id: selfContactId,
          source: 'confirmed'
        })

        // Bank the self print out-of-band so the IPC returns immediately.
        scheduleCaptureAndNotify(recordingId, fileLabel, selfContactId, 'self')

        return success({ selfAssigned: true, contactId: selfContactId })
      } catch (err) {
        console.error('speakers:setSelf error:', err)
        return error('DATABASE_ERROR', 'Failed to set self speaker', err)
      }
    }
  )
}
