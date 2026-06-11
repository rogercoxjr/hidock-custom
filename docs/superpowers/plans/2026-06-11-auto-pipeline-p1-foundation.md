# Auto-Pipeline P1 — Foundation (DB migration + two-stage worker + queue hardening)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase P1 of `docs/superpowers/specs/2026-06-11-auto-pipeline-model-choice-design.md` (§12): split the fused Gemini transcription worker into a two-stage pipeline (ASR → Analysis) behind provider interfaces — Gemini-only in this phase — with the DB migration, stage-resume rule, and queue hardening. Behavior for today's Gemini-default users stays identical (spec AC7), with one deliberate exception: Stage-2 JSON-extraction failure now retries/errors instead of silently completing with empty analysis.

**Architecture:** All work in `apps/electron`. Worker refactor in `electron/main/services/transcription.ts`; new provider modules in `electron/main/services/asr/` and `electron/main/services/llm/`; DB changes in `electron/main/services/database.ts` (SCHEMA + guarded `MIGRATIONS[25]` + new stage-write functions); one IPC re-route in `electron/main/ipc/recording-handlers.ts`. Stage marker: `transcripts.summarization_provider IS NULL` ⇔ Stage 2 incomplete (spec §5.3).

**Tech Stack:** Electron 39 main process (Node), sql.js (SQLite), `@google/generative-ai`, Vitest.

---

## Environment / invariants (read before every task)

- Work from `apps/electron`: `cd /c/Users/rcox/hidock-tools/hidock-next/apps/electron` (Git Bash paths).
- Run one test file: `npx vitest run electron/main/services/__tests__/<file>.test.ts`. Full gates (Task 6 only): `npm run typecheck && npm run lint && npm run test:run`.
- ⛔ **USB safety (CLAUDE.md):** never touch USB/jensen code, never run anything against real hardware. This phase touches no USB code; if you find yourself in `jensen.ts` or download orchestration, you are off-plan — stop.
- **Line endings:** repo is LF-normalized. After staging, `git diff --cached --stat` and `git diff --cached --ignore-cr-at-eol --stat` must show identical counts; if not, fix the files you created with `sed -i 's/\r$//' <file>`.
- **Commits:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Spec is authoritative:** `docs/superpowers/specs/2026-06-11-auto-pipeline-model-choice-design.md` §5.3 (worker), §5.7 (queue), §5.8 (migration). When this plan and the spec disagree, the spec wins — report the discrepancy.
- Existing tests you must NOT break (they encode today's contracts): `electron/main/services/__tests__/transcription.test.ts`, `transcription-b007.test.ts`, `database.test.ts`, `download-service.test.ts` (+ `-b007`/`-c004`), `e2e-smoke.test.ts`. Where this phase deliberately changes behavior (extraction-failure throws; queue-level key pre-check removed), realign those tests **and say so in your report** — never delete an assertion without explaining which spec section supersedes it.

## File structure (what each piece owns)

| File | Responsibility |
|---|---|
| `electron/main/services/database.ts` (modify) | SCHEMA v25 columns + `sync_baseline_files`; `MIGRATIONS[25]` + backfill; `upsertTranscriptStage1` / `updateTranscriptStage2`; `addToQueue` dedupe |
| `electron/main/services/asr/asr-provider.ts` (create) | `AsrResult`/`AsrProvider` interface + `getAsrProvider` factory |
| `electron/main/services/asr/gemini-asr.ts` (create) | Today's Gemini audio call, extracted verbatim |
| `electron/main/services/llm/llm-provider.ts` (create) | `LlmProvider` interface + `getLlmProvider` factory |
| `electron/main/services/llm/gemini-llm.ts` (create) | Today's Gemini text-generation call, extracted |
| `electron/main/services/transcription.ts` (modify) | Two-stage worker, stage resume, short-circuit, per-stage key checks, throw-on-extraction-failure, auto-rename predicate, actionables delete-and-replace |
| `electron/main/ipc/recording-handlers.ts` (modify) | `recordings:transcribe` re-routed through the queue |
| `electron/main/services/__tests__/two-stage-worker.test.ts` (create) | Worker behavior tests (this phase's core) |
| `electron/main/services/__tests__/database-v25.test.ts` (create) | Migration/columns/backfill/stage-write/dedupe tests |

---

### Task 1: Schema v25 — columns, sync_baseline_files, guarded migration, backfill

**Files:**
- Modify: `electron/main/services/database.ts` (SCHEMA strings ~line 239/278; `SCHEMA_VERSION` line 10; `MIGRATIONS` after the `24:` entry ~line 1350; `Transcript` interface line 2151; `QueueItem` interface line 2273)
- Create (Test): `electron/main/services/__tests__/database-v25.test.ts`

- [ ] **Step 1: Write the failing test.** Create `electron/main/services/__tests__/database-v25.test.ts`. Look at the top of `database.test.ts` for how existing tests initialize a fresh in-memory database (they call `initializeDatabase()` with sql.js against a temp/in-memory path) and copy that exact setup idiom. Then:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
// Use the same initialize/teardown helpers database.test.ts uses — copy its imports/setup verbatim.

describe('schema v25 (auto-pipeline P1)', () => {
  // beforeEach: fresh DB via the database.test.ts idiom

  it('fresh boot has the four new columns', () => {
    const tCols = queryAll<{ name: string }>("SELECT name FROM pragma_table_info('transcripts')").map(c => c.name)
    expect(tCols).toContain('summarization_provider')
    expect(tCols).toContain('summarization_model')
    const qCols = queryAll<{ name: string }>("SELECT name FROM pragma_table_info('transcription_queue')").map(c => c.name)
    expect(qCols).toContain('parked_until')
    expect(qCols).toContain('first_parked_at')
  })

  it('fresh boot has sync_baseline_files', () => {
    const t = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_baseline_files'"
    )
    expect(t?.name).toBe('sync_baseline_files')
  })

  it('backfill marks fused-flow rows complete but leaves NULL-summary rows resumable', () => {
    // Insert a recording row first (FK), then two legacy-shaped transcripts.
    insertTestRecording('rec_legacy_ok')   // helper per database.test.ts idiom
    insertTestRecording('rec_legacy_null')
    run(`INSERT INTO transcripts (id, recording_id, full_text, language, summary, transcription_model)
         VALUES ('trans_rec_legacy_ok', 'rec_legacy_ok', 'text', 'en', 'a real summary', 'gemini-2.0-flash-exp')`)
    run(`INSERT INTO transcripts (id, recording_id, full_text, language, summary, transcription_model)
         VALUES ('trans_rec_legacy_null', 'rec_legacy_null', 'text', 'en', NULL, 'gemini-2.0-flash-exp')`)
    // Run the exact backfill statement from MIGRATIONS[25]:
    run(`UPDATE transcripts SET summarization_provider='gemini', summarization_model=transcription_model
         WHERE full_text IS NOT NULL AND summary IS NOT NULL AND summarization_provider IS NULL`)
    const ok = queryOne<{ summarization_provider: string }>(
      "SELECT summarization_provider FROM transcripts WHERE recording_id='rec_legacy_ok'")
    const nul = queryOne<{ summarization_provider: string | null }>(
      "SELECT summarization_provider FROM transcripts WHERE recording_id='rec_legacy_null'")
    expect(ok?.summarization_provider).toBe('gemini')
    expect(nul?.summarization_provider).toBeNull()
  })
})
```

- [ ] **Step 2: Run it — must FAIL** (`column not found` / table missing):
`npx vitest run electron/main/services/__tests__/database-v25.test.ts` → FAIL.

- [ ] **Step 3: SCHEMA edits in `database.ts`.**
  (a) In the `transcripts` CREATE TABLE (line ~239), after `question_suggestions TEXT,` add:
```sql
    summarization_provider TEXT,
    summarization_model TEXT,
```
  (b) In the `transcription_queue` CREATE TABLE (line ~278), after `completed_at TEXT,` add:
```sql
    parked_until TEXT,
    first_parked_at TEXT,
```
  (c) After the `transcription_service_lock` CREATE TABLE block, add:
```sql
-- Auto-pipeline first-sync baseline (spec 2026-06-11 §5.5) — filename snapshot per device
CREATE TABLE IF NOT EXISTS sync_baseline_files (
    device_serial TEXT NOT NULL,
    filename      TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (device_serial, filename)
);
```

- [ ] **Step 4: `SCHEMA_VERSION` 24 → 25** (line 10): `const SCHEMA_VERSION = 25`.

- [ ] **Step 5: Add `MIGRATIONS[25]`** immediately after the `24:` entry's closing `},` (follow the guarded-ALTER pattern of `16:` at line ~955 exactly):

```ts
  25: () => {
    // v25: Auto-pipeline P1 (spec 2026-06-11 §5.8) — two-stage worker columns,
    // quota-parking columns, baseline snapshot table, and Stage-2 backfill.
    console.log('Running migration to schema v25: auto-pipeline two-stage columns')
    const database = getDatabase()

    const columnsToAdd = [
      'ALTER TABLE transcripts ADD COLUMN summarization_provider TEXT',
      'ALTER TABLE transcripts ADD COLUMN summarization_model TEXT',
      'ALTER TABLE transcription_queue ADD COLUMN parked_until TEXT',
      'ALTER TABLE transcription_queue ADD COLUMN first_parked_at TEXT'
    ]
    for (const sql of columnsToAdd) {
      try {
        database.run(sql)
      } catch {
        // Column already exists (fresh DB created from current SCHEMA) — ignore.
        console.log(`Column may already exist: ${sql}`)
      }
    }

    database.run(`
      CREATE TABLE IF NOT EXISTS sync_baseline_files (
        device_serial TEXT NOT NULL,
        filename      TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (device_serial, filename)
      )
    `)

    // Backfill: fused-flow transcripts with a REAL summary are Stage-2-complete.
    // Rows with NULL summary (the historical silent-failure path) keep a NULL marker:
    // they stay Stage-2-resumable and are recovered via Re-summarize (spec §5.6/§5.8).
    database.run(`
      UPDATE transcripts
      SET summarization_provider = 'gemini', summarization_model = transcription_model
      WHERE full_text IS NOT NULL AND summary IS NOT NULL AND summarization_provider IS NULL
    `)

    console.log('Migration v25 complete')
  },
