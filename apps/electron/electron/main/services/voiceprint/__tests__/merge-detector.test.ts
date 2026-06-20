import { describe, it, expect } from 'vitest'
import { detectMergeClusters, type LabelVec } from '../merge-detector'
import { DEFAULT_THRESHOLDS, type IdentityResult } from '../identity-matcher'
import { l2Normalize } from '../vector-math'

function vec(...values: number[]): Float32Array {
  return l2Normalize(Float32Array.from(values))
}

describe('detectMergeClusters', () => {
  it('returns empty for fewer than 2 labels', () => {
    expect(detectMergeClusters([{ fileLabel: 'A', emb: vec(1, 0, 0) }], DEFAULT_THRESHOLDS, new Map())).toEqual([])
  })

  it('clusters two very similar labels', () => {
    const labels: LabelVec[] = [
      { fileLabel: 'A', emb: vec(1, 0, 0) },
      { fileLabel: 'B', emb: vec(1, 0.01, 0) },
    ]
    const result = detectMergeClusters(labels, DEFAULT_THRESHOLDS, new Map())
    expect(result).toHaveLength(1)
    expect(result[0].labels.sort()).toEqual(['A', 'B'])
    expect(result[0].minPairCosine).toBeGreaterThan(DEFAULT_THRESHOLDS.mergeThreshold)
  })

  it('does not cluster labels below the merge threshold', () => {
    const labels: LabelVec[] = [
      { fileLabel: 'A', emb: vec(1, 0, 0) },
      { fileLabel: 'B', emb: vec(0, 1, 0) },
    ]
    expect(detectMergeClusters(labels, DEFAULT_THRESHOLDS, new Map())).toEqual([])
  })

  it('splits a cluster when strong identities point at different contacts (AC10)', () => {
    // A and B are acoustically close but the matcher is strongly confident they are different contacts.
    const labels: LabelVec[] = [
      { fileLabel: 'A', emb: vec(1, 0, 0) },
      { fileLabel: 'B', emb: vec(1, 0.01, 0) },
    ]
    const identityByLabel = new Map<string, IdentityResult>()
    identityByLabel.set('A', {
      candidates: [{ contactId: 'Robyn', score: 0.9, viaCentroid: true }],
      best: { contactId: 'Robyn', score: 0.9, viaCentroid: true },
      margin: 0.2,
      decision: 'strong',
    })
    identityByLabel.set('B', {
      candidates: [{ contactId: 'Tiffany', score: 0.9, viaCentroid: true }],
      best: { contactId: 'Tiffany', score: 0.9, viaCentroid: true },
      margin: 0.2,
      decision: 'strong',
    })
    expect(detectMergeClusters(labels, DEFAULT_THRESHOLDS, identityByLabel)).toEqual([])
  })

  it('keeps the edge when only one side has a strong identity', () => {
    const labels: LabelVec[] = [
      { fileLabel: 'A', emb: vec(1, 0, 0) },
      { fileLabel: 'B', emb: vec(1, 0.01, 0) },
    ]
    const identityByLabel = new Map<string, IdentityResult>()
    identityByLabel.set('A', {
      candidates: [{ contactId: 'Robyn', score: 0.9, viaCentroid: true }],
      best: { contactId: 'Robyn', score: 0.9, viaCentroid: true },
      margin: 0.2,
      decision: 'strong',
    })
    expect(detectMergeClusters(labels, DEFAULT_THRESHOLDS, identityByLabel)).toHaveLength(1)
  })

  it('collapses a chain of three similar labels into one cluster', () => {
    const labels: LabelVec[] = [
      { fileLabel: 'A', emb: vec(1, 0, 0) },
      { fileLabel: 'B', emb: vec(1, 0.02, 0) },
      { fileLabel: 'C', emb: vec(1, 0.04, 0) },
    ]
    const result = detectMergeClusters(labels, DEFAULT_THRESHOLDS, new Map())
    expect(result).toHaveLength(1)
    expect(result[0].labels.sort()).toEqual(['A', 'B', 'C'])
  })

  it('caps at maxMergeSuggestions and sorts by minPairCosine desc', () => {
    const labels: LabelVec[] = []
    for (let i = 0; i < 12; i++) {
      // Pairs (0,1), (2,3), ... each close within pair, orthogonal across pairs.
      const base = Math.floor(i / 2)
      const offset = i % 2 === 0 ? 0 : 0.01
      labels.push({
        fileLabel: `L${i}`,
        emb: vec(base === 0 ? 1 : 0, base === 1 ? 1 : 0, base === 2 ? 1 : 0, base === 3 ? 1 : 0, base === 4 ? 1 : 0, offset),
      })
    }
    const result = detectMergeClusters(labels, DEFAULT_THRESHOLDS, new Map())
    expect(result.length).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.maxMergeSuggestions)
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].minPairCosine).toBeGreaterThanOrEqual(result[i].minPairCosine)
    }
  })
})
