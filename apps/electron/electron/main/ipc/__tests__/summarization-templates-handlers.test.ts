// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The latestRun handler only reads a subset of each record's fields. Annotating
// the mock return types (instead of letting `() => null` pin them to `null`) lets
// mockReturnValue({...}) type-check — the bare inference caused TS2345.
const svc = vi.hoisted(() => ({
  listTemplates: vi.fn(() => [{ id: 'builtin-default', name: 'Default', isBuiltin: true }]),
  createTemplate: vi.fn((i: { name: string }) => ({ id: 't1', name: i.name, instructions: 'x', exampleTriggers: [] })),
  updateTemplate: vi.fn((id: string) => ({ id, name: 'X' })),
  setEnabled: vi.fn(),
  deleteTemplate: vi.fn(),
  getTemplateById: vi.fn((): { id: string; name: string; instructions: string } | null => null),
  userTemplates: vi.fn(() => [{ id: 'user-tpl', name: 'Sales', exampleTriggers: [], enabled: true }]),
}))
vi.mock('../../services/summarization-templates', () => svc)

// Mock database functions used by the new latestRun handler and Phase 4 handlers.
const db = vi.hoisted(() => ({
  getLatestTemplateRun: vi.fn((): {
    selectionKind: string; selectionConfidence: number; suggestedTemplateJson: string | null
  } | null => null),
  getTranscriptByRecordingId: vi.fn((): {
    summarization_template_name: string | null
    summarization_template_hash: string | null
    summarization_template_id: string | null
    full_text?: string | null
  } | null => null),
  setTranscriptTemplateOverride: vi.fn(),
  clearTranscriptStage2Marker: vi.fn(),
  hasInFlightQueueItem: vi.fn((): boolean => false),
  addToQueue: vi.fn((): string => 'queue-item-1'),
}))
vi.mock('../../services/database', () => db)

// Mock summarization-selector's hashText + selectTemplateForTranscript.
const selector = vi.hoisted(() => ({
  hashText: vi.fn((s: string) => `hash(${s})`),
  selectTemplateForTranscript: vi.fn(async () => ({
    kind: 'use_default' as const,
    confidence: 0.3,
    reason: 'mocked',
    elapsedMs: 10,
  })),
}))
vi.mock('../../services/summarization-selector', () => selector)

// Mock config + LLM provider.
vi.mock('../../services/config', () => ({
  getConfig: vi.fn(() => ({ summarization: { provider: 'gemini' } })),
}))
vi.mock('../../services/llm/llm-provider', () => ({
  getLlmProvider: vi.fn(() => ({ generate: vi.fn(async () => '{}') })),
}))

// Mock transcription (processQueueManually only)
const transcriptionMock = vi.hoisted(() => ({
  processQueueManually: vi.fn(async () => {}),
}))
vi.mock('../../services/transcription', () => transcriptionMock)

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))

import { registerSummarizationTemplatesHandlers } from '../summarization-templates-handlers'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  // Restore default mocks.
  db.getLatestTemplateRun.mockReturnValue(null)
  db.getTranscriptByRecordingId.mockReturnValue(null)
  db.hasInFlightQueueItem.mockReturnValue(false)
  db.setTranscriptTemplateOverride.mockReset()
  db.clearTranscriptStage2Marker.mockReset()
  db.addToQueue.mockReturnValue('queue-item-1')
  svc.getTemplateById.mockReturnValue(null)
  svc.createTemplate.mockImplementation((i: { name: string }) => ({
    id: 't1', name: i.name, instructions: 'x', exampleTriggers: []
  }))
  svc.userTemplates.mockReturnValue([{ id: 'user-tpl', name: 'Sales', exampleTriggers: [], enabled: true }])
  selector.selectTemplateForTranscript.mockResolvedValue({
    kind: 'use_default', confidence: 0.3, reason: 'mocked', elapsedMs: 10,
  })
  transcriptionMock.processQueueManually.mockResolvedValue(undefined)
  registerSummarizationTemplatesHandlers()
})

