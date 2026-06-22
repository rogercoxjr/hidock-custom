// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { decideSelection, buildExcerpt } from '../summarization-selector'

const tpls = [
  { id: 'a', name: 'A', description: '', instructions: 'i', exampleTriggers: [], isDefault: false, isBuiltin: false, enabled: true, createdAt: '', updatedAt: '' },
  { id: 'b', name: 'B', description: '', instructions: 'i', exampleTriggers: [], isDefault: true, isBuiltin: false, enabled: true, createdAt: '', updatedAt: '' }
]

describe('decideSelection', () => {
  it('auto-applies on high conf + margin', () => {
    const r = decideSelection({ templateId: 'a', confidence: 0.9, runnerUpConfidence: 0.5 }, tpls, 'b')
    expect(r).toMatchObject({ kind: 'selected', templateId: 'a' })
  })
  it('does NOT auto-apply when margin too small', () => {
    const r = decideSelection({ templateId: 'a', confidence: 0.9, runnerUpConfidence: 0.85 }, tpls, 'b')
    expect(r.kind).toBe('use_default')
  })
  it('auto-applies a high-conf single candidate when runnerUpConfidence is undefined (treated as 0)', () => {
    const r = decideSelection({ templateId: 'a', confidence: 0.9 }, tpls, 'b')
    expect(r).toMatchObject({ kind: 'selected', templateId: 'a' })
  })
  it('mid band → use_default (advisory)', () => {
    expect(decideSelection({ templateId: 'a', confidence: 0.6 }, tpls, 'b').kind).toBe('use_default')
  })
  it('low band with suggestion → suggest_new', () => {
    const r = decideSelection({ confidence: 0.2, suggestedTemplate: { name: 'New', description: 'd', instructions: 'i', exampleTriggers: ['x'] } }, tpls, 'b')
    expect(r.kind).toBe('suggest_new')
  })
  it('low band without suggestion → use_default', () => {
    expect(decideSelection({ confidence: 0.1 }, tpls, 'b').kind).toBe('use_default')
  })
  it('unknown templateId → use_default', () => {
    expect(decideSelection({ templateId: 'ghost', confidence: 0.99, runnerUpConfidence: 0 }, tpls, 'b').kind).toBe('use_default')
  })
  it('clamps confidence', () => {
    expect(decideSelection({ templateId: 'a', confidence: 5, runnerUpConfidence: 0 }, tpls, 'b').confidence).toBeLessThanOrEqual(1)
  })
})

describe('buildExcerpt', () => {
  it('returns full text when short', () => {
    expect(buildExcerpt('short text')).toBe('short text')
  })
  it('budgets begin+middle+end for long text', () => {
    const long = 'x'.repeat(50000)
    const ex = buildExcerpt(long)
    expect(ex.length).toBeLessThan(long.length)
    expect(ex).toContain('[...]')
  })
})
