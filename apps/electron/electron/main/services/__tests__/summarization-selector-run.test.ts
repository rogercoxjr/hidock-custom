// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { selectTemplateForTranscript, prefilter, buildSelectorPrompt } from '../summarization-selector'
import type { LlmProvider } from '../llm/llm-provider'
import { sermonTemplate, salesTemplate } from './fixtures/templates'

const tpls = [
  { id: 'sales', name: 'Sales', description: 'sales calls', instructions: 'i', exampleTriggers: ['demo'], isDefault: false, isBuiltin: false, enabled: true, createdAt: '', updatedAt: '' },
  { id: 'hr', name: 'HR', description: 'interviews', instructions: 'i', exampleTriggers: ['interview'], isDefault: false, isBuiltin: false, enabled: true, createdAt: '', updatedAt: '' }
]

function fake(json: string): LlmProvider {
  return { generate: async () => json }
}

describe('prefilter', () => {
  it('selects the single trigger match', () => {
    expect(prefilter({ templates: tpls, title: 'Product demo call', meetingSubjects: [] })).toBe('sales')
  })
  it('returns null on ambiguity', () => {
    expect(prefilter({ templates: tpls, title: 'demo and interview', meetingSubjects: [] })).toBeNull()
  })
  it('returns null on no match', () => {
    expect(prefilter({ templates: tpls, title: 'random chat', meetingSubjects: [] })).toBeNull()
  })
  it('does NOT match on an empty-string trigger', () => {
    const withEmpty = [
      { ...tpls[0], id: 'empty', exampleTriggers: [''] },
    ]
    // An empty trigger must not match anything (''.includes-style always-true bug).
    expect(prefilter({ templates: withEmpty, title: 'literally anything', meetingSubjects: [] })).toBeNull()
  })
})

describe('selectTemplateForTranscript', () => {
  it('prefilter short-circuits WITHOUT calling the LLM', async () => {
    const generate = vi.fn(async () => '{}')
    const llm: LlmProvider = { generate }
    const r = await selectTemplateForTranscript(
      { fullText: 'x'.repeat(200), meetingSubjects: [], recordingTitle: 'Product demo call', templates: tpls, userDefaultId: null },
      llm
    )
    expect(r).toMatchObject({ kind: 'selected', templateId: 'sales' })
    expect(generate).not.toHaveBeenCalled()
  })
  it('returns promptly on success without waiting for the timeout (timer cleared)', async () => {
    // generate resolves immediately; a huge timeoutMs would hang the test if the
    // timer were not cleared on success. elapsedMs must be far below the timeout.
    const llm = fake(JSON.stringify({ template_id: 'sales', confidence: 0.9, runnerup_confidence: 0.3, reason: 'x' }))
    const t0 = Date.now()
    const r = await selectTemplateForTranscript(
      { fullText: 'x'.repeat(200), meetingSubjects: [], templates: tpls, userDefaultId: null }, llm, { timeoutMs: 60000 }
    )
    expect(r).toMatchObject({ kind: 'selected', templateId: 'sales' })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r.elapsedMs).toBeLessThan(1000)
  })
  it('parses selector JSON and applies via decideSelection', async () => {
    const llm = fake(JSON.stringify({ template_id: 'sales', confidence: 0.9, runnerup_confidence: 0.3, reason: 'clear sales call' }))
    const r = await selectTemplateForTranscript(
      { fullText: 'x'.repeat(200), meetingSubjects: [], templates: tpls, userDefaultId: null }, llm
    )
    expect(r).toMatchObject({ kind: 'selected', templateId: 'sales' })
  })
  it('isolates LLM failure → use_default', async () => {
    const llm: LlmProvider = { generate: async () => { throw new Error('429 rate limited') } }
    const r = await selectTemplateForTranscript(
      { fullText: 'x'.repeat(200), meetingSubjects: [], templates: tpls, userDefaultId: null }, llm
    )
    expect(r.kind).toBe('use_default')
    expect(r.reason).toContain('selector-failed')
  })
  it('isolates timeout → use_default', async () => {
    const llm: LlmProvider = { generate: () => new Promise((res) => setTimeout(() => res('{}'), 1000)) }
    const r = await selectTemplateForTranscript(
      { fullText: 'x'.repeat(200), meetingSubjects: [], templates: tpls, userDefaultId: null }, llm, { timeoutMs: 20 }
    )
    expect(r.kind).toBe('use_default')
  })
  it('isolates unparseable output → use_default', async () => {
    const r = await selectTemplateForTranscript(
      { fullText: 'x'.repeat(200), meetingSubjects: [], templates: tpls, userDefaultId: null }, fake('not json')
    )
    expect(r.kind).toBe('use_default')
  })
  it('parses Gemini-style ```json-fenced prose (json flag ignored)', async () => {
    const llm = fake('Here is my choice:\n```json\n{"template_id":"sales","confidence":0.9,"runnerup_confidence":0.3,"reason":"x"}\n```')
    const r = await selectTemplateForTranscript(
      { fullText: 'x'.repeat(200), meetingSubjects: [], templates: tpls, userDefaultId: null }, llm
    )
    expect(r).toMatchObject({ kind: 'selected', templateId: 'sales' })
  })
  it('greedy extraction handles a nested suggested_template object (top-level object, not truncated)', async () => {
    const llm = fake(JSON.stringify({
      confidence: 0.2, reason: 'no fit',
      suggested_template: { name: 'New', description: 'd', instructions: 'i', exampleTriggers: ['x'] }
    }))
    const r = await selectTemplateForTranscript(
      { fullText: 'x'.repeat(200), meetingSubjects: [], templates: tpls, userDefaultId: null }, llm
    )
    expect(r.kind).toBe('suggest_new')
    expect(r.suggestedTemplate?.name).toBe('New')
  })
})

