// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The latestRun handler only reads a subset of each record's fields. Annotating
// the mock return types (instead of letting `() => null` pin them to `null`) lets
// mockReturnValue({...}) type-check — the bare inference caused TS2345.
const svc = vi.hoisted(() => ({
  listTemplates: vi.fn(() => [{ id: 'builtin-default', name: 'Default', isBuiltin: true }]),
  createTemplate: vi.fn((i: { name: string }) => ({ id: 't1', name: i.name })),
  updateTemplate: vi.fn((id: string) => ({ id, name: 'X' })),
  setEnabled: vi.fn(),
  deleteTemplate: vi.fn(),
  getTemplateById: vi.fn((): { id: string; name: string; instructions: string } | null => null),
}))
vi.mock('../../services/summarization-templates', () => svc)

// Mock database functions used by the new latestRun handler.
const db = vi.hoisted(() => ({
  getLatestTemplateRun: vi.fn((): {
    selectionKind: string; selectionConfidence: number; suggestedTemplateJson: string | null
  } | null => null),
  getTranscriptByRecordingId: vi.fn((): {
    summarization_template_name: string | null
    summarization_template_hash: string | null
    summarization_template_id: string | null
  } | null => null),
}))
vi.mock('../../services/database', () => db)

// Mock summarization-selector's hashText (used for instructionsChanged comparison).
vi.mock('../../services/summarization-selector', () => ({
  hashText: vi.fn((s: string) => `hash(${s})`),
}))

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))

import { registerSummarizationTemplatesHandlers } from '../summarization-templates-handlers'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  // Restore default mocks for new latestRun dependencies.
  db.getLatestTemplateRun.mockReturnValue(null)
  db.getTranscriptByRecordingId.mockReturnValue(null)
  svc.getTemplateById.mockReturnValue(null)
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
