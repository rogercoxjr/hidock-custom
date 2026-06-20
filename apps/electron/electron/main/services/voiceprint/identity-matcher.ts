/**
 * Identity matcher — label→contact scoring with print+centroid hybrid.
 *
 * Pure code: caller passes ContactPrints; returns IdentityResult.
 */
import { centroid, cosine, l2Normalize } from './vector-math'

const DEFAULT_Q = 1.0
const MIN_Q = 0.1

export interface MatchThresholds {
  matchSuggest: number
  matchAuto: number
  matchMargin: number
  mergeThreshold: number
  mixedDispersion: number
  centroidOutlier: number
  bankConsistency: number
  maxMergeSuggestions: number
}

export const DEFAULT_THRESHOLDS: MatchThresholds = {
  matchSuggest: 0.42,
  matchAuto: 0.55,
  matchMargin: 0.06,
  mergeThreshold: 0.62,
  mixedDispersion: 0.35,
  centroidOutlier: 0.25,
  bankConsistency: 0.35,
  maxMergeSuggestions: 5,
}

export interface ContactPrints {
  contactId: string
  isSelf: boolean
  prints: Float32Array[]
  qualities: number[]
}

export interface IdentityScore {
  contactId: string
  score: number
  viaCentroid: boolean
}

export interface IdentityResult {
  candidates: IdentityScore[]
  best?: IdentityScore
  secondBest?: IdentityScore
  margin: number
  decision: 'strong' | 'suggest' | 'none'
}

function clampQuality(q: number | undefined): number {
  const raw = q ?? DEFAULT_Q
  return Math.max(MIN_Q, Math.min(1, raw))
}

/** Score one label embedding against every contact. */
export function scoreLabelAgainstContacts(
  labelEmb: Float32Array,
  contacts: ContactPrints[],
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS
): IdentityResult {
  const normalizedLabel = l2Normalize(labelEmb)
  const candidates: IdentityScore[] = []

  for (const contact of contacts) {
    if (contact.prints.length === 0) continue

    // Compute the contact centroid, excluding prints that are outliers to it.
    const contactCentroid = centroid(contact.prints)
    const nonOutlierPrints: Float32Array[] = []
    for (const p of contact.prints) {
      if (cosine(p, contactCentroid) >= thresholds.centroidOutlier) {
        nonOutlierPrints.push(p)
      }
    }

    const centroidBasis = nonOutlierPrints.length === 0 ? contact.prints : nonOutlierPrints
    const centroidScore = cosine(normalizedLabel, centroid(centroidBasis))

    let bestEffectivePrintScore = -Infinity
    for (let i = 0; i < contact.prints.length; i++) {
      const printScore = cosine(normalizedLabel, contact.prints[i])
      const q = clampQuality(contact.qualities[i])
      const effective = printScore * (0.7 + 0.3 * q)
      if (effective > bestEffectivePrintScore) {
        bestEffectivePrintScore = effective
      }
    }

    const viaCentroid = centroidScore >= bestEffectivePrintScore
    const score = viaCentroid ? centroidScore : bestEffectivePrintScore
    candidates.push({ contactId: contact.contactId, score, viaCentroid })
  }

  candidates.sort((a, b) => b.score - a.score)

  const best = candidates[0]
  const secondBest = candidates[1]
  const margin = best ? best.score - (secondBest?.score ?? 0) : 0

  let decision: IdentityResult['decision'] = 'none'
  if (best && margin >= thresholds.matchMargin) {
    if (best.score >= thresholds.matchAuto) {
      decision = 'strong'
    } else if (best.score >= thresholds.matchSuggest) {
      decision = 'suggest'
    }
  }

  return { candidates, best, secondBest, margin, decision }
}
