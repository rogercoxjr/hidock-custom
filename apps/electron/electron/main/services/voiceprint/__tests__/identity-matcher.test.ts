import { describe, it, expect } from 'vitest'
import {
  scoreLabelAgainstContacts,
  DEFAULT_THRESHOLDS,
  type ContactPrints,
} from '../identity-matcher'
import { l2Normalize, centroid } from '../vector-math'

function vec(...values: number[]): Float32Array {
  return l2Normalize(Float32Array.from(values))
}

function contact(id: string, prints: Float32Array[], qualities?: number[], isSelf = false): ContactPrints {
  return {
    contactId: id,
    isSelf,
    prints,
    qualities: qualities ?? prints.map(() => 1.0),
  }
}

describe('scoreLabelAgainstContacts', () => {
  it('returns no decision for an empty contact library', () => {
    const result = scoreLabelAgainstContacts(vec(1, 0, 0), [])
    expect(result.candidates).toHaveLength(0)
    expect(result.decision).toBe('none')
    expect(result.margin).toBe(0)
  })

  it('strong when the label matches the only contact well above thresholds', () => {
    const emb = vec(1, 0, 0)
    const result = scoreLabelAgainstContacts(emb, [contact('A', [emb])])
    expect(result.best?.contactId).toBe('A')
    expect(result.best?.score).toBeCloseTo(1, 6)
    expect(result.decision).toBe('strong')
    expect(result.margin).toBeCloseTo(1, 6)
  })

  it('suggest when score is in the suggest band with enough margin', () => {
    // Contact centroid points down X; label is offset to land cosine ~0.48.
    const contactEmb = vec(1, 0, 0)
    const labelEmb = l2Normalize(vec(1, 1.83, 0)) // cos ~0.48 with X-axis
    const result = scoreLabelAgainstContacts(labelEmb, [contact('A', [contactEmb])])
    expect(result.decision).toBe('suggest')
    expect(result.best!.score).toBeGreaterThanOrEqual(0.42)
    expect(result.best!.score).toBeLessThan(0.55)
    expect(result.margin).toBeCloseTo(result.best!.score, 6)
  })

  it('none when score is below matchSuggest', () => {
    const contactEmb = vec(1, 0, 0)
    const labelEmb = l2Normalize(vec(0, 1, 0))
    const result = scoreLabelAgainstContacts(labelEmb, [contact('A', [contactEmb])])
    expect(result.decision).toBe('none')
  })

  it('demotes to none when the top two contacts are within matchMargin (AC10)', () => {
    const label = vec(1, 0, 0)
    const a = contact('A', [vec(1, 0, 0)])
    const b = contact('B', [vec(0.97, 0.243, 0)]) // ~0.97 cos to label
    const result = scoreLabelAgainstContacts(label, [a, b])
    expect(result.best).toBeDefined()
    expect(result.secondBest).toBeDefined()
    expect(result.margin).toBeLessThan(DEFAULT_THRESHOLDS.matchMargin)
    expect(result.decision).toBe('none')
  })

  it('hybrid scoring prefers the best effective print over a dragged centroid', () => {
    const label = vec(1, 0, 0)
    // Two prints: one clean, one stale outlier that drags centroid down.
    const clean = vec(1, 0, 0)
    const stale = l2Normalize(vec(-1, 0.2, 0))
    const result = scoreLabelAgainstContacts(label, [
      contact('A', [clean, stale], [1.0, 0.5]),
    ])
    expect(result.best!.score).toBeGreaterThan(cosine(label, centroid([clean, stale])))
    expect(result.best!.viaCentroid).toBe(false)
  })

  it('outlier prints are excluded from the centroid basis', () => {
    const label = vec(1, 0, 0)
    const clean = vec(1, 0, 0)
    // Stale print is an outlier to the centroid, so it should not drag the centroid.
    const stale = l2Normalize(vec(-1, 0.1, 0))
    const result = scoreLabelAgainstContacts(label, [
      contact('A', [clean, stale], [1.0, 1.0]),
    ])
    // Centroid from only the clean print is essentially the clean print itself.
    expect(result.best!.score).toBeCloseTo(1, 4)
  })

  it('low-quality prints are down-weighted', () => {
    const label = vec(1, 0, 0)
    // The centroid is orthogonal to the label, so the best effective print dominates.
    const clean = vec(1, 0.2, 0)
    const stale = vec(-1, 0, 0)
    const goodScore = scoreLabelAgainstContacts(label, [
      contact('A', [clean, stale], [1.0, 1.0]),
    ])
    const poorScore = scoreLabelAgainstContacts(label, [
      contact('A', [clean, stale], [0.1, 1.0]),
    ])
    expect(poorScore.best!.score).toBeLessThan(goodScore.best!.score)
  })

  it('centroid is used when it is higher than any effective print score', () => {
    const label = vec(1, 0, 0)
    // Two noisy prints around X; centroid is cleaner than either individual print.
    const p1 = l2Normalize(vec(1, 0.5, 0))
    const p2 = l2Normalize(vec(1, -0.5, 0))
    const result = scoreLabelAgainstContacts(label, [
      contact('A', [p1, p2], [1.0, 1.0]),
    ])
    expect(result.best!.viaCentroid).toBe(true)
  })
})

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}
