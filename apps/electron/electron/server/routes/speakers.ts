import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  getRecordingById,
  getRecordingSpeakers,
  getRecordingSpeaker,
  upsertRecordingSpeaker,
  deleteRecordingSpeaker,
  getContactById,
  getTranscriptByRecordingId,
  updateTranscriptTurns,
  deleteVoiceprintsBySource,
  getPendingSuggestions,
  getSelfContactId,
  deleteLabelEmbeddingsForRecording,
  deleteWindowEmbeddingsForRecording,
  expireSuggestionsForRecording,
  acceptSuggestion as dbAcceptSuggestion,
  dismissSuggestion as dbDismissSuggestion,
  type SpeakerSuggestion
} from '../../main/services/database'
// voiceprint-service + speaker-matcher are imported DYNAMICALLY inside the
// handlers below (not statically) so the hosted server bundle doesn't pull their
// transitive `electron` imports (utilityProcess embedding worker, app.getAppPath)
// into the plain-Node boot graph. esbuild splits them into a lazy chunk; under
// plain Node the dynamic import rejects (electron absent) and voiceprint
// capture/matching degrades gracefully — a Phase-2 feature unavailable in hosted
// mode. The type is import-type-only (erased at build).
import type { MatcherResult } from '../../main/services/voiceprint/speaker-matcher'
import type { Turn } from '../../main/services/asr/asr-provider'
import { NotFoundError, BadRequestError } from './_errors'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const assignBody = z.object({
  contactId: z.string().min(1),
  source: z
    .enum(['user', 'confirmed', 'suggestion_confirmed'])
    .optional()
    .default('user')
})

const mergeBody = z
  .object({
    fromLabel: z.string().min(1),
    toLabel: z.string().min(1)
  })
  .refine((d) => d.fromLabel !== d.toLabel, { message: 'fromLabel and toLabel must differ' })

const ReassignTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existingLabel'), label: z.string().min(1) }),
  z.object({ kind: z.literal('contact'), contactId: z.string().min(1) }),
  z.object({ kind: z.literal('newSpeaker') })
])

const reassignBody = z.object({
  sourceLabel: z.string().min(1),
  anchorIndex: z.number().int().min(0),
  anchorStartMs: z.number(),
  scope: z.enum(['one', 'before', 'after']),
  target: ReassignTargetSchema
})

// ---------------------------------------------------------------------------
// Helpers (ported from speakers-handlers.ts, no ipcMain dependency)
// ---------------------------------------------------------------------------

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

/**
 * Next unused single uppercase letter for a recording's speaker labels.
 * Returns 'A' when nothing is used, null when 'Z' is already in use.
 */
function nextUnusedLetter(usedLabels: string[]): string | null {
  const A = 'A'.charCodeAt(0)
  const Z = 'Z'.charCodeAt(0)
  let highest = -1
  for (const raw of usedLabels) {
    const label = (raw ?? '').trim().toUpperCase()
    if (label.length !== 1) continue
    const code = label.charCodeAt(0)
    if (code < A || code > Z) continue
    if (code > highest) highest = code
  }
  if (highest === -1) return 'A'
  if (highest >= Z) return null
  return String.fromCharCode(highest + 1)
}

/** Derive the requiresWarning flag from a persisted suggestion row. */
function getSuggestionRequiresWarning(row: SpeakerSuggestion): boolean {
  const r = row.rationale ?? ''
  if (r.includes('requiresWarning')) return true
  if (row.kind === 'merge' && r.startsWith('merges ') && r.includes(' and ')) return true
  return false
}

/**
 * Per-recording single-flight for the expensive getSuggestions compute.
 * Deduplicates concurrent requests for the same recording.
 */
const getSuggestionsInFlight = new Map<string, Promise<MatcherResult>>()

function getSuggestionsSequence(recordingId: string): Promise<MatcherResult> {
  const existing = getSuggestionsInFlight.get(recordingId)
  if (existing) return existing
  const p = (async (): Promise<MatcherResult> => {
    const { embedRecordingLabels } = await import('../../main/services/voiceprint-service')
    const { runMatcher } = await import('../../main/services/voiceprint/speaker-matcher')
    await embedRecordingLabels(recordingId)
    return (await runMatcher(recordingId)) as MatcherResult
  })()
  getSuggestionsInFlight.set(recordingId, p)
  p.finally(() => {
    if (getSuggestionsInFlight.get(recordingId) === p) getSuggestionsInFlight.delete(recordingId)
  }).catch(() => { /* rejection surfaced to awaiters */ })
  return p
}

