import { describe, it, expect } from 'vitest'
import { deriveCaptureLabels, buildLabelsKey } from '../deriveCaptureLabels'

describe('deriveCaptureLabels', () => {
  it('returns empty array when category is undefined', () => {
    expect(deriveCaptureLabels(undefined)).toEqual([])
  })

  it('returns empty array when category is empty string', () => {
    expect(deriveCaptureLabels('')).toEqual([])
  })

  it('returns one category chip for a known category', () => {
    const labels = deriveCaptureLabels('meeting')
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatchObject({ text: 'meeting', kind: 'category', colorClass: 'bg-primary' })
  })

  it('returns a chip for every known category value', () => {
    const categories = ['meeting', 'interview', '1:1', 'brainstorm', 'note', 'other'] as const
    for (const cat of categories) {
      const labels = deriveCaptureLabels(cat)
      expect(labels).toHaveLength(1)
      expect(labels[0].kind).toBe('category')
      expect(labels[0].colorClass).toBeTruthy()
    }
  })

  it('returns a chip for unknown category without a colorClass', () => {
    const labels = deriveCaptureLabels('custom-unknown')
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatchObject({ text: 'custom-unknown', kind: 'category' })
    expect(labels[0].colorClass).toBeUndefined()
  })
})

describe('buildLabelsKey', () => {
  it('returns empty string for empty array', () => {
    expect(buildLabelsKey([])).toBe('')
  })

  it('produces stable key: same values → same string', () => {
    const a = deriveCaptureLabels('meeting')
    const b = deriveCaptureLabels('meeting')
    expect(buildLabelsKey(a)).toBe(buildLabelsKey(b))
  })

  it('produces different key for different categories', () => {
    const a = buildLabelsKey(deriveCaptureLabels('meeting'))
    const b = buildLabelsKey(deriveCaptureLabels('interview'))
    expect(a).not.toBe(b)
  })
})