describe('summarizationTemplates IPC', () => {
  it('list returns templates', async () => {
    const res = await handlers.get('summarizationTemplates:list')!({})
    expect(res).toMatchObject({ success: true })
  })

  it('list catches service error and returns error envelope', async () => {
    svc.listTemplates.mockImplementationOnce(() => { throw new Error('db failure') })
    const res = await handlers.get('summarizationTemplates:list')!({}) as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.code).toBe('INTERNAL_ERROR')
  })

  it('create validates and calls service', async () => {
    const res = await handlers.get('summarizationTemplates:create')!({}, { name: 'Sales', instructions: 'i' })
    expect(svc.createTemplate).toHaveBeenCalled()
    expect(res).toMatchObject({ success: true })
  })

  it('create rejects invalid payload', async () => {
    const res = await handlers.get('summarizationTemplates:create')!({}, { name: '', instructions: '' })
    expect(res).toMatchObject({ success: false })
    expect(svc.createTemplate).not.toHaveBeenCalled()
  })

  it('create catches service error and returns error envelope', async () => {
    svc.createTemplate.mockImplementationOnce(() => { throw new Error('duplicate') })
    const res = await handlers.get('summarizationTemplates:create')!({}, { name: 'A', instructions: 'b' }) as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.code).toBe('INTERNAL_ERROR')
  })

  it('update validates and calls service', async () => {
    const res = await handlers.get('summarizationTemplates:update')!({}, 't1', { name: 'New Name' }) as any
    expect(svc.updateTemplate).toHaveBeenCalledWith('t1', { name: 'New Name' })
    expect(res).toMatchObject({ success: true })
  })

  it('update rejects invalid id', async () => {
    const res = await handlers.get('summarizationTemplates:update')!({}, '', { name: 'X' }) as any
    expect(res).toMatchObject({ success: false })
    expect(svc.updateTemplate).not.toHaveBeenCalled()
  })

  it('update catches service error and returns error envelope', async () => {
    svc.updateTemplate.mockImplementationOnce(() => { throw new Error('not found') })
    const res = await handlers.get('summarizationTemplates:update')!({}, 't1', { name: 'X' }) as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.code).toBe('INTERNAL_ERROR')
  })

  it('setEnabled validates the boolean', async () => {
    await handlers.get('summarizationTemplates:setEnabled')!({}, { id: 't1', enabled: false })
    expect(svc.setEnabled).toHaveBeenCalledWith('t1', false)
  })

  it('setEnabled rejects missing enabled', async () => {
    const res = await handlers.get('summarizationTemplates:setEnabled')!({}, { id: 't1' }) as any
    expect(res).toMatchObject({ success: false })
    expect(svc.setEnabled).not.toHaveBeenCalled()
  })

  it('setEnabled catches service error and returns error envelope', async () => {
    svc.setEnabled.mockImplementationOnce(() => { throw new Error('builtin') })
    const res = await handlers.get('summarizationTemplates:setEnabled')!({}, { id: 't1', enabled: true }) as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.code).toBe('INTERNAL_ERROR')
  })

  it('delete calls service', async () => {
    await handlers.get('summarizationTemplates:delete')!({}, { id: 't1' })
    expect(svc.deleteTemplate).toHaveBeenCalledWith('t1')
  })

  it('delete rejects invalid payload', async () => {
    const res = await handlers.get('summarizationTemplates:delete')!({}, { id: '' }) as any
    expect(res).toMatchObject({ success: false })
    expect(svc.deleteTemplate).not.toHaveBeenCalled()
  })

  it('delete catches service error and returns error envelope', async () => {
    svc.deleteTemplate.mockImplementationOnce(() => { throw new Error('builtin') })
    const res = await handlers.get('summarizationTemplates:delete')!({}, { id: 't1' }) as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.code).toBe('INTERNAL_ERROR')
  })
})

