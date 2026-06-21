/**
 * Speaker matcher — orchestrates identity, merge, and mixed suggestions from
 * per-label embeddings and the contact voice library.
 *
 * The only unit that touches the DB; all scoring/clustering/mixed detection is
 * delegated to the pure matcher units.
 */
import { getConfig } from '../config'
import {
  deletePendingSuggestionsForRecording,
  getActiveVoiceprintsByContactId,
  getContactsWithActiveVoiceprints,
  getLabelEmbeddingsForRecording,
  getRecordingById,
  getRecordingSpeaker,
  getSelfContactId,
  getSuggestionsForRecording,
  getTranscriptByRecordingId,
  getWindowEmbeddingsForRecording,
  insertSuggestion,
  replaceWindowEmbeddingsForLabel,
  type WindowEmbeddingRow,
} from '../database'
import {
  decodeRecordingPcm16k,
  embedLabelWindows,
  MAX_EMBED_SPEECH_MS,
  MIN_CLEAN_SPEECH_MS,
  VOICEPRINT_MODEL_ID,
  VOICEPRINT_MODEL_VERSION,
} from '../voiceprint-service'
import { createHash } from 'crypto'
import type { Turn } from '../asr/asr-provider'
import { blobToFloat32 } from './vector-math'
import {
  ContactPrints,
  DEFAULT_THRESHOLDS,
  IdentityResult,
  IdentityScore,
  type MatchThresholds,
  scoreLabelAgainstContacts,
} from './identity-matcher'
import { detectMergeClusters, LabelVec } from './merge-detector'
import { detectMixedLabels, WindowedLabel } from './mixed-detector'
import { applyConflictPolicy } from './conflict-policy'

export interface MatchSummary {
  identity: number
  merge: number
  mixed: number
  skippedModelMismatch: number
}

export interface MatcherResult {
  summary: MatchSummary
  diarizationRunId: string | null
}

/** Window slicing params — MUST mirror sliceLabelWindows() defaults in voiceprint-service.ts
 *  (windowMs=20_000, hopMs=10_000). Folded into the fingerprint so a slicing change invalidates
 *  persisted windows. */
export const WINDOW_SLICE_PARAMS = { windowMs: 20_000, hopMs: 10_000 } as const

/**
 * Per-label content fingerprint — the cache key for persisted window embeddings.
 *
 * Hashes the label's sorted turn time-ranges + the slicing params + model id/version. It
 * changes exactly when the label's windows would differ: turn-membership edits (per-turn
 * reassign, merge), slicing-param changes, or model swaps. NOT keyed by diarization_run_id
 * (a per-turn reassign edits turn membership without minting a new run id).
 */
export function labelTurnsFingerprint(
  turns: Turn[],
  label: string,
  modelId: string,
  modelVersion: number
): string {
  const mine = turns
    .filter((t) => t.speaker === label)
    .map((t) => [t.startMs, t.endMs] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const payload = JSON.stringify([
    mine,
    { windowMs: WINDOW_SLICE_PARAMS.windowMs, hopMs: WINDOW_SLICE_PARAMS.hopMs, maxMs: MAX_EMBED_SPEECH_MS },
    modelId,
    modelVersion,
  ])
  return createHash('sha1').update(payload).digest('hex')
}

/** Float32 embedding → little-endian byte BLOB (4 bytes/element). Copies (slice) so no
 *  external/zero-copy view escapes into the sql.js bind path. */
function windowEmbToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength))
}

/**
 * DB-backed per-window embeddings for the recording's long labels (spec §4).
 *
 * `turns` and `diarizationRunId` are passed in by the caller (runMatcher already parsed/resolved
 * them) so this function performs ZERO redundant DB reads beyond the single window-row read.
 *
 * Each long label's CURRENT content fingerprint is compared to the persisted one. Labels whose
 * fingerprint matches are served from DB (no decode/inference) — including the empty-tombstone
 * case (a single 0-byte sentinel row → a hit that contributes no windows). Any miss triggers ONE
 * decode of the file, re-embeds only the missing labels, and atomically replaces that label's rows
 * via `replaceWindowEmbeddingsForLabel`. A label that genuinely yields zero windows persists a
 * sentinel so it is not re-decoded on every open. Scoring against contacts always re-runs in the
 * caller, so results track the current voiceprint set.
 */