```

- [ ] **Step 6: Type updates.** In the `Transcript` interface (line ~2151), after `question_suggestions?: string` add:
```ts
  summarization_provider?: string
  summarization_model?: string
```
In the `QueueItem` interface (line ~2273), after `completed_at?: string` add:
```ts
  parked_until?: string
  first_parked_at?: string
```

- [ ] **Step 7: Run the new test — PASS.** Also run the existing DB + smoke guards (fresh-boot path is exactly what commit 7a7c2b18 stabilized):
`npx vitest run electron/main/services/__tests__/database-v25.test.ts electron/main/services/__tests__/database.test.ts electron/main/services/__tests__/e2e-smoke.test.ts` → all pass.

- [ ] **Step 8: Commit.**
```bash
git add electron/main/services/database.ts electron/main/services/__tests__/database-v25.test.ts
git commit -m "feat(electron): schema v25 — two-stage transcript columns, parking columns, sync_baseline_files, Stage-2 backfill (auto-pipeline P1)"
```

---

### Task 2: Stage-write DB functions (`upsertTranscriptStage1`, `updateTranscriptStage2`)

**Files:**
- Modify: `electron/main/services/database.ts` (add the two functions directly below `insertTranscript`, ~line 2230)
- Test: extend `electron/main/services/__tests__/database-v25.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `database-v25.test.ts`):

