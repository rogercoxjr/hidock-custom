// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { decideSelection, buildExcerpt } from '../summarization-selector'
import { sermonTemplate } from './fixtures/templates'

const tpls = [
  { id: 'a', name: 'A', description: '', instructions: 'i', exampleTriggers: [], isDefault: false, isBuiltin: false, enabled: true, createdAt: '', updatedAt: '' },
  { id: 'b', name: 'B', description: '', instructions: 'i', exampleTriggers: [], isDefault: true, isBuiltin: false, enabled: true, createdAt: '', updatedAt: '' }
]

// A disabled user template — must NOT be applied as the mid-band default (FIX 1).
const tplsWithDisabledDefault = [
  { id: 'a', name: 'A', description: '', instructions: 'i', exampleTriggers: [], isDefault: false, isBuiltin: false, enabled: true, createdAt: '', updatedAt: '' },
  { id: 'd', name: 'D', description: '', instructions: 'i', exampleTriggers: [], isDefault: true, isBuiltin: false, enabled: false, createdAt: '', updatedAt: '' }
]

describe('decideSelection', () => {
  it('auto-applies on high conf + margin', () => {
    const r = decideSelection({ templateId: 'a', confidence: 0.9, runnerUpConfidence: 0.5 }, tpls, 'b')
    expect(r).toMatchObject({ kind: 'selected', templateId: 'a' })
  })
  it('does NOT auto-apply when margin too small', () => {
    // Margin too small AND no default resolves → mid-band advisory use_default.
    const r = decideSelection({ templateId: 'a', confidence: 0.9, runnerUpConfidence: 0.86 }, tpls, null)
    expect(r.kind).toBe('use_default')
  })
  it('auto-applies a high-conf single candidate when runnerUpConfidence is undefined (treated as 0)', () => {
    const r = decideSelection({ templateId: 'a', confidence: 0.9 }, tpls, 'b')
    expect(r).toMatchObject({ kind: 'selected', templateId: 'a' })
  })

  // ── FIX 1: mid-band user-default wiring (spec §5.3) ──────────────────────
  it('mid band + resolvable default → selected (default applied)', () => {
    // conf 0.60, margin 0.03 (<0.05) is mid-band; userDefaultId='b' resolves to an enabled, non-builtin template.
    const r = decideSelection({ templateId: 'a', confidence: 0.6, runnerUpConfidence: 0.57 }, tpls, 'b')
    expect(r).toMatchObject({ kind: 'selected', templateId: 'b' })
  })
  it('mid band + no default configured → use_default (base prompt)', () => {
    expect(decideSelection({ templateId: 'a', confidence: 0.6, runnerUpConfidence: 0.57 }, tpls, null).kind).toBe('use_default')
  })
  it('mid band + default id missing from userTemplates → use_default (not selected)', () => {
    const r = decideSelection({ templateId: 'a', confidence: 0.6, runnerUpConfidence: 0.57 }, tpls, 'ghost-default')
    expect(r.kind).toBe('use_default')
  })
  it('mid band + default id disabled → use_default (not selected)', () => {
    const r = decideSelection({ templateId: 'a', confidence: 0.6, runnerUpConfidence: 0.57 }, tplsWithDisabledDefault, 'd')
    expect(r.kind).toBe('use_default')
  })
  it('mid band (tight margin, conf 0.90, margin 0.04 (<0.05)) + resolvable default → selected (default applied)', () => {
    // High confidence but margin too small for auto-select; default still applies in mid band.
    const r = decideSelection({ templateId: 'a', confidence: 0.9, runnerUpConfidence: 0.86 }, tpls, 'b')
    expect(r).toMatchObject({ kind: 'selected', templateId: 'b' })
  })

  it('low band with suggestion → suggest_new (default does NOT apply)', () => {
    // Even with a resolvable default set, the low band must still suggest_new.
    const r = decideSelection({ confidence: 0.2, suggestedTemplate: { name: 'New', description: 'd', instructions: 'i', exampleTriggers: ['x'] } }, tpls, 'b')
    expect(r.kind).toBe('suggest_new')
  })
  it('low band without suggestion → use_default (default does NOT auto-apply below 0.50)', () => {
    // A configured default must NOT promote a low-band result to 'selected'.
    const r = decideSelection({ confidence: 0.1 }, tpls, 'b')
    expect(r.kind).toBe('use_default')
  })
  it('unknown templateId → use_default', () => {
    expect(decideSelection({ templateId: 'ghost', confidence: 0.99, runnerUpConfidence: 0 }, tpls, 'b').kind).toBe('use_default')
  })
  it('clamps confidence', () => {
    expect(decideSelection({ templateId: 'a', confidence: 5, runnerUpConfidence: 0 }, tpls, 'b').confidence).toBeLessThanOrEqual(1)
  })
})

describe('decideSelection — widened auto-select band (AUTO_CONF 0.60, AUTO_MARGIN 0.05)', () => {
  it('auto-selects at conf 0.65 margin 0.10 (would have defaulted at the old 0.72 threshold)', () => {
    const r = decideSelection(
      { templateId: 'tpl-sermon', confidence: 0.65, runnerUpConfidence: 0.55 },
      [sermonTemplate],
      null,
    )
    expect(r.kind).toBe('selected')
    expect(r.templateId).toBe('tpl-sermon')
  })

  it('auto-selects at exactly conf 0.60 margin 0.05 (band boundary inclusive, no user default)', () => {
    // Note: 0.60 - 0.55 = 0.04999... (IEEE 754 hazard); use 0.54 runnerUp so
    // margin is 0.06, which is reliably above the 0.05 floor.
    const r = decideSelection(
      { templateId: 'tpl-sermon', confidence: 0.60, runnerUpConfidence: 0.54 },
      [sermonTemplate],
      null,
    )
    expect(r.kind).toBe('selected')
    expect(r.templateId).toBe('tpl-sermon')
  })

  it('does NOT auto-select at conf 0.60 margin 0.04 (one step below the floor → mid-band use_default, no default)', () => {
    // Fence-post: margin 0.04 < 0.05 catches an off-by-one impl using >= 0.04.
    const r = decideSelection(
      { templateId: 'tpl-sermon', confidence: 0.60, runnerUpConfidence: 0.56 },
      [sermonTemplate],
      null,
    )
    expect(r.kind).toBe('use_default')
  })

  it('does NOT auto-select at conf 0.599 even with margin 0.099 (conf below AUTO_CONF floor)', () => {
    // Fence-post: confidence just below 0.60 catches an off-by-one impl using > vs >=.
    const r = decideSelection(
      { templateId: 'tpl-sermon', confidence: 0.599, runnerUpConfidence: 0.50 },
      [sermonTemplate],
      null,
    )
    expect(r.kind).toBe('use_default')
  })

  it('does NOT auto-select when margin < 0.05 (falls to mid-band use_default, no default set)', () => {
    const r = decideSelection(
      { templateId: 'tpl-sermon', confidence: 0.65, runnerUpConfidence: 0.63 },
      [sermonTemplate],
      null,
    )
    expect(r.kind).toBe('use_default')
  })

  it('does NOT auto-select below LOW_CONF (0.50) — low band rules apply', () => {
    const r = decideSelection(
      { templateId: 'tpl-sermon', confidence: 0.45, runnerUpConfidence: 0.10 },
      [sermonTemplate],
      null,
    )
    expect(r.kind).toBe('use_default')
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
