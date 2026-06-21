import { describe, it, expect } from 'vitest'
import { deriveCaptureLabels, buildLabelsKey } from '../deriveCaptureLabels'
import type { LabelDefinition } from '@/types'

const TAXONOMY: LabelDefinition[] = [
  { id: 'meeting', name: 'Meeting', color: 'blue', builtin: true },
  { id: 'interview', name: 'Interview', color: 'teal', builtin: true },
  { id: '1:1', name: '1:1', color: 'green', builtin: true },
  { id: 'brainstorm', name: 'Brainstorm', color: 'amber', builtin: true },
  { id: 'note', name: 'Note', color: 'violet', builtin: true },
  { id: 'other', name: 'Other', color: 'slate', builtin: true },
  { id: 'sales-call', name: 'Sales Call', color: 'green' }
]

describe('deriveCaptureLabels', () => {
  it('returns empty array when category is undefined', () => {
    expect(deriveCaptureLabels(undefined)).toEqual([])
  })

  it('returns empty array when category is empty string', () => {
    expect(deriveCaptureLabels('')).toEqual([])
  })

  it('resolves the category chip name + color from the taxonomy', () => {
    const labels = deriveCaptureLabels('meeting', undefined, TAXONOMY)
    expect(labels).toHaveLength(1)
    // Shows the display NAME (not the raw id) and the palette dot color (blue → bg-primary).
    expect(labels[0]).toMatchObject({ text: 'Meeting', kind: 'category', colorClass: 'bg-primary' })
  })

  it('resolves a user-added label by its display name + color', () => {
    const labels = deriveCaptureLabels('sales-call', undefined, TAXONOMY)
    expect(labels[0]).toMatchObject({ text: 'Sales Call', kind: 'category', colorClass: 'bg-success' })
  })

  it('returns a colored chip for every taxonomy category value', () => {
    for (const item of TAXONOMY) {
      const labels = deriveCaptureLabels(item.id, undefined, TAXONOMY)
      expect(labels).toHaveLength(1)
      expect(labels[0].kind).toBe('category')
      expect(labels[0].text).toBe(item.name)
      expect(labels[0].colorClass).toBeTruthy()
    }
  })

  it('falls back to the raw id + slate dot for a category absent from the taxonomy', () => {
    const labels = deriveCaptureLabels('custom-unknown', undefined, TAXONOMY)
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatchObject({ text: 'custom-unknown', kind: 'category' })
    // Unknown labels still get a (slate) dot so the chip renders consistently.
    expect(labels[0].colorClass).toBe('bg-surface-sunken')
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