```ts
describe('stage-write functions', () => {
  it('upsertTranscriptStage1 inserts and never touches Stage-2 columns on conflict', () => {
    insertTestRecording('rec_s1')
    upsertTranscriptStage1({
      recording_id: 'rec_s1', full_text: 'v1 text', language: undefined,
      word_count: 2, transcription_provider: 'gemini', transcription_model: 'gemini-2.0-flash-exp'
    })
    // Simulate Stage 2 having completed:
    run(`UPDATE transcripts SET summary='S', summarization_provider='gemini' WHERE recording_id='rec_s1'`)
    // A re-run of Stage 1 (e.g. explicit re-transcribe) must keep Stage-2 columns intact:
    upsertTranscriptStage1({
      recording_id: 'rec_s1', full_text: 'v2 text', language: 'en',
      word_count: 2, transcription_provider: 'gemini', transcription_model: 'gemini-2.0-flash-exp'
    })
    const row = queryOne<{ full_text: string; summary: string; summarization_provider: string; id: string }>(
      "SELECT id, full_text, summary, summarization_provider FROM transcripts WHERE recording_id='rec_s1'")
    expect(row?.full_text).toBe('v2 text')
    expect(row?.summary).toBe('S')                       // untouched
    expect(row?.summarization_provider).toBe('gemini')   // untouched
    expect(row?.id).toBe('trans_rec_s1')                 // id rule preserved
  })

  it('updateTranscriptStage2 writes content + marker atomically and COALESCEs language', () => {
    insertTestRecording('rec_s2')
    upsertTranscriptStage1({
      recording_id: 'rec_s2', full_text: 'hello world', language: undefined,
      word_count: 2, transcription_provider: 'gemini', transcription_model: 'm'
    })
    updateTranscriptStage2('rec_s2', {
      summary: 'sum', action_items: '["a"]', topics: '["t"]', key_points: '["k"]',
      title_suggestion: 'Title', question_suggestions: '["q?"]', language: 'en',
      summarization_provider: 'gemini', summarization_model: 'm'
    })
    const row = queryOne<Record<string, string>>("SELECT * FROM transcripts WHERE recording_id='rec_s2'")
    expect(row?.summary).toBe('sum')
    expect(row?.summarization_provider).toBe('gemini')
    expect(row?.language).toBe('en')   // was NULL from Stage 1 → analysis language wins
  })

  it('updateTranscriptStage2 does not overwrite an ASR-provided language', () => {
    insertTestRecording('rec_s3')
    upsertTranscriptStage1({
      recording_id: 'rec_s3', full_text: 'hola', language: 'es',
      word_count: 1, transcription_provider: 'openai-whisper', transcription_model: 'whisper-1'
    })
    updateTranscriptStage2('rec_s3', {
      summary: 's', language: 'en', summarization_provider: 'gemini', summarization_model: 'm'
    })
    const row = queryOne<{ language: string }>("SELECT language FROM transcripts WHERE recording_id='rec_s3'")
    expect(row?.language).toBe('es')   // COALESCE keeps the ASR value
  })
})
```

- [ ] **Step 2: Run — FAIL** (`upsertTranscriptStage1 is not defined`).

- [ ] **Step 3: Implement in `database.ts`** (below `insertTranscript`):

```ts
/**
 * Stage 1 write (auto-pipeline spec §5.3): persist ASR output without ever
 * touching Stage-2 (analysis) columns. The conflict target is the UNIQUE
 * recording_id; id keeps the existing `trans_${recordingId}` rule.
 * NOTE: language inserts as NULL when the ASR doesn't supply one (Gemini path) —
 * Stage 2 fills it via COALESCE. The schema DEFAULT 'es' applies only when the
 * column is omitted, which this INSERT never does.
 */
export function upsertTranscriptStage1(t: {
  recording_id: string
  full_text: string
  language?: string
  word_count?: number
  transcription_provider: string
  transcription_model?: string
}): void {
  run(
    `INSERT INTO transcripts (id, recording_id, full_text, language, word_count,
       transcription_provider, transcription_model)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(recording_id) DO UPDATE SET
       full_text = excluded.full_text,
       language = COALESCE(excluded.language, transcripts.language),
       word_count = excluded.word_count,
       transcription_provider = excluded.transcription_provider,
       transcription_model = excluded.transcription_model`,
    [
      `trans_${t.recording_id}`,
      t.recording_id,
      t.full_text,
      t.language ?? null,
      t.word_count ?? null,
      t.transcription_provider,
      t.transcription_model ?? null
    ]
  )
}

/**
 * Stage 2 write (auto-pipeline spec §5.3): one atomic UPDATE that sets the
 * analysis content AND the stage marker (summarization_provider). The marker
 * is written nowhere else. language uses COALESCE so an ASR-provided value
 * (whisper verbose_json) is never overwritten; Gemini rows (Stage-1 NULL)
 * receive the analysis language — identical to today's behavior.
 */
export function updateTranscriptStage2(recordingId: string, fields: {
  summary?: string
  action_items?: string
  topics?: string
  key_points?: string
  title_suggestion?: string
  question_suggestions?: string
  language?: string
  summarization_provider: string
  summarization_model?: string
}): void {
  run(
    `UPDATE transcripts SET
       summary = ?, action_items = ?, topics = ?, key_points = ?,
       title_suggestion = ?, question_suggestions = ?,
       language = COALESCE(language, ?),
       summarization_provider = ?, summarization_model = ?
     WHERE recording_id = ?`,
    [
      fields.summary ?? null,
      fields.action_items ?? null,
      fields.topics ?? null,
      fields.key_points ?? null,
      fields.title_suggestion ?? null,
      fields.question_suggestions ?? null,
      fields.language ?? null,
      fields.summarization_provider,
      fields.summarization_model ?? null,
      recordingId
    ]
  )
}
```

- [ ] **Step 4: Run — PASS:** `npx vitest run electron/main/services/__tests__/database-v25.test.ts`.

- [ ] **Step 5: Commit.**
```bash
git add electron/main/services/database.ts electron/main/services/__tests__/database-v25.test.ts
git commit -m "feat(electron): stage-write DB functions — upsertTranscriptStage1 / updateTranscriptStage2 (auto-pipeline P1)"
```

---

### Task 3: Provider layers (Gemini-only)

