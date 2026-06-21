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
  insertSuggestion,
} from '../database'
import {
  decodeRecordingPcm16k,
  embedLabelWindows,
  MIN_CLEAN_SPEECH_MS,
  VOICEPRINT_MODEL_ID,
} from '../voiceprint-service'
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

/**
 * Cache of per-window ERes2Net embeddings used by mixed detection, keyed by
 * (recordingId, diarizationRunId). These embeddings are INVARIANT for a given
 * recording + diarization run — computing them requires a full ffmpeg decode of
 * the (300+ MB) file plus serial model inference per 20s window, which made
 * speakers:getSuggestions take 30–60s on EVERY call. We compute them once and
 * reuse; identity scoring against the contact voice library is cheap and still
 * re-runs each call, so results reflect the current voiceprint set.
 *
 * A new diarization run (re-transcribe / merge) yields a new key → fresh compute.
 * In-memory only (re-embeds once per recording per app session); bounded to cap
 * memory. Cleared explicitly when a recording's label embeddings are invalidated.
 */
const WINDOW_EMB_CACHE = new Map<string, WindowedLabel[]>()
const WINDOW_EMB_CACHE_MAX = 32

function windowCacheKey(recordingId: string, diarizationRunId: string | null): string {
  return `${recordingId}::${diarizationRunId ?? 'norun'}`
}

/** Drop cached window embeddings for a recording (call when its embeddings change). */
export function invalidateWindowEmbeddings(recordingId: string): void {
  for (const key of [...WINDOW_EMB_CACHE.keys()]) {
    if (key.startsWith(`${recordingId}::`)) WINDOW_EMB_CACHE.delete(key)
  }
}

/** Test-only: clear the entire window-embedding cache. */
export function __clearWindowEmbeddingCache(): void {
  WINDOW_EMB_CACHE.clear()
}

/**
 * Obtain per-window embeddings for the recording's "long" labels, decoding +
 * embedding once per (recording, run) and serving cache hits thereafter.
 */
async function getWindowEmbeddings(
  recordingId: string,
  diarizationRunId: string | null,
  longLabels: string[]
): Promise<WindowedLabel[]> {
  if (longLabels.length === 0) return []

  const key = windowCacheKey(recordingId, diarizationRunId)
  const cached = WINDOW_EMB_CACHE.get(key)
  if (cached && longLabels.every((l) => cached.some((w) => w.fileLabel === l))) {
    return cached
  }

  const windowed: WindowedLabel[] = []
  const recording = getRecordingById(recordingId)
  let pcm: Buffer | undefined
  if (recording?.file_path) {
    try {
      pcm = await decodeRecordingPcm16k(recording.file_path)
    } catch (e) {
      console.warn(
        `[Voiceprint] runMatcher decode failed for ${recordingId}: ${(e as Error).message}`
      )
    }
  }

  if (pcm) {
    for (const label of longLabels) {
      try {
        const windowEmbs = await embedLabelWindows(recordingId, label, { pcm })
        if (windowEmbs.length === 0) continue
        windowed.push({ fileLabel: label, windowEmbs })
      } catch (e) {
        console.warn(
          `[Voiceprint] runMatcher mixed detection skipped for ${label} (${recordingId}): ${(e as Error).message}`
        )
      }
    }
  }

  // Only cache a real result (decode succeeded and produced embeddings) so a
  // transient decode failure is retried next call rather than cached as empty.
  if (windowed.length > 0) {
    if (WINDOW_EMB_CACHE.size >= WINDOW_EMB_CACHE_MAX) {
      const oldest = WINDOW_EMB_CACHE.keys().next().value
      if (oldest !== undefined) WINDOW_EMB_CACHE.delete(oldest)
    }
    WINDOW_EMB_CACHE.set(key, windowed)
  }
  return windowed
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

    // f. Mixed detection. Per-window embeddings are decoded+inferred once per
    // (recording, run) and cached; scoring against contacts is cheap and re-runs
    // here every call so suggestions reflect the current voiceprint set.
    const longLabels = rows
      .filter((r) => (r.clean_speech_ms ?? 0) >= 2 * MIN_CLEAN_SPEECH_MS)
      .map((r) => r.file_label)

    const windowed = await getWindowEmbeddings(recordingId, diarizationRunId, longLabels)

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
