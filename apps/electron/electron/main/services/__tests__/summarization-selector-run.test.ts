// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { selectTemplateForTranscript, prefilter, buildSelectorPrompt } from '../summarization-selector'
import type { LlmProvider } from '../llm/llm-provider'

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
})

describe('selectTemplateForTranscript', () => {
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

describe('buildSelectorPrompt', () => {
  it('never includes template instructions, wraps metadata in nonce blocks', () => {
    const p = buildSelectorPrompt({ excerpt: 'hi', meetingSubjects: ['Standup'], templates: tpls, nonce: 'N' })
    expect(p).not.toContain('instructions')   // the instructions VALUE 'i' would appear; ensure absent
    expect(p).toContain('<<<DATA_N>>>')
    expect(p).toContain('Sales')              // name IS sent
  })
})