**Files:**
- Create: `electron/main/services/asr/asr-provider.ts`, `electron/main/services/asr/gemini-asr.ts`
- Create: `electron/main/services/llm/llm-provider.ts`, `electron/main/services/llm/gemini-llm.ts`
- Test: `electron/main/services/__tests__/providers-p1.test.ts`

The extraction sources are `transcription.ts:388-445` (audio call) and the `model.generateContent(prompt)` text idiom (`:341`, `:508`). Reuse today's exact error string `'Gemini API key not configured'` — it is in `NON_RETRYABLE_ERRORS` (`transcription.ts:138`) and LIKE-matched by §7.3 later.

- [ ] **Step 1: Write the failing tests.** Create `electron/main/services/__tests__/providers-p1.test.ts`. Mock `@google/generative-ai` the same way `transcription.test.ts` does (read its `vi.mock('@google/generative-ai', ...)` block and copy the idiom):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
// vi.mock('@google/generative-ai', ...) — copy the mock factory idiom from transcription.test.ts,
// exposing a capturable generateContent mock (e.g. mockGenerateContent).

import { getAsrProvider } from '../asr/asr-provider'
import { getLlmProvider } from '../llm/llm-provider'

const geminiConfig = {
  transcription: { provider: 'gemini', geminiApiKey: 'k', geminiModel: 'gemini-2.0-flash-exp', autoTranscribe: true }
} as never  // narrow test double of AppConfig — only the fields the factories read

describe('getAsrProvider (P1: gemini only)', () => {
  it('throws the canonical message when the key is missing', () => {
    const noKey = { transcription: { provider: 'gemini', geminiApiKey: '', geminiModel: 'm' } } as never
    expect(() => getAsrProvider(noKey)).toThrow('Gemini API key not configured')
  })

  it('transcribe() sends inline base64 + meeting context and returns { text }', async () => {
    mockGenerateContent.mockResolvedValueOnce({ response: { text: () => 'TRANSCRIBED' } })
    const asr = getAsrProvider(geminiConfig)
    // Use a real temp file so readFile works (copy the temp-audio-file helper from e2e-smoke.test.ts)
    const result = await asr.transcribe(tempAudioPath, { meetingContext: '\nCTX' })
    expect(result.text).toBe('TRANSCRIBED')
    expect(result.language).toBeUndefined()         // gemini-asr supplies no language (spec §5.3)
    const callArg = mockGenerateContent.mock.calls[0][0]
    expect(JSON.stringify(callArg)).toContain('inlineData')
    expect(JSON.stringify(callArg)).toContain('CTX')
  })
})

describe('getLlmProvider (P1: gemini only)', () => {
  it('throws the canonical message when the key is missing', () => {
    const noKey = { transcription: { provider: 'gemini', geminiApiKey: '', geminiModel: 'm' }, summarization: undefined } as never
    expect(() => getLlmProvider(noKey)).toThrow('Gemini API key not configured')
  })

  it('generate() returns the response text', async () => {
    mockGenerateContent.mockResolvedValueOnce({ response: { text: () => '{"summary":"s"}' } })
    const llm = getLlmProvider(geminiConfig)
    const out = await llm.generate('PROMPT', { json: true })
    expect(out).toBe('{"summary":"s"}')
    expect(mockGenerateContent).toHaveBeenCalledWith('PROMPT')
  })
})
```

- [ ] **Step 2: Run — FAIL** (modules don't exist).

- [ ] **Step 3: Implement.**

`electron/main/services/asr/asr-provider.ts`:
```ts
import type { AppConfig } from '../config'
import { createGeminiAsr } from './gemini-asr'

/** Result of an ASR run (spec §5.1). language is nullable — only engines that
 *  detect it (whisper-1 verbose_json, P2) supply it; gemini-asr does not. */
export interface AsrResult {
  text: string
  language?: string
}

export interface AsrProvider {
  transcribe(filePath: string, opts: { meetingContext?: string }): Promise<AsrResult>
}

/** Factory keyed on config.transcription.provider. P1 supports 'gemini' only;
 *  P2 adds 'openai-whisper'. Throws at construction when the selected
 *  provider's key is missing — this IS the Stage-1 key check (spec §5.3). */
export function getAsrProvider(config: AppConfig): AsrProvider {
  switch (config.transcription.provider) {
    case 'gemini':
      return createGeminiAsr(config)
    default:
      throw new Error(`Unknown ASR provider: ${String(config.transcription.provider)}`)
  }
}
```

`electron/main/services/asr/gemini-asr.ts` (the body of today's `transcription.ts:388-445`, moved — keep every detail identical: mime map incl. the `.hda` comment, prompt text, inline base64):
```ts
import { GoogleGenerativeAI } from '@google/generative-ai'
import { readFile } from 'fs'
import { promisify } from 'util'
import { extname } from 'path'
import type { AppConfig } from '../config'
import type { AsrProvider, AsrResult } from './asr-provider'

const readFileAsync = promisify(readFile)

export function createGeminiAsr(config: AppConfig): AsrProvider {
  if (!config.transcription.geminiApiKey) {
    // Canonical string — present in NON_RETRYABLE_ERRORS and §7.3 LIKE-matched.
    throw new Error('Gemini API key not configured')
  }
  const genAI = new GoogleGenerativeAI(config.transcription.geminiApiKey)
  const model = genAI.getGenerativeModel({
    model: config.transcription.geminiModel || 'gemini-2.0-flash-exp'
  })

  return {
    async transcribe(filePath: string, opts: { meetingContext?: string }): Promise<AsrResult> {
      const audioBuffer = await readFileAsync(filePath)
      const base64Audio = audioBuffer.toString('base64')

      const ext = extname(filePath).toLowerCase()
      const mimeTypes: Record<string, string> = {
        '.wav': 'audio/wav',
        '.mp3': 'audio/mp3',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
        '.webm': 'audio/webm',
        '.hda': 'audio/mp3' // HiDock H1E outputs MPEG MP3 format
      }
      const mimeType = mimeTypes[ext] || 'audio/wav'

      const transcriptionPrompt = `Transcribe this audio recording.
The audio may be in Spanish or English - transcribe in the original language.
Provide a clean, accurate transcription of all speech.
If there are multiple speakers, try to indicate speaker changes with "Speaker 1:", "Speaker 2:", etc.
${opts.meetingContext ?? ''}
Return ONLY the transcription, no additional commentary.`

      const result = await model.generateContent([
        { inlineData: { mimeType, data: base64Audio } },
        { text: transcriptionPrompt }
      ])

      // gemini-asr supplies no language — today's language comes from the
      // Stage-2 analysis JSON (spec §5.3 "language ownership").
      return { text: result.response.text() }
    }
  }
}
```

`electron/main/services/llm/llm-provider.ts`:
```ts
import type { AppConfig } from '../config'
import { createGeminiLlm } from './gemini-llm'