describe('summarizationTemplates:latestRun IPC (Phase 3 / Task 13b)', () => {
  it('returns success with null fields when no transcript or run exists', async () => {
    db.getTranscriptByRecordingId.mockReturnValue(null)
    db.getLatestTemplateRun.mockReturnValue(null)
    const res = await handlers.get('summarizationTemplates:latestRun')!({}, 'rec-1') as any
    expect(res).toMatchObject({ success: true })
    expect(res.data.name).toBeNull()
    expect(res.data.confidence).toBeNull()
    expect(res.data.kind).toBeNull()
    expect(res.data.suggestedTemplate).toBeNull()
    expect(res.data.instructionsChanged).toBe(false)
  })

  it('returns template name from transcript and confidence from run', async () => {
    db.getTranscriptByRecordingId.mockReturnValue({
      summarization_template_name: 'Sales call',
      summarization_template_hash: 'abc123',
      summarization_template_id: null,
    })
    db.getLatestTemplateRun.mockReturnValue({
      selectionKind: 'applied',
      selectionConfidence: 0.86,
      suggestedTemplateJson: null,
    })
    const res = await handlers.get('summarizationTemplates:latestRun')!({}, 'rec-1') as any
    expect(res.success).toBe(true)
    expect(res.data.name).toBe('Sales call')
    expect(res.data.confidence).toBeCloseTo(0.86)
    expect(res.data.kind).toBe('applied')
    expect(res.data.instructionsChanged).toBe(false)
  })

  it('returns suggest_new kind with parsed suggestedTemplate', async () => {
    db.getTranscriptByRecordingId.mockReturnValue({ summarization_template_name: null, summarization_template_hash: null, summarization_template_id: null })
    db.getLatestTemplateRun.mockReturnValue({
      selectionKind: 'suggest_new',
      selectionConfidence: 0.3,
      suggestedTemplateJson: JSON.stringify({ name: 'Interview notes', instructions: 'Focus on candidate answers.' }),
    })
    const res = await handlers.get('summarizationTemplates:latestRun')!({}, 'rec-1') as any
    expect(res.success).toBe(true)
    expect(res.data.kind).toBe('suggest_new')
    expect(res.data.suggestedTemplate).toMatchObject({ name: 'Interview notes' })
  })

  it('reports instructionsChanged when live template hash differs', async () => {
    db.getTranscriptByRecordingId.mockReturnValue({
      summarization_template_name: 'Demo',
      summarization_template_hash: 'hash(old instructions)',
      summarization_template_id: 'tpl-1',
    })
    db.getLatestTemplateRun.mockReturnValue({ selectionKind: 'applied', selectionConfidence: 0.9, suggestedTemplateJson: null })
    svc.getTemplateById.mockReturnValue({ id: 'tpl-1', instructions: 'new instructions', name: 'Demo' })
    const res = await handlers.get('summarizationTemplates:latestRun')!({}, 'rec-1') as any
    // hashText('new instructions') = 'hash(new instructions)' != 'hash(old instructions)'
    expect(res.data.instructionsChanged).toBe(true)
  })

  it('reports instructionsChanged=false when hashes match', async () => {
    db.getTranscriptByRecordingId.mockReturnValue({
      summarization_template_name: 'Demo',
      summarization_template_hash: 'hash(same instructions)',
      summarization_template_id: 'tpl-1',
    })
    db.getLatestTemplateRun.mockReturnValue({ selectionKind: 'applied', selectionConfidence: 0.9, suggestedTemplateJson: null })
    svc.getTemplateById.mockReturnValue({ id: 'tpl-1', instructions: 'same instructions', name: 'Demo' })
    const res = await handlers.get('summarizationTemplates:latestRun')!({}, 'rec-1') as any
    expect(res.data.instructionsChanged).toBe(false)
  })

  it('rejects non-string recordingId with VALIDATION_ERROR', async () => {
    const res = await handlers.get('summarizationTemplates:latestRun')!({}, 42) as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects empty string recordingId with VALIDATION_ERROR', async () => {
    const res = await handlers.get('summarizationTemplates:latestRun')!({}, '') as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.code).toBe('VALIDATION_ERROR')
  })
})

// ---------------------------------------------------------------------------
// Phase 4 (Task 14): previewSelection IPC
// ---------------------------------------------------------------------------
describe('summarizationTemplates:previewSelection IPC (Phase 4 / Task 14)', () => {
  // Use fake timers with a realistic epoch so the rate-limiter map's sliding-window
  // prune logic works correctly.  We anchor to a fixed epoch and advance by 61 s
  // before each test so any real-epoch timestamps stored by prior tests are in the
  // far past (> RATE_LIMIT_WINDOW_MS = 60_000 ms ago) and get pruned.
  const FAKE_EPOCH_START = 1_750_000_000_000 // realistic ms epoch (2025-ish)
  let fakeNow = FAKE_EPOCH_START

  beforeEach(() => {
    fakeNow += 70_000 // advance 70 s past previous fake epoch (> 60 s window)
    vi.useFakeTimers()
    vi.setSystemTime(fakeNow)
  })
  afterEach(() => { vi.useRealTimers() })

  it('returns the selector result and writes NOTHING to the DB', async () => {
    db.getTranscriptByRecordingId.mockReturnValue({
      summarization_template_name: null,
      summarization_template_hash: null,
      summarization_template_id: null,
      full_text: 'This is a long enough transcript to run the selector.',
    })
    selector.selectTemplateForTranscript.mockResolvedValue({
      kind: 'use_default', confidence: 0.3, reason: 'no match', elapsedMs: 12,
    })

    const res = await handlers.get('summarizationTemplates:previewSelection')!({}, 'rec-1') as any
    expect(res).toMatchObject({ success: true })
    expect(res.data.kind).toBe('use_default')
    expect(res.data.confidence).toBeCloseTo(0.3)

    // Critical: nothing must have been written
    expect(db.setTranscriptTemplateOverride).not.toHaveBeenCalled()
    expect(db.clearTranscriptStage2Marker).not.toHaveBeenCalled()
    expect(db.addToQueue).not.toHaveBeenCalled()
    expect(transcriptionMock.processQueueManually).not.toHaveBeenCalled()
  })

  it('returns NOT_FOUND when transcript has no full_text', async () => {
    db.getTranscriptByRecordingId.mockReturnValue({
      summarization_template_name: null,
      summarization_template_hash: null,
      summarization_template_id: null,
      full_text: null,
    })
    const res = await handlers.get('summarizationTemplates:previewSelection')!({}, 'rec-1') as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.code).toBe('NOT_FOUND')
    expect(selector.selectTemplateForTranscript).not.toHaveBeenCalled()
  })

  it('rate-limits: 5 calls across 5 DIFFERENT recordingIds all pass; the 6th returns RATE_LIMITED', async () => {
    db.getTranscriptByRecordingId.mockReturnValue({
      summarization_template_name: null, summarization_template_hash: null,
      summarization_template_id: null, full_text: 'Long enough transcript for selection.',
    })

    // 5 calls with different recording IDs — must all succeed (global key, not per-recording)
    for (let i = 0; i < 5; i++) {
      const res = await handlers.get('summarizationTemplates:previewSelection')!({}, `rec-${i}`) as any
      expect(res.success, `call ${i} should succeed`).toBe(true)
    }

    // 6th call — any recordingId — must be rate-limited
    const res6 = await handlers.get('summarizationTemplates:previewSelection')!({}, 'rec-x') as any
    expect(res6).toMatchObject({ success: false })
    expect(res6.error.code).toBe('RATE_LIMITED')
  })

  it('rejects non-string recordingId with VALIDATION_ERROR', async () => {
    const res = await handlers.get('summarizationTemplates:previewSelection')!({}, 42) as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.code).toBe('VALIDATION_ERROR')
  })
})