async function getWindowEmbeddings(
  recordingId: string,
  longLabels: string[],
  diarizationRunId: string | null,
  turns: Turn[]
): Promise<WindowedLabel[]> {
  if (longLabels.length === 0) return []

  const transcript = getTranscriptByRecordingId(recordingId)
  const transcriptId = transcript?.id ?? null

  // Current fingerprint per long label (computed from the passed-in turns — no re-read).
  const fpByLabel = new Map<string, string>()
  for (const label of longLabels) {
    fpByLabel.set(label, labelTurnsFingerprint(turns, label, VOICEPRINT_MODEL_ID, VOICEPRINT_MODEL_VERSION))
  }

  // Persisted (non-stale-model) groups, indexed by label.
  const persisted = new Map<string, { fingerprint: string; embeddings: Uint8Array[] }>()
  for (const g of getWindowEmbeddingsForRecording(recordingId, VOICEPRINT_MODEL_ID, VOICEPRINT_MODEL_VERSION)) {
    persisted.set(g.fileLabel, { fingerprint: g.fingerprint, embeddings: g.embeddings })
  }

  const result: WindowedLabel[] = []
  const misses: string[] = []
  for (const label of longLabels) {
    const hit = persisted.get(label)
    if (hit && hit.fingerprint === fpByLabel.get(label)) {
      // Empty tombstone: a single 0-byte sentinel blob → valid empty hit (no windows, no decode).
      const isTombstone = hit.embeddings.length === 1 && hit.embeddings[0].byteLength === 0
      if (isTombstone) {
        // contributes no windows; do NOT push to result, do NOT re-decode.
      } else if (hit.embeddings.length > 0) {
        result.push({ fileLabel: label, windowEmbs: hit.embeddings.map((b) => blobToFloat32(b)) })
      } else {
        misses.push(label)
      }
    } else {
      misses.push(label)
    }
  }

  if (misses.length === 0) return result

  // At least one miss → decode the file ONCE.
  let pcm: Buffer | undefined
  const recording = getRecordingById(recordingId)
  if (recording?.file_path) {
    try {
      pcm = await decodeRecordingPcm16k(recording.file_path)
    } catch (e) {
      console.warn(`[Voiceprint] runMatcher decode failed for ${recordingId}: ${(e as Error).message}`)
    }
  }
  if (!pcm) return result // hits (if any) still usable; misses retried next call (nothing persisted)

  for (const label of misses) {
    const fingerprint = fpByLabel.get(label)!
    try {
      const windowEmbs = await embedLabelWindows(recordingId, label, {
        pcm,
        windowMs: WINDOW_SLICE_PARAMS.windowMs,
        hopMs: WINDOW_SLICE_PARAMS.hopMs,
      })
      if (windowEmbs.length === 0) {
        // Legitimately zero windows → persist a tombstone so we never re-decode this recording
        // for this label/fingerprint again. (Decode succeeded; only the slice/embed produced none.)
        replaceWindowEmbeddingsForLabel(recordingId, label, [
          {
            id: `rwe_${recordingId}_${label}_tomb`,
            recording_id: recordingId,
            transcript_id: transcriptId,
            diarization_run_id: diarizationRunId,
            file_label: label,
            window_index: -1,
            fingerprint,
            model_id: VOICEPRINT_MODEL_ID,
            model_version: VOICEPRINT_MODEL_VERSION,
            dim: 0,
            embedding: new Uint8Array(0),
          },
        ])
        continue // mixed detection skips this label
      }
      const rows: WindowEmbeddingRow[] = windowEmbs.map((emb, i) => ({
        id: `rwe_${recordingId}_${label}_${i}`,
        recording_id: recordingId,
        transcript_id: transcriptId,
        diarization_run_id: diarizationRunId,
        file_label: label,
        window_index: i,
        fingerprint,
        model_id: VOICEPRINT_MODEL_ID,
        model_version: VOICEPRINT_MODEL_VERSION,
        dim: emb.length,
        embedding: windowEmbToBlob(emb),
      }))
      // Atomic replace: delete this label's stale rows + insert the fresh set in ONE transaction.
      replaceWindowEmbeddingsForLabel(recordingId, label, rows)
      result.push({ fileLabel: label, windowEmbs })
    } catch (e) {
      console.warn(
        `[Voiceprint] runMatcher mixed detection skipped for ${label} (${recordingId}): ${(e as Error).message}`
      )
    }
  }
  return result
}

