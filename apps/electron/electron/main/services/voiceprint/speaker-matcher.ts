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

    // f. Mixed detection.
    const windowed: WindowedLabel[] = []
    const perWindowIdentity = new Map<string, IdentityScore[][]>()
    const longLabels = rows
      .filter((r) => (r.clean_speech_ms ?? 0) >= 2 * MIN_CLEAN_SPEECH_MS)
      .map((r) => r.file_label)

    if (longLabels.length > 0) {
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

            const perWindow: IdentityScore[][] = []
            for (const emb of windowEmbs) {
              perWindow.push(
                scoreLabelAgainstContacts(emb, contacts, thresholds).candidates
              )
            }
            perWindowIdentity.set(label, perWindow)
          } catch (e) {
            console.warn(
              `[Voiceprint] runMatcher mixed detection skipped for ${label} (${recordingId}): ${(e as Error).message}`
            )
          }
        }
      }
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