describe('prefilter searches the transcript excerpt', () => {
  it('matches a trigger found only in the excerpt (not the filename)', () => {
    const id = prefilter({
      templates: [sermonTemplate, salesTemplate],
      title: 'external-2026-06-22-19-00-18',
      filename: 'external-2026-06-22-19-00-18.m4a',
      meetingSubjects: [],
      excerpt: 'Welcome to todays sermon on the book of Romans.',
    })
    expect(id).toBe('tpl-sermon')
  })

  it('trigger in title/filename still matches without excerpt (existing behavior preserved)', () => {
    // REGRESSION GUARD: the new `excerpt ?? ''` must be APPENDED to the haystack,
    // not REPLACE it. A trigger present only in the title (no excerpt) must still
    // match, proving the prior title/filename/subjects matching is intact.
    const id = prefilter({
      templates: [sermonTemplate, salesTemplate],
      title: 'Sunday sermon notes',
      filename: 'x.m4a',
      meetingSubjects: [],
      excerpt: '',
    })
    expect(id).toBe('tpl-sermon')
  })

  it('returns null when two templates trigger in the excerpt (ambiguous)', () => {
    const id = prefilter({
      templates: [sermonTemplate, salesTemplate],
      title: 'meeting',
      filename: 'meeting.m4a',
      meetingSubjects: [],
      excerpt: 'First the sermon, then we discussed pricing.',
    })
    expect(id).toBeNull()
  })

  it('returns null when no trigger appears anywhere', () => {
    const id = prefilter({
      templates: [sermonTemplate, salesTemplate],
      title: 'standup',
      filename: 'standup.m4a',
      meetingSubjects: ['daily standup'],
      excerpt: 'We synced on the sprint backlog.',
    })
    expect(id).toBeNull()
  })

  it('still ignores empty-string triggers (no match-everything)', () => {
    const emptyTrig = { ...salesTemplate, id: 'tpl-empty', exampleTriggers: [''] }
    const id = prefilter({
      templates: [emptyTrig],
      title: 'x',
      filename: 'x.m4a',
      meetingSubjects: [],
      excerpt: 'literally anything',
    })
    expect(id).toBeNull()
  })
})

describe('buildSelectorPrompt', () => {
  it('never includes template instructions, wraps metadata in nonce blocks', () => {
    // MINOR: use a distinctive multi-word sentinel as the instructions VALUE so
    // the not.toContain assertion can actually catch an instructions leak (the
    // old single-char 'i' fixture made the check effectively vacuous).
    const SENTINEL = 'SECRET_INSTRUCTIONS_SHOULD_NEVER_LEAK'
    const tplsWithSentinel = tpls.map((t) => ({ ...t, instructions: SENTINEL }))
    const p = buildSelectorPrompt({ excerpt: 'hi', meetingSubjects: ['Standup'], templates: tplsWithSentinel, nonce: 'N' })
    expect(p).not.toContain(SENTINEL)         // template instructions must NEVER appear in the selector prompt
    expect(p).toContain('<<<DATA_N>>>')
    expect(p).toContain('Sales')              // name IS sent
  })
})
