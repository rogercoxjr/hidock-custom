// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const svc = vi.hoisted(() => ({
  listTemplates: vi.fn(() => [{ id: 'builtin-default', name: 'Default', isBuiltin: true }]),
  createTemplate: vi.fn((i: { name: string }) => ({ id: 't1', name: i.name })),
  updateTemplate: vi.fn((id: string) => ({ id, name: 'X' })),
  setEnabled: vi.fn(),
  deleteTemplate: vi.fn()
}))
vi.mock('../../services/summarization-templates', () => svc)

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))

import { registerSummarizationTemplatesHandlers } from '../summarization-templates-handlers'

beforeEach(() => { handlers.clear(); vi.clearAllMocks(); registerSummarizationTemplatesHandlers() })

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