// ---------------------------------------------------------------------------
// Phase 4 (Task 14): acceptSuggestedTemplate IPC
// ---------------------------------------------------------------------------
describe('summarizationTemplates:acceptSuggestedTemplate IPC (Phase 4 / Task 14)', () => {
  const suggestedJson = JSON.stringify({
    name: 'Interview notes',
    description: 'For interviews',
    instructions: 'Focus on candidate answers.',
    exampleTriggers: ['interview', 'candidate'],
  })

  beforeEach(() => {
    db.getLatestTemplateRun.mockReturnValue({
      selectionKind: 'suggest_new',
      selectionConfidence: 0.3,
      suggestedTemplateJson: suggestedJson,
    })
  })

  it('creates a sanitized template + triggers resummarize (override + clear + queue)', async () => {
    const res = await handlers.get('summarizationTemplates:acceptSuggestedTemplate')!({}, 'rec-1') as any
    expect(res).toMatchObject({ success: true })
    expect(svc.createTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Interview notes', instructions: 'Focus on candidate answers.' })
    )
    expect(db.setTranscriptTemplateOverride).toHaveBeenCalledWith('rec-1', 't1')
    expect(db.clearTranscriptStage2Marker).toHaveBeenCalledWith('rec-1')
    expect(db.addToQueue).toHaveBeenCalledWith('rec-1')
  })

  it('merges caller edits over the suggested payload', async () => {
    const res = await handlers.get('summarizationTemplates:acceptSuggestedTemplate')!({}, 'rec-1', {
      name: 'Candidate Review',
      instructions: 'Summarize strengths and weaknesses.',
    }) as any
    expect(res.success).toBe(true)
    expect(svc.createTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Candidate Review', instructions: 'Summarize strengths and weaknesses.' })
    )
  })

  it('rejects with VALIDATION_ERROR when a transcription is in-flight (and does NOT orphan a template)', async () => {
    db.hasInFlightQueueItem.mockReturnValue(true)
    const res = await handlers.get('summarizationTemplates:acceptSuggestedTemplate')!({}, 'rec-1') as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.message).toMatch(/transcription in progress/)
    // No template row may be created when the guard rejects — guard-before-write
    // ordering must keep the user's template list free of ghost entries.
    expect(svc.createTemplate).not.toHaveBeenCalled()
    // And no override / marker / queue writes either.
    expect(db.setTranscriptTemplateOverride).not.toHaveBeenCalled()
    expect(db.clearTranscriptStage2Marker).not.toHaveBeenCalled()
    expect(db.addToQueue).not.toHaveBeenCalled()
  })

  it('returns NOT_FOUND when no suggested template exists', async () => {
    db.getLatestTemplateRun.mockReturnValue(null)
    const res = await handlers.get('summarizationTemplates:acceptSuggestedTemplate')!({}, 'rec-1') as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.code).toBe('NOT_FOUND')
    expect(svc.createTemplate).not.toHaveBeenCalled()
  })

  it('rejects non-string recordingId with VALIDATION_ERROR', async () => {
    const res = await handlers.get('summarizationTemplates:acceptSuggestedTemplate')!({}, 42) as any
    expect(res).toMatchObject({ success: false })
    expect(res.error.code).toBe('VALIDATION_ERROR')
  })
})