/** Build a suppression key matching conflict-policy.ts suggestionKey(). */
function suggestionKey(
  kind: string,
  targetLabel: string | null | undefined,
  targetLabel2: string | null | undefined,
  contactId: string | null | undefined,
  contactId2?: string | null | undefined
): string {
  return JSON.stringify([
    kind,
    targetLabel ?? '',
    targetLabel2 ?? '',
    contactId ?? '',
    contactId2 ?? '',
  ])
}

/** Resolve matcher thresholds from config, falling back to defaults on model mismatch. */
function getThresholds(): MatchThresholds {
  const cfg = getConfig().voiceMatching as
    | (MatchThresholds & { modelId?: string; calibrated?: boolean })
    | undefined
  if (cfg && cfg.modelId === VOICEPRINT_MODEL_ID) {
    return cfg
  }
  if (cfg && cfg.modelId && cfg.modelId !== VOICEPRINT_MODEL_ID) {
    console.warn(
      `[Voiceprint] voiceMatching modelId mismatch: config=${cfg.modelId} active=${VOICEPRINT_MODEL_ID}; using default thresholds`
    )
  }
  return DEFAULT_THRESHOLDS
}

/** Score every label against the active contact voiceprints. */
function buildContacts(): ContactPrints[] {
  const selfContactId = getSelfContactId()
  const rows = getContactsWithActiveVoiceprints(VOICEPRINT_MODEL_ID)
  return rows
    .map(({ contact_id }) => {
      const prints = getActiveVoiceprintsByContactId(contact_id).filter(
        (p) => p.model_id === VOICEPRINT_MODEL_ID
      )
      return {
        contactId: contact_id,
        isSelf: contact_id === selfContactId,
        prints: prints.map((p) => blobToFloat32(p.embedding)),
        qualities: prints.map((p) => p.quality_score ?? 1.0),
      }
    })
    .filter((c) => c.prints.length > 0)
}