export interface LlmProvider {
  generate(prompt: string, opts?: { json?: boolean }): Promise<string>
}

/** Factory for the analysis/summarization stage. P1 supports 'gemini' only
 *  (config.summarization does not exist until P3 — default to gemini).
 *  Throws when the selected provider's key is missing — this IS the
 *  Stage-2 key check (spec §5.3). */
export function getLlmProvider(config: AppConfig): LlmProvider {
  const provider = (config as { summarization?: { provider?: string } }).summarization?.provider ?? 'gemini'
  switch (provider) {
    case 'gemini':
      return createGeminiLlm(config)
    default:
      throw new Error(`Unknown summarization provider: ${provider}`)
  }
}
```

`electron/main/services/llm/gemini-llm.ts`:
```ts
import { GoogleGenerativeAI } from '@google/generative-ai'
import type { AppConfig } from '../config'
import type { LlmProvider } from './llm-provider'

export function createGeminiLlm(config: AppConfig): LlmProvider {
  if (!config.transcription.geminiApiKey) {
    throw new Error('Gemini API key not configured')
  }
  const genAI = new GoogleGenerativeAI(config.transcription.geminiApiKey)
  const model = genAI.getGenerativeModel({
    model: config.transcription.geminiModel || 'gemini-2.0-flash-exp'
  })

  return {
    async generate(prompt: string): Promise<string> {
      // Gemini needs no special JSON mode here — today's prompts already
      // instruct JSON output and the worker extracts via fence/regex.
      const result = await model.generateContent(prompt)
      return result.response.text()
    }
  }
}
```

- [ ] **Step 4: Run — PASS:** `npx vitest run electron/main/services/__tests__/providers-p1.test.ts`.

- [ ] **Step 5: Commit.**
```bash
git add electron/main/services/asr electron/main/services/llm electron/main/services/__tests__/providers-p1.test.ts
git commit -m "feat(electron): ASR + LLM provider layers, Gemini implementations extracted (auto-pipeline P1)"
```

---

### Task 4: Two-stage worker refactor

**Files:**
- Modify: `electron/main/services/transcription.ts`
- Create (Test): `electron/main/services/__tests__/two-stage-worker.test.ts`

This is the core task. Read `transcription.ts` fully first. The refactor (spec §5.3):

1. `transcribeRecording` gains short-circuit + stage-resume.
2. Stage 1 = `getAsrProvider().transcribe()` + `upsertTranscriptStage1`. File-existence checks move INSIDE the Stage-1 branch.
3. Stage 2 = `getLlmProvider().generate(analysisPrompt)`; extraction failure (no-match OR parse error) **throws**; `updateTranscriptStage2` is the single marker write; status `'complete'` set right after (same point as today); auto-rename gated on pre-read `title_suggestion IS NULL`; actionables delete-and-replace; `detectActionables` routed through the LLM provider.
4. The queue-level Gemini pre-check (`processQueue` lines 107-131) is **removed** — per-stage checks replace it (the provider factories throw the same canonical string, so `NON_RETRYABLE_ERRORS` still matches; items fail one-by-one instead of being mass-marked, same terminal state — spec AC7 exception).

- [ ] **Step 1: Write the failing tests.** Create `electron/main/services/__tests__/two-stage-worker.test.ts`. Use `transcription.test.ts`'s setup idiom (its DB init + `@google/generative-ai` mock + temp audio file helper). Drive the worker through `transcribeManually(recordingId)` (exported; calls `transcribeRecording` directly). The Gemini mock must distinguish calls: audio calls receive an ARRAY argument, text calls a STRING — have `mockGenerateContent` route on `typeof arg === 'string'`.

```ts
describe('two-stage worker (auto-pipeline P1, spec §5.3)', () => {
  it('full run writes both stages and the marker', async () => {
    // arrange: recording row + real temp audio file; mock: audio call -> 'FULL TEXT',
    // text calls -> '{"summary":"S","action_items":[],"topics":[],"key_points":[],"title_suggestion":"T","question_suggestions":[],"language":"en"}'
    // and the actionables call -> '[]'
    await transcribeManually('rec1')
    const row = getTranscriptByRecordingId('rec1')!
    expect(row.full_text).toBe('FULL TEXT')
    expect(row.summary).toBe('S')
    expect(row.transcription_provider).toBe('gemini')
    expect(row.summarization_provider).toBe('gemini')
    expect(row.language).toBe('en')                    // COALESCE path (Stage-1 NULL)
    // recording status complete:
    expect(getRecordingById('rec1')!.transcription_status).toBe('complete')
  })

  it('Stage-2 extraction failure THROWS and leaves the marker NULL with full_text persisted', async () => {
    // mock: audio -> 'FULL TEXT'; analysis text call -> 'no json here at all'
    await expect(transcribeManually('rec2')).rejects.toThrow(/extraction/i)
    const row = getTranscriptByRecordingId('rec2')!
    expect(row.full_text).toBe('FULL TEXT')            // Stage 1 persisted before the failure
    expect(row.summarization_provider).toBeNull()      // marker NULL = Stage 2 incomplete
    expect(row.summary).toBeNull()                     // no sentinel ever written
  })

  it('stage-resume: full_text + NULL marker -> Stage 2 only (no ASR call, no file needed)', async () => {
    // arrange: transcript row pre-seeded via upsertTranscriptStage1 with full_text,
    // recording.file_path pointing at a NON-EXISTENT path (audio deleted),
    // mock text call -> valid analysis JSON
    await transcribeManually('rec3')
    expect(audioCallCount()).toBe(0)                   // ASR was skipped
    const row = getTranscriptByRecordingId('rec3')!
    expect(row.summarization_provider).toBe('gemini')
  })

  it('short-circuit: full_text + marker set -> no-op success', async () => {
    // arrange: row with full_text AND summarization_provider='gemini'
    await transcribeManually('rec4')
    expect(audioCallCount()).toBe(0)
    expect(textCallCount()).toBe(0)
  })

  it('auto-rename only when pre-existing title_suggestion was NULL', async () => {
    // run once on rec5 (title_suggestion NULL) -> updateKnowledgeCaptureTitle called;
    // clear marker (resummarize semantics: summarization_provider=NULL), run again
    // with a NEW title in the mock -> updateKnowledgeCaptureTitle NOT called again.
    // (Spy on the DB title update: pre-create a knowledge_captures row per the
    //  e2e-smoke idiom and assert its title after each run.)
  })

  it('actionables are delete-and-replace for pending rows (no duplicates on re-run)', async () => {
    // mock actionables call -> one detection with confidence 0.9 twice in a row
    // (run, clear marker, run again) -> exactly ONE pending actionables row remains.
  })
})
```
Write real arrange code for every test (copy the recording-insert + temp-file helpers from `transcription.test.ts` / `e2e-smoke.test.ts`); the comments above describe intent, your test code must be concrete.

- [ ] **Step 2: Run — FAIL** (current worker writes one fused row; no marker semantics).

- [ ] **Step 3: Refactor `transcribeRecording` in `transcription.ts`.** Replace lines 364-678 with the two-stage version. Key excerpts (full function — adapt surrounding imports: add `getTranscriptByRecordingId`, `upsertTranscriptStage1`, `updateTranscriptStage2` to the database import; add the two factory imports; remove the now-unused direct `GoogleGenerativeAI` audio usage from this function — `detectActionables` switches to the LLM provider too):

```ts
async function transcribeRecording(
  recordingId: string,
  progressCallback?: (stage: string, progress: number) => void
): Promise<void> {
  const recording = getRecordingById(recordingId)
  if (!recording) {
    throw new Error(`Recording not found or no local file: ${recordingId}`)
  }

  const config = getConfig()
  const existing = getTranscriptByRecordingId(recordingId)

  // Short-circuit (spec §5.3): both stages done -> duplicate queue items are no-ops.
  if (existing?.full_text && existing.summarization_provider) {
    console.log(`[Transcription] ${recordingId} already fully transcribed — short-circuit`)
    updateRecordingTranscriptionStatus(recordingId, 'complete')
    return
  }

  updateRecordingTranscriptionStatus(recordingId, 'processing')

  const candidateMeetings = findCandidateMeetingsForRecording(recordingId)
  console.log(`Found ${candidateMeetings.length} candidate meetings for recording ${recordingId}`)

  const stage2Only = Boolean(existing?.full_text && !existing.summarization_provider)
  let fullText: string

  if (stage2Only) {
    // Stage-2-only run (resume / resummarize): needs only full_text — no audio file.
    fullText = existing!.full_text
    progressCallback?.('analyzing', 50)
  } else {
    // ===== Stage 1: ASR =====
    if (!recording.file_path) {
      throw new Error(`Recording not found or no local file: ${recordingId}`)
    }
    if (!existsSync(recording.file_path)) {
      throw new Error(`Recording file not found: ${recording.file_path}`)
    }
    progressCallback?.('reading_file', 5)

    let meetingContext = ''
    if (candidateMeetings.length > 0) {
      meetingContext = `\n\nPOSSIBLE MEETING CONTEXT (use this to improve transcription accuracy):
${candidateMeetings.map((m, i) => `
Meeting ${i + 1}: "${m.subject}"
  Time: ${new Date(m.start_time).toLocaleString()} - ${new Date(m.end_time).toLocaleString()}
  ${m.organizer_name ? `Organizer: ${m.organizer_name}` : ''}
  ${m.location ? `Location: ${m.location}` : ''}
  ${m.description ? `Description: ${m.description.slice(0, 200)}...` : ''}
`).join('\n')}`
    }

    progressCallback?.('transcribing', 20)
    const asr = getAsrProvider(config) // throws canonical key-missing message (Stage-1 check)
    const asrResult = await asr.transcribe(recording.file_path, { meetingContext })
    fullText = asrResult.text

    const wordCount = fullText.split(/\s+/).filter((w) => w.length > 0).length
    upsertTranscriptStage1({
      recording_id: recordingId,
      full_text: fullText,
      language: asrResult.language,
      word_count: wordCount,
      transcription_provider: config.transcription.provider,
      transcription_model: config.transcription.geminiModel
    })
    progressCallback?.('analyzing', 50)
  }

  // ===== Stage 2: Analysis =====
  const llm = getLlmProvider(config) // throws canonical key-missing message (Stage-2 check)

  // [meetingSelectionSection block — UNCHANGED, copy lines 450-474 verbatim]
  // [analysisPrompt template — UNCHANGED, copy lines 477-506 verbatim, using fullText]

  const analysisText = await llm.generate(analysisPrompt, { json: true })

  // Extraction (spec §5.3): no-match AND parse-error both THROW. No sentinels.
  const jsonMatch = analysisText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(`Analysis JSON extraction failed: no JSON object in response (${analysisText.slice(0, 120)})`)
  }
  let analysis: { /* same shape annotation as today, lines 512-523 */ }
  try {
    analysis = JSON.parse(jsonMatch[0])
  } catch (e) {
    throw new Error(`Analysis JSON extraction failed: ${e instanceof Error ? e.message : 'parse error'}`)
  }

  // [AI meeting-selection block — UNCHANGED in P1, copy lines 537-564 verbatim]

  // Auto-rename predicate (spec §5.3): pre-read BEFORE the Stage-2 write.
  const preUpdate = getTranscriptByRecordingId(recordingId)
  const isFirstTitle = !preUpdate?.title_suggestion

  updateTranscriptStage2(recordingId, {
    summary: analysis.summary,
    action_items: analysis.action_items ? JSON.stringify(analysis.action_items) : undefined,
    topics: analysis.topics ? JSON.stringify(analysis.topics) : undefined,
    key_points: analysis.key_points ? JSON.stringify(analysis.key_points) : undefined,
    title_suggestion: analysis.title_suggestion,
    question_suggestions: analysis.question_suggestions ? JSON.stringify(analysis.question_suggestions) : undefined,
    language: analysis.language || 'unknown',
    summarization_provider: 'gemini', // P3 will derive this from config.summarization
    summarization_model: config.transcription.geminiModel
  })
  updateRecordingTranscriptionStatus(recordingId, 'complete') // same point as today (:590)

  if (analysis.title_suggestion && isFirstTitle) {
    updateKnowledgeCaptureTitle(recordingId, analysis.title_suggestion)
  }

  progressCallback?.('detecting_actionables', 75)
  // [actionables block — copy lines 600-648, with TWO changes:
  //  (1) before the INSERT loop: run("DELETE FROM actionables WHERE source_knowledge_id = ? AND status = 'pending'", [sourceKnowledgeId])
  //      — implements spec §5.3's delete-and-replace, deliberately refined to PENDING rows only
  //      so user-actioned (in-progress/completed) actionables survive a re-run; the §5.3 goal is
  //      "no duplicate pending cards", which this satisfies. Note the refinement in your report.
  //  (2) detectActionables now takes the llm provider — see Step 4.]

  progressCallback?.('indexing', 85)
  // [vector-store block — UNCHANGED, copy lines 652-674 verbatim]

  progressCallback?.('complete', 100)
  console.log(`Transcription complete: ${recording.filename}`)
}
```

- [ ] **Step 4: Route `detectActionables` through the LLM provider.** Change its signature to accept the provider and drop its own Gemini construction (lines 293-297 + 337-342):

```ts
async function detectActionables(
  llm: LlmProvider,
  transcriptText: string,
  knowledgeCaptureId: string,
  metadata: { title?: string; questions?: string[] }
): Promise<ActionableDetection[]> {
  // [word-count guard + truncation + prompt — UNCHANGED, lines 299-335]
  try {
    const responseText = await llm.generate(prompt, { json: true })
    // [JSON array extraction + confidence filter — UNCHANGED, lines 344-357]
  } catch (error) {
    console.error('[Actionable Detection] Failed:', error)
    return [] // graceful skip — unchanged
  }
}
```
The caller passes the already-constructed `llm`. The old key-missing early-return (lines 294-297) is now covered by the catch (factory construction happened earlier in Stage 2; if you reach actionables, the key exists).

- [ ] **Step 5: Remove the queue-level pre-check.** In `processQueue`, delete lines 107-131 (the `if (!config.transcription.geminiApiKey) { ... mass-fail ... return }` block) and the now-unused `const config = getConfig()` if nothing else in the function reads it. Per-stage factory throws replace it; the thrown string still matches `NON_RETRYABLE_ERRORS`.

- [ ] **Step 6: Run the new worker tests — PASS:** `npx vitest run electron/main/services/__tests__/two-stage-worker.test.ts`.

- [ ] **Step 7: Realign existing transcription tests.** Run:
`npx vitest run electron/main/services/__tests__/transcription.test.ts electron/main/services/__tests__/transcription-b007.test.ts electron/main/services/__tests__/e2e-smoke.test.ts`
Expected breakages and their fixes (anything else = investigate, don't paper over):
  - Tests asserting the **fused single-row write** → assert the same final row content (it's identical) — usually no change needed since the end state matches.
  - Tests asserting **`summary: 'Analysis failed'` on parse failure** → now assert the job REJECTS with `/extraction/` and the row keeps `summarization_provider NULL` (spec AC7 exception (a); cite it in a comment).
  - Tests asserting the **queue-level mass-fail on missing key** → now assert items fail individually as processed with the same message (same terminal state).
  - `e2e-smoke.test.ts` should pass unchanged (happy path, same end state, plus Task 1's column assertions if you added them there).

- [ ] **Step 8: Commit.**
```bash
git add electron/main/services/transcription.ts electron/main/services/__tests__/
git commit -m "feat(electron): two-stage transcription worker — stage marker, resume, short-circuit, throw-on-extraction-failure, per-stage key checks (auto-pipeline P1)"
```

---

### Task 5: Queue hardening

**Files:**
- Modify: `electron/main/services/database.ts` (`addToQueue`, line ~2286)
- Modify: `electron/main/ipc/recording-handlers.ts` (`recordings:transcribe`, line ~241)
- Test: extend `database-v25.test.ts`; check `src/hooks/__tests__/useOperations*` if present

- [ ] **Step 1: Write the failing dedupe test** (append to `database-v25.test.ts`):

```ts
describe('addToQueue dedupe (spec §5.7)', () => {
  it('returns the existing pending item id instead of inserting a duplicate', () => {
    insertTestRecording('rec_q1')
    const first = addToQueue('rec_q1')
    const second = addToQueue('rec_q1')
    expect(second).toBe(first)   // truthy + identical (return contract)
    const rows = queryAll("SELECT id FROM transcription_queue WHERE recording_id='rec_q1'")
    expect(rows.length).toBe(1)
  })

  it('allows a new item once the prior one is terminal', () => {
    insertTestRecording('rec_q2')
    const first = addToQueue('rec_q2')
    updateQueueItem(first, 'completed')
    const second = addToQueue('rec_q2')
    expect(second).not.toBe(first)
  })
})
```

- [ ] **Step 2: Run — FAIL** (two rows inserted).

- [ ] **Step 3: Implement dedupe** (replace `addToQueue` in `database.ts`):

```ts
/** Insert a queue item — deduped (spec §5.7): if a pending/processing item already
 *  exists for this recording, return ITS id (truthy contract — useOperations.ts
 *  treats falsy as failure). Parked items keep status='pending' (§7.2), so this
 *  covers them automatically. Terminal items (completed/failed/cancelled) do not
 *  block a fresh queue entry. */
