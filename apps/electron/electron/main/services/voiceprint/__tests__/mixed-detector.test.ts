import { describe, it, expect } from 'vitest'
import { detectMixedLabels, type WindowedLabel } from '../mixed-detector'
import { DEFAULT_THRESHOLDS, type IdentityScore } from '../identity-matcher'
import { l2Normalize } from '../vector-math'

function vec(...values: number[]): Float32Array {
  return l2Normalize(Float32Array.from(values))
}

describe('detectMixedLabels', () => {
  it('returns empty for empty input', () => {
    expect(detectMixedLabels([], new Map(), DEFAULT_THRESHOLDS)).toEqual([])
  })

  it('flags high window dispersion as variance signal', () => {
    const windowed: WindowedLabel[] = [
      {
        fileLabel: 'A',
        windowEmbs: [vec(1, 0, 0), vec(0, 1, 0), vec(0, 0, 1)],
      },
    ]
    const result = detectMixedLabels(windowed, new Map(), DEFAULT_THRESHOLDS)
    expect(result).toHaveLength(1)
    expect(result[0].fileLabel).toBe('A')
    expect(result[0].reason).toBe('variance')
    expect(result[0].dispersion).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.mixedDispersion)
  })

  it('does not flag low window dispersion', () => {
    const windowed: WindowedLabel[] = [
      {
        fileLabel: 'A',
        windowEmbs: [vec(1, 0, 0), vec(1, 0.01, 0), vec(1, -0.01, 0)],
      },
    ]
    expect(detectMixedLabels(windowed, new Map(), DEFAULT_THRESHOLDS)).toEqual([])
  })

  it('flags two-contact signal when top windows match different contacts above suggest', () => {
    const windowed: WindowedLabel[] = [
      { fileLabel: 'B', windowEmbs: [vec(1, 0, 0), vec(0, 1, 0)] },
    ]
    const perWindowIdentity = new Map<string, IdentityScore[][]>()
    perWindowIdentity.set('B', [
      [{ contactId: 'Robyn', score: 0.5, viaCentroid: true }],
      [{ contactId: 'Tiffany', score: 0.5, viaCentroid: true }],
    ])
    const result = detectMixedLabels(windowed, perWindowIdentity, DEFAULT_THRESHOLDS)
    expect(result).toHaveLength(1)
    expect(result[0].reason).toBe('two-contact')
    expect(result[0].contactA).toBe('Robyn')
    expect(result[0].contactB).toBe('Tiffany')
  })

  it('does not flag when only one contact clears matchSuggest across windows', () => {
    const windowed: WindowedLabel[] = [
      { fileLabel: 'B', windowEmbs: [vec(1, 0, 0), vec(1, 0.1, 0)] },
    ]
    const perWindowIdentity = new Map<string, IdentityScore[][]>()
    perWindowIdentity.set('B', [
      [{ contactId: 'Robyn', score: 0.5, viaCentroid: true }],
      [{ contactId: 'Robyn', score: 0.5, viaCentroid: true }],
    ])
    expect(detectMixedLabels(windowed, perWindowIdentity, DEFAULT_THRESHOLDS)).toEqual([])
  })

  it('does not flag when windows score below matchSuggest', () => {
    const windowed: WindowedLabel[] = [
      { fileLabel: 'B', windowEmbs: [vec(1, 0, 0), vec(1, 0.01, 0)] },
    ]
    const perWindowIdentity = new Map<string, IdentityScore[][]>()
    perWindowIdentity.set('B', [
      [{ contactId: 'Robyn', score: 0.4, viaCentroid: true }],
      [{ contactId: 'Tiffany', score: 0.4, viaCentroid: true }],
    ])
    expect(detectMixedLabels(windowed, perWindowIdentity, DEFAULT_THRESHOLDS)).toEqual([])
  })

  it('prefers two-contact reason when both signals fire', () => {
    const windowed: WindowedLabel[] = [
      { fileLabel: 'C', windowEmbs: [vec(1, 0, 0), vec(0, 1, 0)] },
    ]
    const perWindowIdentity = new Map<string, IdentityScore[][]>()
    perWindowIdentity.set('C', [
      [{ contactId: 'Robyn', score: 0.5, viaCentroid: true }],
      [{ contactId: 'Tiffany', score: 0.5, viaCentroid: true }],
    ])
    const result = detectMixedLabels(windowed, perWindowIdentity, DEFAULT_THRESHOLDS)
    expect(result[0].reason).toBe('two-contact')
    expect(result[0].dispersion).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.mixedDispersion)
  })
})