/** Run the matcher for one recording and persist any new suggestions. */
export async function runMatcher(recordingId: string): Promise<MatcherResult> {
  const summary: MatchSummary = {
    identity: 0,
    merge: 0,
    mixed: 0,
    skippedModelMismatch: 0,
  }
  let diarizationRunId: string | null = null

  try {
    // a. Privacy gate.
    if (!getConfig().privacy.enableVoiceprintCapture) {
      return { summary, diarizationRunId: null }
    }

    // b. Load label embeddings, drop stale model rows, resolve run id.
    const allRows = getLabelEmbeddingsForRecording(recordingId)
    const rows = allRows.filter((r) => r.model_id === VOICEPRINT_MODEL_ID)
    summary.skippedModelMismatch = allRows.length - rows.length
    diarizationRunId = rows.length > 0 ? (rows[0].diarization_run_id ?? null) : null
    if (!diarizationRunId) {
      console.log(`[Voiceprint] runMatcher: no diarization_run_id resolved for ${recordingId}`)
    }

    // c. Build contact prints.
    const contacts = buildContacts()

    // d. Identity scoring per label.
    const thresholds = getThresholds()
    const identityByLabel = new Map<string, IdentityResult>()
    for (const row of rows) {
      const result = scoreLabelAgainstContacts(
        blobToFloat32(row.embedding),
        contacts,
        thresholds
      )
      identityByLabel.set(row.file_label, result)
    }

    // e. Merge detection.
    const labelVecs: LabelVec[] = rows.map((r) => ({
      fileLabel: r.file_label,
      emb: blobToFloat32(r.embedding),
      cleanSpeechMs: r.clean_speech_ms ?? 0,
    }))
    const merges = detectMergeClusters(labelVecs, thresholds, identityByLabel)

    // f. Mixed detection. Per-window embeddings are decoded+inferred once and
    // persisted to the DB, keyed by a per-label content fingerprint (turns +
    // slicing params + model); getWindowEmbeddings serves them on a fingerprint
    // hit and recomputes only on miss/change. Scoring against contacts is cheap
    // and re-runs here every call so suggestions reflect the current voiceprint set.
    const longLabels = rows
      .filter((r) => (r.clean_speech_ms ?? 0) >= 2 * MIN_CLEAN_SPEECH_MS)
      .map((r) => r.file_label)

    // Window/mixed detection needs the diarized turns; parse once and reuse (the fingerprint is
    // computed from them). diarizationRunId was already resolved in step b.
    const wTranscript = getTranscriptByRecordingId(recordingId)
    let wTurns: Turn[] = []
    try {
      wTurns = wTranscript?.turns ? (JSON.parse(wTranscript.turns) as Turn[]) : []
    } catch {
      wTurns = []
    }
    const windowed = await getWindowEmbeddings(recordingId, longLabels, diarizationRunId, wTurns)

    const perWindowIdentity = new Map<string, IdentityScore[][]>()
    for (const w of windowed) {
      perWindowIdentity.set(
        w.fileLabel,
        w.windowEmbs.map((emb) => scoreLabelAgainstContacts(emb, contacts, thresholds).candidates)
      )
    }
    const mixed = detectMixedLabels(windowed, perWindowIdentity, thresholds)

    // g. Existing manual/confirmed assignments.
    const existingAssignments = new Map<string, { contactId: string; source: string }>()
    for (const row of rows) {
      const rs = getRecordingSpeaker(recordingId, row.file_label)
      if (rs?.contact_id) {
        existingAssignments.set(row.file_label, { contactId: rs.contact_id, source: rs.source })
      }
    }

    // h. Suppress same-run dismissed/accepted keys.
    const priorSuggestions = getSuggestionsForRecording(recordingId, diarizationRunId).filter(
      (s) => s.diarization_run_id === diarizationRunId
    )
    const dismissedKeys = new Set<string>()
    for (const s of priorSuggestions) {
      if (s.status === 'dismissed' || s.status === 'accepted') {
        dismissedKeys.add(
          suggestionKey(s.kind, s.target_label, s.target_label_2, s.contact_id, s.contact_id_2)
        )
      }
    }

    // i. Conflict policy.
    const identities = rows.map((r) => ({
      fileLabel: r.file_label,
      result: identityByLabel.get(r.file_label)!,
      cleanSpeechMs: r.clean_speech_ms ?? 0,
    }))
    const selfContactId = getSelfContactId()
    const policyOut = applyConflictPolicy({
      recordingId,
      diarizationRunId,
      identities,
      merges,
      mixed,
      existingAssignments,
      dismissedKeys,
      selfContactId,
    })
    const { suggestions: newSuggestions } = policyOut

    // j. Delete prior pending suggestions for this run.
    deletePendingSuggestionsForRecording(recordingId, diarizationRunId)

    // k. Insert new suggestions with deterministic ids.
    const runIdOrNorun = diarizationRunId ?? 'norun'
    for (const s of newSuggestions) {
      const extra =
        s.kind === 'identity'
          ? s.contactId ?? ''
          : s.kind === 'merge'
            ? (s.targetLabel2 ?? '')
            : ''
      const id = `vmsug_${recordingId}_${runIdOrNorun}_${s.kind}_${s.targetLabel}_${extra}`
      insertSuggestion({
        id,
        recording_id: recordingId,
        transcript_id: null,
        diarization_run_id: diarizationRunId,
        kind: s.kind,
        target_label: s.targetLabel,
        target_label_2: s.targetLabel2 ?? null,
        contact_id: s.contactId ?? null,
        contact_id_2: s.contactId2 ?? null,
        score: s.score,
        rank: s.rank,
        rationale: s.rationale,
        status: 'pending',
      })
      if (s.kind === 'identity') summary.identity++
      else if (s.kind === 'merge') summary.merge++
      else if (s.kind === 'mixed') summary.mixed++
    }

    return { summary, diarizationRunId }
  } catch (e) {
    console.error(`[Voiceprint] runMatcher failed for ${recordingId}: ${(e as Error).message}`)
    return { summary, diarizationRunId: null }
  }
}