export function addToQueue(recordingId: string): string {
  const existing = queryOne<{ id: string }>(
    "SELECT id FROM transcription_queue WHERE recording_id = ? AND status IN ('pending', 'processing') ORDER BY created_at DESC LIMIT 1",
    [recordingId]
  )
  if (existing) return existing.id
  const id = crypto.randomUUID()
  run('INSERT INTO transcription_queue (id, recording_id) VALUES (?, ?)', [id, recordingId])
  return id
}
```

- [ ] **Step 4: Run — PASS**, then re-run `download-service` suites (they call `addToQueue` via the auto-transcribe hook):
`npx vitest run electron/main/services/__tests__/database-v25.test.ts electron/main/services/__tests__/download-service.test.ts`

- [ ] **Step 5: Re-route `recordings:transcribe` through the queue.** In `recording-handlers.ts` (lines ~241-254), replace the `transcribeManually` call:

```ts
  // Transcribe a recording manually — routed through the queue (spec §5.7):
  // the direct transcribeManually call bypassed the mutex/retry machinery and
  // could double-bill metered ASR by racing the queue processor.
  ipcMain.handle('recordings:transcribe', async (_, recordingId: unknown): Promise<void> => {
    try {
      const result = TranscribeRecordingSchema.safeParse({ recordingId })
      if (!result.success) {
        console.error('recordings:transcribe validation error:', result.error)
        throw new Error(result.error.issues[0]?.message || 'Invalid request')
      }

      const { addToQueue } = await import('../services/database')
      const { processQueueManually } = await import('../services/transcription')
      addToQueue(result.data.recordingId)
      await processQueueManually()
    } catch (error) {
      console.error('recordings:transcribe error:', error)
      throw error
    }
  })
