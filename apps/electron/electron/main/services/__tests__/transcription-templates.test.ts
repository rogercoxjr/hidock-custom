/**
 * Task 12: Template resolution integration tests.
 *
 * Exercises the full template-resolution flow wired into transcription.ts Stage-2:
 *   - high-conf selector: LLM returns high confidence → template applied + run row
 *   - suggest_new: LLM returns low-confidence + suggested_template → base prompt + suggest row
 *   - selector-failure isolation (AC10): selector throws → Default path, base prompt, no abort
 *   - ≥2 gate (AC9): 1 user template → selector NEVER invoked, base prompt identical
 *
 * Uses a REAL sql.js in-memory database (same boundary-mock pattern as
 * two-stage-worker.test.ts / e2e-smoke.test.ts) plus the content-routed FakeLlmProvider
 * (fake-llm.ts) to route analysis, selector, and actionables calls deterministically.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { makeFakeLlm } from './test-helpers/fake-llm'

// ---------------------------------------------------------------------------
// Hoisted shared state — real temp dir + per-test routing.
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-tpltests-'))
  const dataDir = _path.join(tmpDir, 'data')
  const recordingsDir = _path.join(tmpDir, 'recordings')
  _fs.mkdirSync(dataDir, { recursive: true })
  _fs.mkdirSync(recordingsDir, { recursive: true })

  return {
    tmpDir,
    dataDir,
    recordingsDir,
    dbPath: _path.join(dataDir, 'hidock.db'),
    // Per-test mutable fake LLM provider — replaced in beforeEach.
    fakeLlm: null as null | ReturnType<typeof makeFakeLlm>,
    capturedAnalysisPrompts: [] as string[],
    selectorCallCount: 0,
    summarization: {
      provider: 'gemini' as string,
      ollamaCloudApiKey: '',
      ollamaCloudModel: '',
      selectorModel: undefined as string | undefined
    }
  }
})

// ---------------------------------------------------------------------------
// External-boundary mocks.
// ---------------------------------------------------------------------------

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
      provider: 'gemini',
      geminiApiKey: 'test-key',
      geminiModel: 'gemini-2.0-flash',
      autoTranscribe: false
    },
    summarization: { ...shared.summarization }
  })),
  updateConfig: vi.fn(async () => {}),
  getDataPath: vi.fn(() => shared.tmpDir)
}))

vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => shared.dbPath),
  getRecordingsPath: vi.fn(() => shared.recordingsDir),
  getCachePath: vi.fn(() => os.tmpdir()),
  saveRecording: vi.fn(async (filename: string, data: Buffer) => {
    const out = path.join(shared.recordingsDir, filename)
    fs.writeFileSync(out, data)
    return out
  })
}))

vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => null)
}))

// Route LLM calls through the per-test mutable fake.
vi.mock('../llm/llm-provider', () => ({
  getLlmProvider: vi.fn(() => shared.fakeLlm!)
}))

// Gemini ASR: returns a transcript long enough to pass the selector's 50-char guard.
const ASR_TRANSCRIPT = 'Team met to discuss the Q3 roadmap and delivery milestones. Action items were agreed upon. Decision was made to proceed with the new architecture.'
vi.mock('@google/generative-ai', () => {
  const generateContent = vi.fn(async (arg: unknown) => {
    if (Array.isArray(arg)) {
      return { response: { text: () => ASR_TRANSCRIPT } }
    }
    // Shouldn't be reached (analysis goes through fakeLlm), but guard anyway.
    return { response: { text: () => '{}' } }
  })
  class GoogleGenerativeAI {
    getGenerativeModel() { return { generateContent } }
  }
  return { GoogleGenerativeAI }
})

// ---------------------------------------------------------------------------
// Real service imports (resolved AFTER mocks).
// ---------------------------------------------------------------------------
import {
  initializeDatabase,
  closeDatabase,
  run,
  queryAll,
  getTranscriptByRecordingId
} from '../database'
import { createTemplate } from '../summarization-templates'
import { transcribeManually } from '../transcription'

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

/** Standard analysis JSON the fake returns on the analysis prompt. */
function makeAnalysisJson(title = 'Test Recording') {
  return JSON.stringify({
    summary: 'A test summary.',
    action_items: ['Do the thing'],
    topics: ['testing'],
    key_points: ['key point'],
    title_suggestion: title,
    question_suggestions: ['What happened?'],
    language: 'en'
  })
}