/** Schedule a voiceprint capture out-of-band (fire and forget). */
function scheduleCaptureAndNotify(
  recordingId: string,
  fileLabel: string,
  contactId: string,
  createdFrom: 'manual' | 'confirmed' | 'self',
  priorContactId?: string | null,
  purgedCount?: number
): void {
  void priorContactId
  void purgedCount
  setImmediate(() => {
    void (async () => {
      try {
        const { captureVoiceprint } = await import('../../main/services/voiceprint-service')
        await captureVoiceprint(recordingId, fileLabel, contactId, createdFrom)
      } catch (e) {
        console.warn(`[Voiceprint] capture error (${recordingId}/${fileLabel}): ${(e as Error).message}`)
      }
    })()
  })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function registerSpeakers(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/recordings/:id/speakers
   * Returns the label→contact mapping as { [label]: { contactId, contactName } }.
   */
  app.get('/api/recordings/:id/speakers', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')

    const rows = getRecordingSpeakers(id)
    const map: Record<string, { contactId: string; contactName: string }> = {}
    for (const row of rows) {
      if (!row.contact_id) continue
      const contact = getContactById(row.contact_id)
      if (!contact) continue
      map[row.file_label] = { contactId: row.contact_id, contactName: contact.name }
    }
    return map
  })

  /**
   * PUT /api/recordings/:id/speakers/:fileLabel
   * Assign (or reassign) a contact to a speaker label.
   * Body: { contactId, source? }
   */
  app.put(
    '/api/recordings/:id/speakers/:fileLabel',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id, fileLabel } = req.params as { id: string; fileLabel: string }
      const rec = getRecordingById(id)
      if (!rec) throw new NotFoundError('recording not found')

      const body = assignBody.parse(req.body)
      const { contactId, source } = body

      const contact = getContactById(contactId)
      if (!contact) throw new NotFoundError(`contact not found: ${contactId}`)

      const prior = getRecordingSpeaker(id, fileLabel)
      const priorContactId = prior?.contact_id ?? null

      upsertRecordingSpeaker({ recording_id: id, file_label: fileLabel, contact_id: contactId, source })

      let purgedCount = 0
      if (priorContactId && priorContactId !== contactId) {
        purgedCount = deleteVoiceprintsBySource(id, fileLabel, priorContactId)
      }

      scheduleCaptureAndNotify(
        id,
        fileLabel,
        contactId,
        source === 'suggestion_confirmed' ? 'confirmed' : 'manual',
        priorContactId,
        purgedCount
      )

      return { recordingId: id, fileLabel, contactId }
    }
  )

  /**
   * DELETE /api/recordings/:id/speakers/:fileLabel
   * Unassign (clear) a speaker label's contact mapping.
   */
  app.delete(
    '/api/recordings/:id/speakers/:fileLabel',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id, fileLabel } = req.params as { id: string; fileLabel: string }
      const rec = getRecordingById(id)
      if (!rec) throw new NotFoundError('recording not found')

      deleteRecordingSpeaker(id, fileLabel)
      return { recordingId: id, fileLabel }
    }
  )

  /**
   * POST /api/recordings/:id/speakers/merge
   * Merge fromLabel into toLabel (rewrites turns + roster).
   * Body: { fromLabel, toLabel }
   */
  app.post(
    '/api/recordings/:id/speakers/merge',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      const rec = getRecordingById(id)
      if (!rec) throw new NotFoundError('recording not found')

      const body = mergeBody.parse(req.body)
      const { fromLabel, toLabel } = body

      const transcript = getTranscriptByRecordingId(id)
      const turns = parseTurns(transcript?.turns)
      if (turns.length === 0) throw new NotFoundError(`no diarized turns found for recording ${id}`)

      // 1. Rewrite turns
      const rewritten = turns.map((t) => (t.speaker === fromLabel ? { ...t, speaker: toLabel } : t))
      updateTranscriptTurns(id, rewritten)

      // 2. Invalidate embeddings + suggestions
      deleteLabelEmbeddingsForRecording(id)
      deleteWindowEmbeddingsForRecording(id)
      getSuggestionsInFlight.delete(id)
      expireSuggestionsForRecording(id)

      // 3. Carry fromLabel's mapping onto toLabel if toLabel has no row
      const rows = getRecordingSpeakers(id)
      const toRow = rows.find((r) => r.file_label === toLabel)
      const fromRow = rows.find((r) => r.file_label === fromLabel)
      if (!toRow && fromRow) {
        upsertRecordingSpeaker({
          recording_id: id,
          file_label: toLabel,
          contact_id: fromRow.contact_id,
          confidence: fromRow.confidence,
          source: 'user'
        })
      }

      // 4. Remove orphaned fromLabel row
      deleteRecordingSpeaker(id, fromLabel)

      return { recordingId: id, fromLabel, toLabel, turns: rewritten }
    }
  )

  /**
   * POST /api/recordings/:id/speakers/reassign
   * Reassign a scoped set of a speaker's turns to a target.
   * Body: { sourceLabel, anchorIndex, anchorStartMs, scope, target }
   */
  app.post(
    '/api/recordings/:id/speakers/reassign',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      const rec = getRecordingById(id)
      if (!rec) throw new NotFoundError('recording not found')

      const body = reassignBody.parse(req.body)
      const { sourceLabel, anchorIndex, anchorStartMs, scope, target } = body

      const transcript = getTranscriptByRecordingId(id)
      const turns = parseTurns(transcript?.turns)
      if (turns.length === 0) throw new NotFoundError(`no diarized turns found for recording ${id}`)

      // 1. Stale-anchor guard
      const anchor = turns[anchorIndex]
      if (!anchor || anchor.startMs !== anchorStartMs || anchor.speaker !== sourceLabel) {
        throw new BadRequestError('stale turns; refresh and retry')
      }

      // 2. Resolve target letter
      const rows = getRecordingSpeakers(id)
      const usedLabels = [...new Set([...turns.map((t) => t.speaker), ...rows.map((r) => r.file_label)])]
      let targetLabel: string
      if (target.kind === 'existingLabel') {
        targetLabel = target.label
      } else if (target.kind === 'contact') {
        const contact = getContactById(target.contactId)
        if (!contact) throw new NotFoundError(`contact not found: ${target.contactId}`)
        const existing = rows.find((r) => r.contact_id === target.contactId)
        if (existing) {
          targetLabel = existing.file_label
        } else {
          const minted = nextUnusedLetter(usedLabels)
          if (!minted) throw new BadRequestError('no unused speaker letters remain (Z in use)')
          targetLabel = minted
          upsertRecordingSpeaker({ recording_id: id, file_label: targetLabel, contact_id: target.contactId, source: 'user' })
          scheduleCaptureAndNotify(id, targetLabel, target.contactId, 'manual')
        }
      } else {
        const minted = nextUnusedLetter(usedLabels)
        if (!minted) throw new BadRequestError('no unused speaker letters remain (Z in use)')
        targetLabel = minted
      }

      // 3. Rewrite scoped turns
      let rewrittenCount = 0
      const rewritten = turns.map((t, i) => {
        if (t.speaker !== sourceLabel) return t
        const inScope =
          scope === 'one' ? i === anchorIndex : scope === 'before' ? i <= anchorIndex : i >= anchorIndex
        if (!inScope) return t
        rewrittenCount += 1
        return { ...t, speaker: targetLabel }
      })

      // 4. Persist + invalidate
      updateTranscriptTurns(id, rewritten)
      deleteLabelEmbeddingsForRecording(id)
      deleteWindowEmbeddingsForRecording(id)
      getSuggestionsInFlight.delete(id)
      expireSuggestionsForRecording(id)

      // 5. Orphan cleanup
      const sourceStillUsed = rewritten.some((t) => t.speaker === sourceLabel)
      if (!sourceStillUsed) {
        deleteRecordingSpeaker(id, sourceLabel)
      }

      return { recordingId: id, targetLabel, rewrittenCount }
    }
  )

  /**
   * POST /api/recordings/:id/speakers/:fileLabel/set-self
   * Mark a label as the current user's self-contact and bank a voiceprint.
   */
  app.post(
    '/api/recordings/:id/speakers/:fileLabel/set-self',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id, fileLabel } = req.params as { id: string; fileLabel: string }
      const rec = getRecordingById(id)
      if (!rec) throw new NotFoundError('recording not found')

      const selfContactId = getSelfContactId()
      if (!selfContactId) {
        return { selfAssigned: false, needsSelfContact: true }
      }

      upsertRecordingSpeaker({ recording_id: id, file_label: fileLabel, contact_id: selfContactId, source: 'confirmed' })
      scheduleCaptureAndNotify(id, fileLabel, selfContactId, 'self')

      return { selfAssigned: true, contactId: selfContactId }
    }
  )

  /**
   * GET /api/recordings/:id/speaker-suggestions
   * Run the matcher (lazily) and return pending suggestions with contact names.
   * Never throws — returns [] on any failure (mirrors IPC handler).
   */
  app.get('/api/recordings/:id/speaker-suggestions', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')

    try {
      const { diarizationRunId } = await getSuggestionsSequence(id)
      const rows = getPendingSuggestions(id, diarizationRunId)
      const views: SuggestionView[] = rows
        .filter(
          (r): r is Omit<SpeakerSuggestion, 'kind'> & { kind: SuggestionView['kind'] } =>
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
      return views
    } catch {
      return []
    }
  })

  /**
   * POST /api/speaker-suggestions/:suggestionId/dismiss
   * Mark a suggestion as dismissed.
   */
  app.post(
    '/api/speaker-suggestions/:suggestionId/dismiss',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { suggestionId } = req.params as { suggestionId: string }
      dbDismissSuggestion(suggestionId)
      return { id: suggestionId }
    }
  )

  /**
   * POST /api/speaker-suggestions/:suggestionId/accept
   * Mark a suggestion as accepted (the renderer already performed the assign/merge).
   */
  app.post(
    '/api/speaker-suggestions/:suggestionId/accept',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { suggestionId } = req.params as { suggestionId: string }
      dbAcceptSuggestion(suggestionId)
      return { id: suggestionId }
    }
  )
}