```
(Match the file's existing import style — if it already imports these statically, use static imports instead of dynamic.) `transcribeManually` stays exported — `e2e-smoke.test.ts` drives it directly by design.

- [ ] **Step 6: Run the IPC + renderer suites:**
`npx vitest run electron/main/ipc/__tests__/recording-handlers.test.ts` and, if present, `npx vitest run src/hooks/__tests__ --reporter=basic 2>&1 | tail -5`. Realign any `recordings:transcribe` test that asserted `transcribeManually` was called directly — it should now assert queue insertion (spec §5.7).

- [ ] **Step 6b: Renderer idempotent registration (spec §5.7).** Dedupe means a caller can now receive an id it has already registered. Read how `src/hooks/useOperations.ts:52-56` hands the returned id to the transcription store (`src/store/features/useTranscriptionStore.ts`): if the store APPENDS blindly on register, change it to upsert-by-id (no duplicate UI rows on double-click); if it already keys by id, no change — state which in your report. Run the store's test file if one exists.

- [ ] **Step 7: Commit.**
```bash
git add electron/main/services/database.ts electron/main/ipc/recording-handlers.ts electron/main/services/__tests__/database-v25.test.ts
git commit -m "feat(electron): queue hardening — addToQueue dedupe + recordings:transcribe routed through the queue (auto-pipeline P1)"
```

---

### Task 6: Full gates + behavior-identical verification (AC7/AC8 evidence)

**Files:** none new — verification only.

- [ ] **Step 1: Full gates.** From `apps/electron`:
```bash
npm run typecheck && npm run lint && npm run test:run
```
Expected: 0 typecheck errors, 0 lint errors, all tests pass. Fix anything that fails; if a fix changes behavior beyond this plan's scope, STOP and report.

- [ ] **Step 2: AC8 evidence.** Confirm the two-stage tests cover: duplicate `addToQueue` → one transcription (dedupe test) and worker short-circuit (no-op test). Quote both test names in your report.

- [ ] **Step 3: AC7 evidence.** In your report, list every existing-test realignment you made in Tasks 4-5, each annotated with the spec section that authorizes it (§5.3 throw-on-extraction; per-stage key checks; §5.7 queue routing). Anything realigned WITHOUT a citation is a red flag — surface it.

- [ ] **Step 4: Commit any stragglers**, then report status DONE with: gate outputs (tail lines), list of realigned tests + citations, and any DONE_WITH_CONCERNS items.

---

## Done criteria (maps to spec §12 P1)

- [ ] Schema v25 live: 4 new columns + `sync_baseline_files` on fresh boot AND via guarded migration; backfill leaves NULL-summary legacy rows resumable (Task 1).
- [ ] Stage writes are the only marker writers; Stage 1 never touches Stage-2 columns (Task 2).
- [ ] Provider layers in place, Gemini-only, canonical key-missing strings (Task 3).
- [ ] Worker: short-circuit, stage-resume (no audio needed for Stage 2), throw-on-extraction-failure both paths, auto-rename predicate, pending-actionables delete-and-replace, per-stage key checks replacing the queue-level block (Task 4).
- [ ] `addToQueue` deduped with truthy-id contract; `recordings:transcribe` enqueues (Task 5).
- [ ] `npm run typecheck && npm run lint && npm run test:run` fully green (Task 6).

## Explicitly NOT in P1 (later phases — do not build)

- Whisper ASR / ffmpeg / `openaiApiKey` / Settings cards / `transcription:validateConfig` (P2)
- Ollama Cloud LLM / `config.summarization` section / meeting-selection validator / `transcription:resummarize` IPC + panel (P3)
- 429 parking behavior, key-fix re-pend, failure chip (P4 — the columns exist from Task 1, dormant)
- Baseline snapshot logic / `ensure-baseline` IPC / auto-sync changes (P5)
- Integration e2e variant + physical device check (P6)
