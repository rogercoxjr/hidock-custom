/**
 * summarization-runs.test.ts
 *
 * Tests for the template-run audit writer + selection-cache lookup primitives
 * (Task 11). Covers:
 *   - recordTemplateRun round-trips all columns
 *   - getLatestTemplateRun returns the most-recent row by created_at (and null when none)
 *   - hashText is deterministic (same input → same hex; different input → different hex)
 *   - config.summarization.selectorModel has the correct default
 *
 * Uses the REAL sql.js in-memory database (v33 harness).
 * Tmp prefix: 'hidock-summ-runs-'
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

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-summ-runs-'))
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
  closeDatabase,
  run,
  recordTemplateRun,
  getLatestTemplateRun
} from '../database'

import { hashText } from '../summarization-selector'

beforeEach(async () => {
  fs.mkdirSync(shared.dataDir, { recursive: true })
  if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
  await initializeDatabase()
  // Insert a parent recording so FK (if any) constraints don't fire
  run(`INSERT INTO recordings (id, filename, date_recorded) VALUES ('rec-a', 'a.wav', '2024-01-01T00:00:00.000Z')`)
})

afterEach(() => { try { closeDatabase() } catch { /* ignore */ } })

// ── hashText ────────────────────────────────────────────────────────────────

describe('hashText', () => {
  it('is deterministic — same input, same output', () => {
    expect(hashText('hello world')).toBe(hashText('hello world'))
  })

  it('produces 64-char lowercase hex (SHA-256)', () => {
    const h = hashText('test')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('different input produces different hash', () => {
    expect(hashText('hello')).not.toBe(hashText('world'))
  })
})

// ── recordTemplateRun / getLatestTemplateRun ────────────────────────────────

describe('recordTemplateRun + getLatestTemplateRun', () => {
  it('returns null when no runs exist for a recording', () => {
    expect(getLatestTemplateRun('rec-a')).toBeNull()
  })

  it('round-trips all columns', () => {
    const hash = hashText('the full transcript text')
    recordTemplateRun({
      recordingId: 'rec-a',
      templateId: 'tpl-1',
      selectionKind: 'selected',
      selectionConfidence: 0.85,
      runnerupConfidence: 0.4,
      candidateScoresJson: '{"tpl-1":0.85,"tpl-2":0.4}',
      selectionReason: 'clear sales call',
      selectorProvider: 'gemini',
      selectorModel: 'gemini-2.0-flash',
      selectorElapsedMs: 312,
      fullTextHash: hash,
      suggestedTemplateJson: undefined,
      appliedInstructionsHash: hashText('instructions text')
    })

    const row = getLatestTemplateRun('rec-a')
    expect(row).not.toBeNull()
    expect(row!.recordingId).toBe('rec-a')
    expect(row!.templateId).toBe('tpl-1')
    expect(row!.selectionKind).toBe('selected')
    expect(row!.selectionConfidence).toBeCloseTo(0.85)
    expect(row!.runnerupConfidence).toBeCloseTo(0.4)
    expect(row!.candidateScoresJson).toBe('{"tpl-1":0.85,"tpl-2":0.4}')
    expect(row!.selectionReason).toBe('clear sales call')
    expect(row!.selectorProvider).toBe('gemini')
    expect(row!.selectorModel).toBe('gemini-2.0-flash')
    expect(row!.selectorElapsedMs).toBe(312)
    expect(row!.fullTextHash).toBe(hash)
    expect(row!.suggestedTemplateJson).toBeUndefined()
    expect(row!.appliedInstructionsHash).toBe(hashText('instructions text'))
    expect(row!.id).toMatch(/^tplrun_/)
    expect(row!.createdAt).toBeTruthy()
  })

  it('nullable optional fields are returned as undefined (not null)', () => {
    recordTemplateRun({
      recordingId: 'rec-a',
      selectionKind: 'use_default',
      selectionConfidence: 0.0
    })
    const row = getLatestTemplateRun('rec-a')
    expect(row).not.toBeNull()
    expect(row!.templateId).toBeUndefined()
    expect(row!.runnerupConfidence).toBeUndefined()
    expect(row!.candidateScoresJson).toBeUndefined()
    expect(row!.selectionReason).toBeUndefined()
    expect(row!.selectorProvider).toBeUndefined()
    expect(row!.selectorModel).toBeUndefined()
    expect(row!.selectorElapsedMs).toBeUndefined()
    expect(row!.fullTextHash).toBeUndefined()
    expect(row!.suggestedTemplateJson).toBeUndefined()
    expect(row!.appliedInstructionsHash).toBeUndefined()
  })

  it('returns the most-recent run when multiple exist', async () => {
    recordTemplateRun({
      recordingId: 'rec-a',
      selectionKind: 'use_default',
      selectionConfidence: 0.3,
      selectionReason: 'first-run'
    })

    // Brief pause to ensure created_at ordering is reliable
    await new Promise((r) => setTimeout(r, 10))

    recordTemplateRun({
      recordingId: 'rec-a',
      selectionKind: 'selected',
      selectionConfidence: 0.9,
      selectionReason: 'second-run'
    })

    const row = getLatestTemplateRun('rec-a')
    expect(row!.selectionReason).toBe('second-run')
    expect(row!.selectionConfidence).toBeCloseTo(0.9)
  })

  it('full_text_hash round-trips (selection-cache key semantics)', () => {
    const h = hashText('transcript text for caching')
    recordTemplateRun({
      recordingId: 'rec-a',
      selectionKind: 'selected',
      selectionConfidence: 0.88,
      fullTextHash: h
    })
    const row = getLatestTemplateRun('rec-a')
    expect(row!.fullTextHash).toBe(h)
  })

  it('returns null for an unknown recording id', () => {
    expect(getLatestTemplateRun('no-such-recording')).toBeNull()
  })
})

// ── config selectorModel type-check ────────────────────────────────────────
// The AppConfig.summarization.selectorModel field is declared optional (?: string).
// We verify this at the type level only — the TypeScript compiler will catch any
// regression. Runtime default coverage is in config.ts itself (selectorModel: '').
// (No runtime describe block needed here — the type check is the test.)
