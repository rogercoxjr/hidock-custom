/**
 * Conflict policy — apply rev-2 §15 hierarchy before suggestions are persisted.
 *
 * Pure code: filters and annotates suggestions.
 */
import type { IdentityResult, IdentityScore } from './identity-matcher'
import type { MergeCluster } from './merge-detector'
import type { MixedFlag } from './mixed-detector'

export type SuggestionKind = 'identity' | 'merge' | 'mixed'

export interface NewSuggestion {
  id: string
  recordingId: string
  diarizationRunId: string | null
  kind: SuggestionKind
  targetLabel: string
  targetLabel2?: string | null
  contactId?: string | null
  contactId2?: string | null
  score: number | null
  rank: number
  rationale: string
  requiresWarning: boolean
}

export interface PolicyInput {
  recordingId: string
  diarizationRunId: string | null
  identities: Array<{ fileLabel: string; result: IdentityResult; cleanSpeechMs?: number }>
  merges: MergeCluster[]
  mixed: MixedFlag[]
  existingAssignments: Map<string, { contactId: string; source: string }>
  dismissedKeys: Set<string>
  selfContactId: string | null
}

export interface PreparedSuggestions {
  suggestions: NewSuggestion[]
}

function suggestionKey(s: NewSuggestion): string {
  return JSON.stringify([
    s.kind,
    s.targetLabel,
    s.targetLabel2 ?? '',
    s.contactId ?? '',
    s.contactId2 ?? '',
  ])
}

/** Build an identity suggestion, tagged "strong" or "likely". */
function makeIdentity(
  input: PolicyInput,
  fileLabel: string,
  score: IdentityScore,
  rationale: string,
  rank: number
): NewSuggestion {
  return {
    id: '',
    recordingId: input.recordingId,
    diarizationRunId: input.diarizationRunId,
    kind: 'identity',
    targetLabel: fileLabel,
    contactId: score.contactId,
    score: score.score,
    rank,
    rationale,
    requiresWarning: false,
  }
}

export function applyConflictPolicy(input: PolicyInput): PreparedSuggestions {
  const suggestions: NewSuggestion[] = []
  const addedKeys = new Set<string>()

  const push = (s: NewSuggestion): void => {
    const key = suggestionKey(s)
    if (input.dismissedKeys.has(key) || addedKeys.has(key)) return
    addedKeys.add(key)
    suggestions.push(s)
  }

  // ---------------------------------------------------------------------------
  // Rule 5: multiple labels strongly matching self → single self-merge suggestion.
  // ---------------------------------------------------------------------------
  const selfLabels: string[] = []
  for (const { fileLabel, result } of input.identities) {
    if (
      result.decision === 'strong' &&
      result.best &&
      result.best.contactId === input.selfContactId
    ) {
      selfLabels.push(fileLabel)
    }
  }

  if (selfLabels.length >= 2) {
    // Representative = longest clean speech label (fallback: first).
    const representative = selfLabels.reduce((best, label) => {
      const bestMs = input.identities.find((i) => i.fileLabel === best)?.cleanSpeechMs ?? 0
      const labelMs = input.identities.find((i) => i.fileLabel === label)?.cleanSpeechMs ?? 0
      return labelMs > bestMs ? label : best
    }, selfLabels[0])

    // Pairwise self-merge chips: representative -> each other label.
    for (const other of selfLabels.filter((l) => l !== representative)) {
      push({
        id: '',
        recordingId: input.recordingId,
        diarizationRunId: input.diarizationRunId,
        kind: 'merge',
        targetLabel: representative,
        targetLabel2: other,
        contactId: input.selfContactId,
        score: null,
        rank: 3,
        rationale: 'multiple labels appear to be you',
        requiresWarning: false,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Rule 1/2: identity suggestions.
  // ---------------------------------------------------------------------------
  for (const { fileLabel, result } of input.identities) {
    if (!result.best) continue

    const assigned = input.existingAssignments.get(fileLabel)
    const assignedContactId = assigned?.contactId
    const assignedSource = assigned?.source

    // Rule 1: manual assignment wins — no identity suggestion.
    if (assignedSource === 'user') continue

    // Self labels already handled by the self-merge rule above.
    if (result.best.contactId === input.selfContactId && selfLabels.length >= 2) continue

    const baseRationale = result.decision === 'strong' ? 'strong match' : 'likely match'

    if (assignedSource === 'confirmed' || assignedSource === 'suggestion_confirmed') {
      // Rule 2: confirmed > provisional. Only emit a low-rank "looks more like X" if the new top
      // differs and is strong.
      if (
        assignedContactId !== result.best.contactId &&
        result.decision === 'strong'
      ) {
        push(
          makeIdentity(input, fileLabel, result.best, `looks more like ${result.best.contactId}`, 5)
        )
      }
      continue
    }

    // Normal identity suggestion.
    if (result.decision === 'strong' || result.decision === 'suggest') {
      push(makeIdentity(input, fileLabel, result.best, baseRationale, result.decision === 'strong' ? 1 : 2))
    }
  }

  // ---------------------------------------------------------------------------
  // Rule 3: cross-contact merge warning. Emit pairwise chips so every merge is
  // a single representative -> one other label and therefore confirmable.
  // ---------------------------------------------------------------------------
  for (const cluster of input.merges) {
    const assignedContacts = new Set<string | undefined>()
    for (const label of cluster.labels) {
      const a = input.existingAssignments.get(label)
      if (a?.contactId) assignedContacts.add(a.contactId)
    }
    const requiresWarning = assignedContacts.size >= 2
    const contactList = Array.from(assignedContacts).filter(Boolean) as string[]

    for (const other of cluster.labels.filter((l) => l !== cluster.representative)) {
      const otherContact = input.existingAssignments.get(other)?.contactId
      const representativeContact = input.existingAssignments.get(cluster.representative)?.contactId
      const contactId2 =
        requiresWarning && representativeContact && otherContact && representativeContact !== otherContact
          ? otherContact
          : null

      push({
        id: '',
        recordingId: input.recordingId,
        diarizationRunId: input.diarizationRunId,
        kind: 'merge',
        targetLabel: cluster.representative,
        targetLabel2: other,
        contactId: representativeContact ?? null,
        contactId2,
        score: cluster.minPairCosine,
        rank: 3,
        rationale: requiresWarning
          ? `merges ${contactList.join(' and ')}`
          : 'may be the same voice',
        requiresWarning,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Mixed flags (informational, no confirm in Phase 3-4).
  // ---------------------------------------------------------------------------
  for (const flag of input.mixed) {
    push({
      id: '',
      recordingId: input.recordingId,
      diarizationRunId: input.diarizationRunId,
      kind: 'mixed',
      targetLabel: flag.fileLabel,
      score: flag.dispersion,
      rank: 4,
      rationale:
        flag.reason === 'two-contact'
          ? `may contain two voices (${flag.contactA ?? '?'}/${flag.contactB ?? '?'})`
          : 'may contain two voices',
      requiresWarning: false,
    })
  }

  return { suggestions }
}
