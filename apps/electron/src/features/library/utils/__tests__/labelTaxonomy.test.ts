import { describe, it, expect } from 'vitest'
import type { LabelDefinition } from '@/types'
import {
  labelName,
  labelColorClass,
  slugifyLabelId,
  validateNewLabel,
  FALLBACK_LABEL_ID
} from '../labelTaxonomy'
import { dotClassForToken, isValidColorToken, DEFAULT_LABEL_COLOR } from '../labelPalette'

const ITEMS: LabelDefinition[] = [
  { id: 'meeting', name: 'Meeting', color: 'blue', builtin: true },
  { id: '1:1', name: '1:1', color: 'green', builtin: true },
  { id: 'other', name: 'Other', color: 'slate', builtin: true }
]

describe('labelPalette', () => {
  it('maps known tokens to dot classes and falls back to slate', () => {
    expect(dotClassForToken('blue')).toBe('bg-primary')
    expect(dotClassForToken('green')).toBe('bg-success')
    expect(dotClassForToken('nope')).toBe(dotClassForToken(DEFAULT_LABEL_COLOR))
    expect(dotClassForToken(undefined)).toBe(dotClassForToken(DEFAULT_LABEL_COLOR))
  })

  it('isValidColorToken only accepts palette tokens', () => {
    expect(isValidColorToken('blue')).toBe(true)
    expect(isValidColorToken('rainbow')).toBe(false)
  })
})

describe('labelTaxonomy resolvers', () => {
  it('labelName returns display name, or the raw id when unknown', () => {
    expect(labelName(ITEMS, 'meeting')).toBe('Meeting')
    expect(labelName(ITEMS, 'mystery')).toBe('mystery')
    expect(labelName(ITEMS, null)).toBe('')
  })

  it('labelColorClass resolves color via the palette', () => {
    expect(labelColorClass(ITEMS, 'meeting')).toBe('bg-primary')
    expect(labelColorClass(ITEMS, 'unknown')).toBe('bg-surface-sunken') // slate fallback
  })

  it('FALLBACK_LABEL_ID is "other"', () => {
    expect(FALLBACK_LABEL_ID).toBe('other')
  })
})

describe('slugifyLabelId', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyLabelId('Sales Call')).toBe('sales-call')
    expect(slugifyLabelId('  Quarterly   Review  ')).toBe('quarterly-review')
  })
  it('preserves the colon so 1:1 round-trips', () => {
    expect(slugifyLabelId('1:1')).toBe('1:1')
  })
  it('strips leading/trailing punctuation', () => {
    expect(slugifyLabelId('!!Hello!!')).toBe('hello')
  })
})

describe('validateNewLabel', () => {
  it('rejects empty names', () => {
    expect(validateNewLabel(ITEMS, '   ').ok).toBe(false)
  })
  it('rejects names that slugify to nothing', () => {
    expect(validateNewLabel(ITEMS, '!!!').ok).toBe(false)
  })
  it('rejects a duplicate id', () => {
    const r = validateNewLabel(ITEMS, 'Meeting')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/already exists/i)
  })
  it('rejects a duplicate name (case-insensitive)', () => {
    const r = validateNewLabel(ITEMS, 'meeting')
    expect(r.ok).toBe(false)
  })
  it('accepts a fresh name and returns its slug id', () => {
    const r = validateNewLabel(ITEMS, 'Sales Call')
    expect(r.ok).toBe(true)
    expect(r.id).toBe('sales-call')
  })
})