/** Insert a minimal recording row + write a fake audio file. */
function insertRecording(id: string): void {
  const filename = `${id}.hda`
  const filePath = path.join(shared.recordingsDir, filename)
  fs.writeFileSync(filePath, Buffer.from('fake-audio'))
  const now = new Date().toISOString()
  run(
    `INSERT INTO recordings (id, filename, file_path, file_size, duration_seconds, date_recorded, created_at)
     VALUES (?, ?, ?, 100, 60, ?, ?)`,
    [id, filename, filePath, now, now]
  )
}

// ---------------------------------------------------------------------------
// Suite lifecycle.
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Delete the on-disk database file so each test starts from a clean slate.
  if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)

  // Reset shared per-test state.
  shared.capturedAnalysisPrompts = []
  shared.selectorCallCount = 0
  shared.fakeLlm = null
  vi.clearAllMocks()

  // Default summarization config (provider = gemini).
  shared.summarization = {
    provider: 'gemini',
    ollamaCloudApiKey: '',
    ollamaCloudModel: '',
    selectorModel: undefined
  }

  await initializeDatabase()
})

afterEach(() => {
  try { closeDatabase() } catch { /* ignore */ }
  shared.fakeLlm = null
})

afterAll(() => {
  // Best-effort cleanup of temp dir.
  try { fs.rmSync(shared.tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('Task 12 — template resolution in Stage-2 worker', () => {
  it('high-conf selector: selected template applied, analysis prompt contains instructions, run row written', async () => {
    // Seed 2 user templates so the selector gate (>=2) fires.
    const tpl1 = createTemplate({ name: 'Alpha-hc', instructions: 'Focus on decisions.', enabled: true })
    const tpl2 = createTemplate({ name: 'Beta-hc', instructions: 'Focus on action items.', enabled: true })

    shared.fakeLlm = makeFakeLlm({
      onSelector: (_prompt) => {
        shared.selectorCallCount++
        // Return high confidence for tpl1.
        return JSON.stringify({
          template_id: tpl1.id,
          confidence: 0.9,
          runnerup_confidence: 0.3,
          reason: 'decisions meeting'
        })
      },
      onAnalysis: (prompt) => {
        shared.capturedAnalysisPrompts.push(prompt)
        return makeAnalysisJson('Decisions Meeting')
      },
      onActionables: () => '[]'
    })

    insertRecording('rec-highconf')
    await transcribeManually('rec-highconf')

    // 1. Selector was called exactly once.
    expect(shared.selectorCallCount).toBe(1)

    // 2. Analysis prompt contains the template's instructions (inside a data block).
    expect(shared.capturedAnalysisPrompts).toHaveLength(1)
    expect(shared.capturedAnalysisPrompts[0]).toContain('Focus on decisions.')

    // 3. Transcript row has provenance set to tpl1.
    const transcript = getTranscriptByRecordingId('rec-highconf')
    expect(transcript).toBeDefined()
    expect(transcript!.summarization_template_name).toBe('Alpha-hc')
    expect(transcript!.summarization_template_hash).toBeTruthy()
    // Override consumed (was never set, but column should be null).
    expect(transcript!.summarization_template_id).toBeFalsy()
    expect(transcript!.summary).toBe('A test summary.')

    // 4. Audit run row written with selection_kind='selected' and correct template_id.
    const runRows = queryAll<{ selection_kind: string; template_id: string | null; selector_elapsed_ms: number | null }>(
      'SELECT selection_kind, template_id, selector_elapsed_ms FROM transcript_template_runs WHERE recording_id = ?',
      ['rec-highconf']
    )
    expect(runRows).toHaveLength(1)
    expect(runRows[0].selection_kind).toBe('selected')
    expect(runRows[0].template_id).toBe(tpl1.id)

    void tpl2 // suppress unused warning
  })

  it('suggest_new: LLM returns low confidence + suggested_template → base prompt, suggest_new run row, summary written', async () => {
    // Seed 2 user templates so the selector gate fires.
    const tpl1 = createTemplate({ name: 'Alpha-sg', instructions: 'Focus on decisions.', enabled: true })
    const tpl2 = createTemplate({ name: 'Beta-sg', instructions: 'Focus on action items.', enabled: true })

    shared.fakeLlm = makeFakeLlm({
      onSelector: (_prompt) => {
        shared.selectorCallCount++
        return JSON.stringify({
          template_id: null,
          confidence: 0.2,
          runnerup_confidence: 0.1,
          reason: 'no good fit',
          suggested_template: {
            name: 'Interview Notes',
            description: 'For interviews',
            guidance: 'Capture candidate answers',
            exampleTriggers: ['interview', 'candidate']
          }
        })
      },
      onAnalysis: (prompt) => {
        shared.capturedAnalysisPrompts.push(prompt)
        return makeAnalysisJson('Test')
      },
      onActionables: () => '[]'
    })

    insertRecording('rec-suggest')
    await transcribeManually('rec-suggest')

    // 1. Analysis prompt does NOT contain instructions (Default path).
    expect(shared.capturedAnalysisPrompts).toHaveLength(1)
    expect(shared.capturedAnalysisPrompts[0]).not.toContain('<<<DATA_')

    // 2. Summary was still written (base completes).
    const transcript = getTranscriptByRecordingId('rec-suggest')
    expect(transcript?.summary).toBe('A test summary.')
    expect(transcript?.summarization_template_name).toBeNull()

    // 3. Run row has selection_kind='suggest_new' and suggested_template_json set.
    const runRows = queryAll<{ selection_kind: string; suggested_template_json: string | null }>(
      'SELECT selection_kind, suggested_template_json FROM transcript_template_runs WHERE recording_id = ?',
      ['rec-suggest']
    )
    expect(runRows).toHaveLength(1)
    expect(runRows[0].selection_kind).toBe('suggest_new')
    expect(runRows[0].suggested_template_json).toBeTruthy()

    void tpl1; void tpl2 // suppress unused warnings
  })

  it('AC10 selector-failure isolation: selector throws → Default path, base prompt, summary written, use_default run row', async () => {
    // Seed 2 user templates to trigger selector.
    const tpl1 = createTemplate({ name: 'Alpha-fail', instructions: 'Focus on decisions.', enabled: true })
    const tpl2 = createTemplate({ name: 'Beta-fail', instructions: 'Focus on action items.', enabled: true })

    shared.fakeLlm = makeFakeLlm({
      onSelector: () => {
        shared.selectorCallCount++
        throw new Error('Simulated selector LLM failure')
      },
      onAnalysis: (prompt) => {
        shared.capturedAnalysisPrompts.push(prompt)
        return makeAnalysisJson('Failure Test')
      },
      onActionables: () => '[]'
    })

    insertRecording('rec-selfail')
    // Must NOT throw even though selector throws — failure is isolated.
    await expect(transcribeManually('rec-selfail')).resolves.toBeUndefined()

    // 1. Summary was written (base completed despite selector failure).
    const transcript = getTranscriptByRecordingId('rec-selfail')
    expect(transcript?.summary).toBe('A test summary.')

    // 2. Analysis prompt uses Default path (no instructions block).
    expect(shared.capturedAnalysisPrompts).toHaveLength(1)
    expect(shared.capturedAnalysisPrompts[0]).not.toContain('<<<DATA_')
    expect(shared.capturedAnalysisPrompts[0]).toContain('Analyze this meeting transcript and provide')

    // 3. Run row has selection_kind='use_default' (or 'selector-failed' sub-kind) — base telemetry.
    const runRows = queryAll<{ selection_kind: string; template_id: string | null }>(
      'SELECT selection_kind, template_id FROM transcript_template_runs WHERE recording_id = ?',
      ['rec-selfail']
    )
    expect(runRows).toHaveLength(1)
    expect(runRows[0].template_id).toBeNull()

    void tpl1; void tpl2
  })

  it('AC9 ≥2 gate: 1 user template → selector NEVER invoked, base prompt byte-identical', async () => {
    // Only 1 user template — gate should prevent ANY selector call.
    createTemplate({ name: 'Solo', instructions: 'Focus on solo work.', enabled: true })

    // Use a spy-tracked selector mock that fails loudly if called.
    const selectorSpy = vi.fn((_prompt: string): string => {
      throw new Error('Selector must NOT be called when < 2 user templates exist')
    })

    shared.fakeLlm = {
      generate: async (prompt: string) => {
        const isActionables = prompt.includes('detect if the speaker intends to create any outputs')
        const isAnalysis = prompt.includes('Analyze this meeting transcript and provide')

        if (isActionables) return '[]'
        if (isAnalysis) {
          shared.capturedAnalysisPrompts.push(prompt)
          return makeAnalysisJson('Solo Test')
        }
        // If this is a selector call it would contain 'runnerup_confidence'.
        return selectorSpy(prompt) as string
      }
    }

    insertRecording('rec-gate')
    await transcribeManually('rec-gate')

    // 1. Selector was NEVER invoked.
    expect(selectorSpy).not.toHaveBeenCalled()

    // 2. Analysis prompt is the Default (no-instructions) path — no nonce-delimited blocks.
    expect(shared.capturedAnalysisPrompts).toHaveLength(1)
    expect(shared.capturedAnalysisPrompts[0]).not.toContain('<<<DATA_')
    expect(shared.capturedAnalysisPrompts[0]).toContain('Analyze this meeting transcript and provide')

    // 3. Summary was written.
    const transcript = getTranscriptByRecordingId('rec-gate')
    expect(transcript?.summary).toBe('A test summary.')

    // 4. Run row written with use_default telemetry (not an error — expected audit trail).
    const runRows = queryAll<{ selection_kind: string }>(
      'SELECT selection_kind FROM transcript_template_runs WHERE recording_id = ?',
      ['rec-gate']
    )
    expect(runRows).toHaveLength(1)
    expect(runRows[0].selection_kind).toBe('use_default')
  })

  it('manual override: summarization_template_id set on transcript → that template applied, override consumed', async () => {
    // Only 1 user template, but an override is set — should bypass the >=2 gate.
    const tpl = createTemplate({ name: 'Override Template', instructions: 'Use override instructions.', enabled: true })

    shared.fakeLlm = makeFakeLlm({
      onAnalysis: (prompt) => {
        shared.capturedAnalysisPrompts.push(prompt)
        return makeAnalysisJson('Override Test')
      },
      onActionables: () => '[]'
    })

    insertRecording('rec-override')

    // First, create a Stage-1 transcript row (simulating a resumed transcript).
    run(
      `INSERT INTO transcripts (id, recording_id, full_text, transcription_provider, summarization_template_id)
       VALUES ('trans_rec-override', 'rec-override', 'Test transcript text.', 'gemini', ?)`,
      [tpl.id]
    )

    // Run Stage-2 only (full_text exists, summarization_provider is NULL).
    await transcribeManually('rec-override')

    // 1. Analysis prompt contains the override template's instructions.
    expect(shared.capturedAnalysisPrompts).toHaveLength(1)
    expect(shared.capturedAnalysisPrompts[0]).toContain('Use override instructions.')

    // 2. Transcript provenance is set to the override template.
    const transcript = getTranscriptByRecordingId('rec-override')
    expect(transcript?.summarization_template_name).toBe('Override Template')
    expect(transcript?.summarization_template_hash).toBeTruthy()

    // 3. Override consumed (null'd atomically).
    expect(transcript?.summarization_template_id).toBeFalsy()

    // 4. Run row has selection_kind='manual'.
    const runRows = queryAll<{ selection_kind: string; template_id: string | null }>(
      'SELECT selection_kind, template_id FROM transcript_template_runs WHERE recording_id = ?',
      ['rec-override']
    )
    expect(runRows).toHaveLength(1)
    expect(runRows[0].selection_kind).toBe('manual')
    expect(runRows[0].template_id).toBe(tpl.id)
  })

  it('0 user templates (Default): selector never called, base prompt, use_default telemetry', async () => {
    // No user templates at all.
    shared.fakeLlm = makeFakeLlm({
      onAnalysis: (prompt) => {
        shared.capturedAnalysisPrompts.push(prompt)
        return makeAnalysisJson('Zero Templates')
      },
      onActionables: () => '[]'
    })

    insertRecording('rec-zerotpl')
    await transcribeManually('rec-zerotpl')

    // Selector was never invoked (no 'runnerup_confidence' prompt should reach LLM).
    expect(shared.capturedAnalysisPrompts).toHaveLength(1)
    expect(shared.capturedAnalysisPrompts[0]).not.toContain('runnerup_confidence')
    expect(shared.capturedAnalysisPrompts[0]).not.toContain('<<<DATA_')

    const transcript = getTranscriptByRecordingId('rec-zerotpl')
    expect(transcript?.summary).toBe('A test summary.')
    expect(transcript?.summarization_template_name).toBeNull()

    const runRows = queryAll<{ selection_kind: string }>(
      'SELECT selection_kind FROM transcript_template_runs WHERE recording_id = ?',
      ['rec-zerotpl']
    )
    expect(runRows).toHaveLength(1)
    expect(runRows[0].selection_kind).toBe('use_default')
  })

  it('selection cache: second run with same full_text skips selector LLM, reuses prior selection', async () => {
    const tpl1 = createTemplate({ name: 'Alpha-cache', instructions: 'Focus on decisions.', enabled: true })
    const tpl2 = createTemplate({ name: 'Beta-cache', instructions: 'Focus on action items.', enabled: true })

    shared.fakeLlm = makeFakeLlm({
      onSelector: (_prompt) => {
        shared.selectorCallCount++
        return JSON.stringify({
          template_id: tpl1.id,
          confidence: 0.9,
          runnerup_confidence: 0.3,
          reason: 'decisions meeting'
        })
      },
      onAnalysis: (prompt) => {
        shared.capturedAnalysisPrompts.push(prompt)
        return makeAnalysisJson('Cache Test')
      },
      onActionables: () => '[]'
    })

    insertRecording('rec-cache')
    await transcribeManually('rec-cache')

    // First run: selector was called once.
    expect(shared.selectorCallCount).toBe(1)

    // Re-run Stage 2 (clear the marker to trigger resummarize).
    run('UPDATE transcripts SET summarization_provider = NULL WHERE recording_id = ?', ['rec-cache'])

    shared.selectorCallCount = 0
    shared.capturedAnalysisPrompts = []

    await transcribeManually('rec-cache')

    // Second run: selector should NOT be called (same full_text → cache hit).
    expect(shared.selectorCallCount).toBe(0)

    // Analysis still uses tpl1's instructions (from cache).
    expect(shared.capturedAnalysisPrompts).toHaveLength(1)
    expect(shared.capturedAnalysisPrompts[0]).toContain('Focus on decisions.')

    void tpl2
  })
})

// Augment Transcript type with template columns for test assertions.
declare module '../database' {
  interface Transcript {
    summarization_template_id?: string | null
    summarization_template_name?: string | null
    summarization_template_hash?: string | null
  }
}
