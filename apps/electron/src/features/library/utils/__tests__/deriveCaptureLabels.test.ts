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

  it('appends uncolored topic chips parsed from a JSON topics string', () => {
    const labels = deriveCaptureLabels('meeting', JSON.stringify(['Roadmap', 'Budget']))
    expect(labels).toHaveLength(3)
    expect(labels[0]).toMatchObject({ kind: 'category', text: 'meeting' })
    expect(labels[1]).toMatchObject({ kind: 'topic', text: 'Roadmap' })
    expect(labels[1].colorClass).toBeUndefined()
    expect(labels[2]).toMatchObject({ kind: 'topic', text: 'Budget' })
  })

  it('accepts topics as an array and caps at two', () => {
    const labels = deriveCaptureLabels('note', ['A', 'B', 'C'])
    const topics = labels.filter((l) => l.kind === 'topic')
    expect(topics.map((t) => t.text)).toEqual(['A', 'B'])
  })

  it('yields topic chips even when there is no category', () => {
    const labels = deriveCaptureLabels(null, ['Solo'])
    expect(labels).toEqual([{ text: 'Solo', kind: 'topic' }])
  })

  it('ignores malformed/empty topics gracefully', () => {
    expect(deriveCaptureLabels('meeting', 'not-json')).toHaveLength(1)
    expect(deriveCaptureLabels('meeting', '[]')).toHaveLength(1)
    expect(deriveCaptureLabels('meeting', null)).toHaveLength(1)
    expect(deriveCaptureLabels('meeting', JSON.stringify(['  ', 'Real']))).toMatchObject([
      { kind: 'category' },
      { kind: 'topic', text: 'Real' },
    ])
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
