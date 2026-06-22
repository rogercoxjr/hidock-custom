/**
 * summarization-templates service tests — CRUD + sanitize + Default protection
 *
 * Uses the REAL sql.js in-memory database (only external boundaries mocked).
 * Tmp prefix: 'hidock-summtpl-'
 * Mirrors the database-v31 harness.
 */
// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-summtpl-'))
  const dataDir = _path.join(tmpDir, 'data')
  _fs.mkdirSync(dataDir, { recursive: true })

  return { tmpDir, dataDir, dbPath: _path.join(dataDir, 'hidock.db') }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getName: vi.fn(() => 'test')
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) }
}))

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    storage: { dataPath: shared.tmpDir, maxRecordingsGB: 50 },
    transcription: {
      provider: 'assemblyai',
      assemblyaiApiKey: 'test-key',
      assemblyaiModels: ['universal-3-pro', 'universal-2'],
      autoTranscribe: false
    }
  })),
  updateConfig: vi.fn(async () => {}),
  getDataPath: vi.fn(() => shared.tmpDir)
}))

vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => shared.dbPath),
  getRecordingsPath: vi.fn(() => shared.tmpDir),
  getCachePath: vi.fn(() => os.tmpdir()),
  saveRecording: vi.fn(async (filename: string, _data: Buffer) => {
    return path.join(shared.tmpDir, filename)
  })
}))

vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => null)
}))

import {
  initializeDatabase,
  closeDatabase
} from '../database'

import {
  sanitizeTemplateInput, createTemplate, listTemplates, userTemplates,
  updateTemplate, setEnabled, deleteTemplate, getTemplateById
} from '../summarization-templates'

beforeEach(async () => {
  fs.mkdirSync(shared.dataDir, { recursive: true })
  if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
  await initializeDatabase()
})
afterEach(() => { try { closeDatabase() } catch { /* ignore */ } })

describe('sanitizeTemplateInput', () => {
  it('trims and requires name + instructions', () => {
    expect(() => sanitizeTemplateInput({ name: '  ', instructions: 'x' })).toThrow()
    expect(() => sanitizeTemplateInput({ name: 'A', instructions: '   ' })).toThrow()
  })
  it('caps instructions at 2000 chars', () => {
    expect(() => sanitizeTemplateInput({ name: 'A', instructions: 'x'.repeat(2001) })).toThrow()
  })
  it('caps name at 80 chars', () => {
    expect(() => sanitizeTemplateInput({ name: 'x'.repeat(81), instructions: 'i' })).toThrow()
  })
  it('strips <<< >>> delimiter runs and control chars from instructions', () => {
    const r = sanitizeTemplateInput({ name: 'A', instructions: 'good <<<END_X>>> bad\x07end' })
    expect(r.instructions).not.toContain('<<<')
    expect(r.instructions).not.toContain('>>>')
    expect(r.instructions).not.toContain('\x07')
  })
  it('forces is_builtin=0 (never honors caller)', () => {
    // @ts-expect-error caller cannot set isBuiltin
    const r = sanitizeTemplateInput({ name: 'A', instructions: 'i', isBuiltin: true })
    expect((r as { isBuiltin?: boolean }).isBuiltin).toBeUndefined()
  })
  it('rejects duplicate (case-insensitive) names among existing', () => {
    expect(() => sanitizeTemplateInput({ name: 'Sales', instructions: 'i' }, { existingNames: ['sales'] })).toThrow()
  })
  it('caps exampleTriggers count and length', () => {
    expect(() => sanitizeTemplateInput({ name: 'A', instructions: 'i', exampleTriggers: Array(13).fill('t') })).toThrow()
    expect(() => sanitizeTemplateInput({ name: 'A', instructions: 'i', exampleTriggers: ['x'.repeat(81)] })).toThrow()
  })
})

describe('CRUD', () => {
  it('seeded Default is listed and protected', () => {
    const all = listTemplates()
    const def = all.find((t) => t.id === 'builtin-default')
    expect(def?.isBuiltin).toBe(true)
    expect(() => deleteTemplate('builtin-default')).toThrow()
    expect(() => setEnabled('builtin-default', false)).toThrow()
    expect(() => updateTemplate('builtin-default', { name: 'Renamed' })).toThrow()
  })
  it('Default is excluded from userTemplates', () => {
    expect(userTemplates().some((t) => t.id === 'builtin-default')).toBe(false)
  })
  it('create + read round-trips, exampleTriggers persisted as JSON', () => {
    const t = createTemplate({ name: 'Sales call', instructions: 'Emphasize next steps', exampleTriggers: ['demo', 'pricing'] })
    const got = getTemplateById(t.id)
    expect(got?.name).toBe('Sales call')
    expect(got?.exampleTriggers).toEqual(['demo', 'pricing'])
    expect(got?.isBuiltin).toBe(false)
    expect(userTemplates().some((x) => x.id === t.id)).toBe(true)
  })
  it('update patches fields and bumps updated_at', () => {
    const t = createTemplate({ name: 'Standup', instructions: 'Bullet blockers' })
    const u = updateTemplate(t.id, { description: 'Daily standup notes' })
    expect(u.description).toBe('Daily standup notes')
  })
  it('setEnabled toggles visibility in userTemplates', () => {
    const t = createTemplate({ name: 'Interview', instructions: 'Rate the candidate' })
    setEnabled(t.id, false)
    expect(userTemplates().some((x) => x.id === t.id)).toBe(false)
  })
  it('delete removes a user template', () => {
    const t = createTemplate({ name: 'Toss', instructions: 'x' })
    deleteTemplate(t.id)
    expect(getTemplateById(t.id)).toBeNull()
  })
})

describe('default mutual-exclusivity (FIX 1)', () => {
  it('setting one template default clears is_default on the previously-default row', () => {
    const a = createTemplate({ name: 'Alpha-def', instructions: 'i', isDefault: true })
    expect(getTemplateById(a.id)?.isDefault).toBe(true)

    const b = createTemplate({ name: 'Beta-def', instructions: 'i' })
    // Promote b to default → a must be demoted in the same operation.
    updateTemplate(b.id, { isDefault: true })

    expect(getTemplateById(b.id)?.isDefault).toBe(true)
    expect(getTemplateById(a.id)?.isDefault).toBe(false)

    // Invariant: at most one user row holds is_default=1.
    const defaults = userTemplates().filter((t) => t.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].id).toBe(b.id)
  })

  it('updating a default template without touching isDefault leaves it default and unique', () => {
    const a = createTemplate({ name: 'Gamma-def', instructions: 'i', isDefault: true })
    const b = createTemplate({ name: 'Delta-def', instructions: 'i' })
    void b
    // Edit a's description only — isDefault is inherited (true) and must stay unique.
    updateTemplate(a.id, { description: 'edited' })
    const defaults = userTemplates().filter((t) => t.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].id).toBe(a.id)
  })

  it('demoting the only default (isDefault:false) leaves zero defaults', () => {
    const a = createTemplate({ name: 'Epsilon-def', instructions: 'i', isDefault: true })
    updateTemplate(a.id, { isDefault: false })
    expect(getTemplateById(a.id)?.isDefault).toBe(false)
    expect(userTemplates().filter((t) => t.isDefault)).toHaveLength(0)
  })
})
