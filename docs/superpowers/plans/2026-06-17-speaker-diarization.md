# Speaker Diarization Implementation Plan

> **For agentic workers — REQUIRED SUB-SKILL:** before executing any task in this plan you MUST load and follow `superpowers:executing-plans`, and for each task's implementation MUST follow `superpowers:test-driven-development` (write the failing Vitest first, then implement). Tests are Vitest run from `apps/electron`; all `fetch`, `child_process`/`spawn`, `electron` (`safeStorage`/`ipcMain`), `sherpa-onnx-node`, and `../services/database` are MOCKED — **mocks-first, zero real-hardware/USB/network**. No USB/jensen/transfer/download code is touched anywhere in this plan. Quality gate per task: `npm run typecheck && npm run lint && npm run test:run`.

**Goal:** Make AssemblyAI Universal-3 Pro the default ASR so every new recording is transcribed with structured speaker turns ("Speaker A/B/C…") in one cloud call; let the user map each generic label to a Contact (inline quick-add, pre-filled from the meeting's calendar attendees); render the transcript speaker-attributed; feed speaker-labeled input to the existing Ollama summary stage; and capture a voiceprint embedding on every manual mapping so a Phase-2 auto-ID layer launches pre-trained. A missing AssemblyAI key **fails loudly** (preflight blocks queueing; any forced job terminal-fails non-retryably) and **never silently falls back** to Gemini/Whisper. (Spec: `docs/superpowers/specs/2026-06-17-speaker-diarization-design.md`, rev 3.)

**Architecture:** Reuses the existing two-stage transcription worker (AP-§5.3), queue hardening, failure taxonomy + parking, cost caps (AP-§5.5/AC10), and config-encryption recipe (AP-§5.4) **unchanged**. New AssemblyAI behavior slots behind the existing `AsrProvider` interface (`getAsrProvider` gains an `'assemblyai'` branch). `AsrResult` is widened with an optional `turns: Turn[]`; Whisper/Gemini leave it undefined (legacy text-prefix render path preserved). Stage 1 (`upsertTranscriptStage1`) **additively** persists `turns` + `speakers` roster + `sentiment` roster-summary without touching Stage-2 columns. A v26 migration adds `transcripts.turns` and the `recording_speakers` + `voiceprints` tables. Mapping UI lives in `SourceDetailDrawer.tsx` (Speakers panel) and renders structured turns in `TranscriptViewer.tsx`. A `speakers:assign` IPC writes a user mapping and fires the on-device (`sherpa-onnx-node`, CPU, no Python) voiceprint capture hook. Stage 2 summary input is rebuilt from labeled turns; a staleness badge prompts a manual resummarize after mapping. Re-transcribe is manual + confirmed and drops prior speaker mappings.

**Tech Stack:** Electron 39 main process (Node.js, TypeScript); React 18 + TypeScript renderer; SQLite via `sql.js` (WASM). AssemblyAI async/batch REST (`/v2/upload` → `/v2/transcript` → poll `/v2/transcript/{id}`) via plain `fetch` (no SDK), `speech_models:['universal-3-pro','universal-2']` (plural array; never singular `speech_model`; never `word_boost`), `model_region:'global'`, `speaker_labels`, `sentiment_analysis`, `keyterms_prompt`, `language_code:'en'`. `sherpa-onnx-node` (Apache-2.0, prebuilt `sherpa-onnx-win-x64` `.node` addon) pinned in `optionalDependencies` + bundled `wespeaker_en_voxceleb_resnet34_LM.onnx` (`asarUnpack`, mirroring `ffmpeg-static`). `ffmpeg-static` (already bundled) reused for a distinct `-ar 16000 -ac 1 -f pcm_s16le pipe:1` decode. Config secrets via Electron `safeStorage`. Vitest for all tests.

---

## File Structure

**Created:**
- `electron/main/services/asr/assemblyai-asr.ts` (D1) — AssemblyAI `AsrProvider`: upload → submit (`speech_models`/`speaker_labels`/`sentiment`/`keyterms`/`global`) → bounded-backoff poll with hard wall-clock cap → map `utterances` (seconds → ms ×1000) into `Turn[]`; key used main-side only as `Authorization`.
- `electron/main/ipc/speakers-handlers.ts` (D3, extended D4) — `registerSpeakersHandlers`; `speakers:assign(recordingId, fileLabel, contactId)` writes a `recording_speakers` row (`source='user'`) and (D4) fires the voiceprint capture hook.
- `electron/main/services/voiceprint-service.ts` (D4) — lazy `sherpa-onnx-node` load with `isVoiceprintAvailable()` graceful-degrade gate; `captureVoiceprint(...)`: ffmpeg PCM decode + ≥10 s clean-speech (overlap-excluded) gate + mean-pooled embedding BLOB store.
- `src/features/library/components/SpeakersPanel.tsx` (D3) — per-`file_label` row (turn-count + talk-time), attendee-prefilled Contact picker, inline quick-add, reassign/merge controls; rendered inside `SourceDetailDrawer.tsx`.
- A reusable inline quick-add component (D3) — "Create contact '<name>'" → `contacts:create` → create+assign; also un-stubs the `People.tsx` "Coming soon" button.
- `src/.../ConfirmDialog` usage for re-transcribe (D5) — renderer confirmation before `recordings:transcribe` on an already-transcribed recording.

**Modified:**
- `electron/main/services/asr/asr-provider.ts` (D1) — add `interface Turn`; widen `AsrResult` with optional `turns?: Turn[]`; add `case 'assemblyai' → createAssemblyAiAsr(config)` to `getAsrProvider`.
- `electron/main/services/config.ts` (D1) — widen `transcription.provider` to include `'assemblyai'`; **default `'assemblyai'`**; add encrypted `assemblyaiApiKey` (both encrypt/decrypt sites + `__enc__` guard) and `assemblyaiModels` (default `['universal-3-pro','universal-2']`).
- `electron/main/services/transcription.ts` (D1: NON_RETRYABLE markers + preflight; D2: Stage-1 persistence; D5: labeled summary input + clearing short-circuit markers) — extend `NON_RETRYABLE_ERRORS`/`validateTranscriptionConfig`; extend `upsertTranscriptStage1` callsite to pass `turns`/`speakers`/`sentiment`; build labeled Stage-2 input from turns.
- `electron/main/ipc/recording-handlers.ts` (D1: re-pend marker; D5: re-transcribe overwrite) — add `'AssemblyAI'` to the `rependFailedItems([...])` array (`:364`); ensure `recordings:transcribe` clears `full_text`/`summarization_provider` markers (defeats the `:431` short-circuit) and drops prior `recording_speakers`; `transcription:isSummaryStale` handler (D5).
- `electron/main/services/database.ts` (D2) — bump `SCHEMA_VERSION` 25 → 26 + `MIGRATIONS[26]`; add `transcripts.turns TEXT` (SCHEMA edit + guarded `ALTER`); `CREATE TABLE IF NOT EXISTS recording_speakers` + `voiceprints`; extend `upsertTranscriptStage1` to additively write `turns`/`speakers`/`sentiment`; add `recording_speakers` + `voiceprints` helpers; (D5) `buildAttributedTranscript` / `isSummaryStale` SQL.
- `electron/main/ipc/contacts-handlers.ts` (D3) — add `contacts:create` handler wrapping `upsertContact` and returning `mapToPerson(...)` (a `Person`).
- `electron/preload/index.ts` (D3/D4/D5) — bridge `contacts:create`, `speakers:assign`, `transcription:isSummaryStale`.
- `src/features/library/components/TranscriptViewer.tsx` (D3) — add `turns?: Turn[]` prop; render structured turns (color-coded badge, `TimeAnchor` seek) when present, else fall back to today's text-prefix parser.
- `src/features/library/components/SourceDetailDrawer.tsx` (D3, D5) — host SpeakersPanel + disclosure; (D5) wire `onResummarize`/staleness badge; drawer date label now means "last processed".
- `src/pages/People.tsx` (D3) — un-stub the disabled quick-add button using the shared component.
- Settings UI (D3) — privacy disclosure above the AssemblyAI key field.
- `apps/electron/package.json` + electron-builder config (D4) — pin `sherpa-onnx-node` in `optionalDependencies`; `asarUnpack` the addon + WeSpeaker model.
- `electron/main/services/__tests__/e2e-smoke.test.ts` (D2) — assert v26 `turns` column + `recording_speakers`/`voiceprints` tables on fresh boot.

## Integration Corrections (AUTHORITATIVE — override any divergent phase text below)

These resolve cross-phase inconsistencies found in the consistency pass. Where a task's code or naming below diverges from this section, **this section wins**; the per-task reviewer (subagent-driven-development) MUST enforce it.

### Canonical `recording_speakers` DB helpers (D2 owns `database.ts`; D3/D4/D5 import these EXACT names)
- `upsertRecordingSpeaker(recordingId, fileLabel, { contactId, confidence, source })`
- `getRecordingSpeakers(recordingId)`
- `deleteRecordingSpeaker(recordingId, fileLabel)`  — single row, used by MERGE
- `deleteRecordingSpeakersForRecording(recordingId)`  — whole recording, used by RE-TRANSCRIBE

Do **not** introduce `insertRecordingSpeaker`, `clearRecordingSpeakers`, `deleteRecordingSpeakers`, or a DB-layer `mergeRecordingSpeaker`. **Merge C→A** is done in the handler: rewrite turns `speaker:'C'→'A'`, `deleteRecordingSpeaker(recordingId,'C')`, and `upsertRecordingSpeaker` for A. **Re-transcribe** calls `deleteRecordingSpeakersForRecording(recordingId)`.

### `Turn` single source of truth
`Turn` and `AsrResult.turns?` are declared ONCE in `electron/main/services/asr/asr-provider.ts` (D1). D2/D3/D4/D5 **import** `Turn`; none redeclare it. String-literal members use single quotes (`'POSITIVE'|'NEUTRAL'|'NEGATIVE'`) to match lint.

### `transcripts.sentiment` derivation (D2)
`deriveSpeakerRosterSummary(turns)` → `{ [fileLabel]: 'POSITIVE'|'NEUTRAL'|'NEGATIVE' }` = per-label **majority** of that label's `Turn.sentiment`; ties broken by fixed precedence **POSITIVE > NEUTRAL > NEGATIVE** (order-independent; matches the spec's "majority" intent — NOT first-seen). Deterministic unit test required. D5 reads this shape only.

### `contacts:create` returns `Person` (D3)
Handler: `const c = upsertContact({ name, email?, role?, company?, type? }); return success(mapToPerson(c))`. IPC return type is `Person` (via `mapToPerson`), matching `contacts:getAll/getById`. The test asserts the `Person` shape, not the raw `Contact`.

### Timestamp parity for `isSummaryStale` (D4 + D5)
`recording_speakers.created_at` (D4) and the Stage-2 summary timestamp must be comparable. **Canonical:** D4's `speakers:assign` writes `created_at` via SQLite `datetime('now')` (space format, UTC), NOT JS `toISOString()`. D5's `isSummaryStale` normalizes both sides with `datetime(...)`. Pin this in D4's write task; D5's SQL + test use the same.

### Re-transcribe actually re-runs ASR (D5 — fixes AC6)
`transcription.ts` short-circuits when `full_text && summarization_provider` are both set. So on a re-transcribe confirm the `recordings:transcribe` handler (recording-handlers.ts) MUST — **before** `addToQueue` — clear `full_text` + `summarization_provider` (+ Stage-2 markers) AND call `deleteRecordingSpeakersForRecording(recordingId)`. D5 owns this; add a regression test asserting a re-queued completed recording re-invokes the (mocked) AssemblyAI provider and prior `recording_speakers` rows are gone.

### Re-pend marker (D1 — fixes AC7)
At `recording-handlers.ts:364`, add `'AssemblyAI'` to the `rependFailedItems([...])` array (it is a substring of the thrown `'AssemblyAI API key not configured'`). Add that full string to `NON_RETRYABLE_ERRORS` (transcription.ts). Test: the missing-key throw is non-retryable; a key-save `retryAll` re-pends it.

### Coverage additions
- **D3:** add unit tests for (a) Speakers-panel **turn-count** (= number of `Turn` entries for the label) and **talk-time** (= Σ(endMs−startMs), overlaps NOT double-counted, `HH:MM:SS`); (b) **single-speaker** → panel read-only (no merge); (c) **zero-speaker** (empty `turns`) → panel hidden + Stage 2 proceeds on `full_text`.
- **D1:** add a unit test for `keyterms_prompt` build/cap (≤1000 phrases, ≤6 words each; mutually exclusive with `prompt`) alongside the negative `word_boost` assertion; add the `model_region:'global'` in-region-swap code comment (no test).
- **Deferred to Phase 2 (explicit):** word-level click-a-word-to-seek. v1 keeps per-turn `TimeAnchor` seek only.

---

### Task 0: Validation spike (GATE — do before D1)

**Type:** Manual, non-coded. **Owner: the user.** **Spec: §13, AC0.** No code is written, no branch touched, no dependency installed until this records a **dated PASS**. D1 MUST NOT begin until the PASS line below is filled in.

**Procedure:**
1. Select **≥ 5 of your own real recordings totalling ≥ 30 min**, deliberately spanning **1:1 and multi-speaker** conversations (include at least one "larger/messier" meeting).
2. Sign up for the **AssemblyAI free tier** ($50 non-expiring credit). For each sample, submit one async job to `POST /v2/transcript` (after `/v2/upload`) with exactly: `speech_models:["universal-3-pro","universal-2"]`, `speaker_labels:true`, `sentiment_analysis:true`, `keyterms_prompt:[<your contact/company/project names>]`, `model_region:"global"`, `language_code:"en"`. Poll `GET /v2/transcript/{id}` to `completed`. Do **not** send singular `speech_model` and do **not** send `word_boost`.
3. For ≥ 2 samples, also transcribe with the current `whisper-1` path (or compare against a known-good reference) to establish the WER baseline.
4. Decode **one** sample to 16 kHz mono PCM to confirm voiceprint feasibility: `ffmpeg -i <sample> -ar 16000 -ac 1 -f pcm_s16le out.pcm` (or `pipe:1`).

**PASS (ALL of a, b, c must hold):**
- **(a) Word accuracy** ≥ the current `whisper-1` baseline on the same audio — spot-WER on **≥ 2 samples** (AssemblyAI WER ≤ whisper-1 WER on each).
- **(b) Coherent speaker attribution** — the speaker turns match how the conversation actually went, with **no phantom speakers** (a label with no real distinct speaker) and **no merged speakers** (two real people collapsed into one label) on **≥ 4 of the 5** samples.
- **(c) PCM decode** of the chosen sample completes with no ffmpeg error and produces non-empty 16 kHz mono `pcm_s16le` output.

**Record before D1 (fill in and commit/note):**
```
AC0 VALIDATION SPIKE — RESULT: PASS / FAIL
Date: 2026-06-17 (YYYY-MM-DD)
Samples: <n> files, <total minutes> min (mix: <n 1:1 / n multi>)
(a) WER vs whisper-1: sample1 AAI __% vs whisper __%; sample2 AAI __% vs whisper __% → PASS/FAIL
(b) Speaker coherence: __/5 samples clean (no phantom/merged) → PASS/FAIL
(c) 16kHz mono PCM decode of <sample>: OK / FAIL
Recorded by: <user>
```

**On FAIL (any of a/b/c not met):** STOP. Do **not** start D1. Escalate to the **pyannoteAI + ElevenLabs two-stage alternative** and revise the spec; re-run this gate against the new provider before any coding.

## Phase D1 — AssemblyAI provider + `AsrResult.turns` + config + loud no-key preflight

> **Spec sections:** §5 (request shape), §6.1 (provider layer), §6.2 (config / no silent migration), §8 (missing-key). **ACs:** AC1 (structured `turns` produced), AC7 (missing-key terminal-fail + re-pend), AC8 (`speech_models` array, never singular/`word_boost`, `model_region:'global'`; no-`turns` provider is unaffected), AC9 (loud fail, no silent fallback; default provider `assemblyai`).
>
> **Scope guardrail:** D1 only (a) extends the `AsrResult`/`Turn` types, (b) adds the `assemblyai` branch to `getAsrProvider`, (c) implements `createAssemblyAiAsr`, (d) widens config + adds the two new fields with both-site encryption + the new default, (e) extends `validateTranscriptionConfig`/the preflight + the NON_RETRYABLE/retryAll markers. **Persistence of `turns`/`speakers`/`sentiment` into the DB is D2** — `upsertTranscriptStage1` is NOT touched here. **No USB/jensen/transfer code is touched.** All tests mock `fetch` and `electron`; no real network, no real hardware.
>
> **Tests are Vitest, run from `apps/electron`.** Mirror the existing style in `electron/main/services/__tests__/whisper-asr.test.ts` (hoisted state, `vi.stubGlobal('fetch', …)`, `@vitest-environment node`) and `electron/main/services/__tests__/config-crypto.test.ts` (per-test temp dir, `vi.mock('electron')` with a fake `safeStorage`, `vi.resetModules()` for cold-start reload).

---

### Task D1-T1: Extend `AsrResult` with `turns` and declare the `Turn` type

**Files:**
- Modify: `electron/main/services/asr/asr-provider.ts` (interface block at lines 5-14)
- Test: `electron/main/services/asr/__tests__/asr-provider.test.ts` (Create — new `__tests__` dir under `asr/`)

This task is type-only plus the `getAsrProvider` switch. Because the new `case 'assemblyai'` calls a factory that does not exist yet, T1 writes the type test + a switch test that uses a **mocked** `createAssemblyAiAsr` (the real one lands in T3). The mock keeps T1 independently green.

- [ ] **Step 1: Write the failing test for the `Turn`/`AsrResult` shape and the `assemblyai` switch case.**
  Create `electron/main/services/asr/__tests__/asr-provider.test.ts`:
  ```ts
  /**
   * asr-provider tests — speaker-diarization D1, Task 1.
   *
   * Verifies the AsrResult.turns extension (structural — turns optional, Turn
   * shape) and that getAsrProvider routes 'assemblyai' to createAssemblyAiAsr,
   * 'gemini'/'openai-whisper' to their factories, and THROWS on unknown
   * (no silent fallback — spec §6.2/AC9). The three factory modules are mocked
   * so this test exercises only the switch.
   *
   * @vitest-environment node
   */
  import { describe, it, expect, vi } from 'vitest'

  vi.mock('../gemini-asr', () => ({ createGeminiAsr: vi.fn(() => ({ transcribe: vi.fn() })) }))
  vi.mock('../whisper-asr', () => ({ createWhisperAsr: vi.fn(() => ({ transcribe: vi.fn() })) }))
  vi.mock('../assemblyai-asr', () => ({ createAssemblyAiAsr: vi.fn(() => ({ transcribe: vi.fn() })) }))

  import { getAsrProvider, type AsrResult, type Turn } from '../asr-provider'
  import { createGeminiAsr } from '../gemini-asr'
  import { createWhisperAsr } from '../whisper-asr'
  import { createAssemblyAiAsr } from '../assemblyai-asr'

  function cfg(provider: string): never {
    return { transcription: { provider } } as never
  }

  describe('AsrResult.turns — structural', () => {
    it('accepts a result with structured turns (Turn shape per §6.1)', () => {
      const turn: Turn = {
        speaker: 'A',
        startMs: 0,
        endMs: 1500,
        text: 'hello',
        words: [{ text: 'hello', startMs: 0, endMs: 1500 }],
        sentiment: 'POSITIVE'
      }
      const result: AsrResult = { text: 'hello', language: 'en', turns: [turn] }
      expect(result.turns?.[0].startMs).toBe(0)
      expect(result.turns?.[0].sentiment).toBe('POSITIVE')
    })

    it('accepts a result with no turns (Whisper/Gemini stay undefined)', () => {
      const result: AsrResult = { text: 'plain' }
      expect(result.turns).toBeUndefined()
    })
  })

  describe('getAsrProvider — routing', () => {
    it("routes 'assemblyai' to createAssemblyAiAsr", () => {
      getAsrProvider(cfg('assemblyai'))
      expect(createAssemblyAiAsr).toHaveBeenCalledTimes(1)
    })

    it("routes 'gemini' to createGeminiAsr", () => {
      getAsrProvider(cfg('gemini'))
      expect(createGeminiAsr).toHaveBeenCalledTimes(1)
    })

    it("routes 'openai-whisper' to createWhisperAsr", () => {
      getAsrProvider(cfg('openai-whisper'))
      expect(createWhisperAsr).toHaveBeenCalledTimes(1)
    })

    it('throws on an unknown provider — never silently falls back (AC9)', () => {
      expect(() => getAsrProvider(cfg('made-up'))).toThrow(/Unknown ASR provider/)
    })
  })
  ```

- [ ] **Step 2: Run the test — expect FAIL (type + missing module).**
  ```
  cd apps/electron && npx vitest run electron/main/services/asr/__tests__/asr-provider.test.ts
  ```
  Expected: failure — `Failed to resolve import "../assemblyai-asr"` (module does not exist yet) and/or a TS error that `Turn` is not exported. The whole file errors before any assertion runs.

- [ ] **Step 3: Add the `Turn` type and extend `AsrResult` and the switch.**
  In `electron/main/services/asr/asr-provider.ts`, replace the import block + result interface (current lines 1-28) with:
  ```ts
  import type { AppConfig } from '../config'
  import { createGeminiAsr } from './gemini-asr'
  import { createWhisperAsr } from './whisper-asr'
  import { createAssemblyAiAsr } from './assemblyai-asr'

  /** One diarized speaker turn (spec §6.1). startMs/endMs are MILLISECONDS
   *  (AssemblyAI utterances are seconds — the provider converts ×1000). */
  export interface Turn {
    speaker: string
    startMs: number
    endMs: number
    text: string
    words?: Array<{ text: string; startMs: number; endMs: number }>
    sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
  }

  /** Result of an ASR run (spec §5.1/§6.1). `language` is nullable — only engines
   *  that detect it (whisper-1 verbose_json) supply it. `turns` is OPTIONAL — only
   *  diarizing engines (AssemblyAI) supply it; gemini/whisper leave it undefined. */
  export interface AsrResult {
    text: string
    language?: string
    turns?: Turn[]
  }

  export interface AsrProvider {
    transcribe(filePath: string, opts: { meetingContext?: string }): Promise<AsrResult>
  }

  /** Factory keyed on config.transcription.provider. Selects EXACTLY the configured
   *  provider and throws on unknown — there is NO silent fallback to another
   *  provider (spec §6.2/AC9). The missing-key guard lives in each factory. */
  export function getAsrProvider(config: AppConfig): AsrProvider {
    switch (config.transcription.provider) {
      case 'assemblyai':
        return createAssemblyAiAsr(config)
      case 'gemini':
        return createGeminiAsr(config)
      case 'openai-whisper':
        return createWhisperAsr(config)
      default:
        throw new Error(`Unknown ASR provider: ${String(config.transcription.provider)}`)
    }
  }
  ```

- [ ] **Step 4: Run the test — expect PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/services/asr/__tests__/asr-provider.test.ts
  ```
  Expected: `Test Files  1 passed (1)` / `Tests  6 passed (6)`. (The `../assemblyai-asr` import resolves because it is mocked; the real module arrives in T3.)

- [ ] **Step 5: Commit.**
  ```
  git add electron/main/services/asr/asr-provider.ts electron/main/services/asr/__tests__/asr-provider.test.ts && git commit -m "feat(electron): D1 — extend AsrResult with optional turns + Turn type + assemblyai switch case

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D1-T2: Config — widen provider, add `assemblyaiApiKey`/`assemblyaiModels`, default `assemblyai`, both-site encryption

**Files:**
- Modify: `electron/main/services/config.ts`
  - `transcription` interface (lines 37-45)
  - `DEFAULT_CONFIG.transcription` (lines 91-99)
  - `initializeConfig` decrypt list (after line 156, the `openaiApiKey` decrypt block)
  - `saveConfig` `toWrite.transcription` encrypt block (lines 193-196)
- Test: `electron/main/services/__tests__/config-assemblyai.test.ts` (Create — mirror `config-crypto.test.ts`)

- [ ] **Step 1: Write the failing config test (defaults + both-site crypto cold-start + idempotency).**
  Create `electron/main/services/__tests__/config-assemblyai.test.ts`:
  ```ts
  /**
   * config — AssemblyAI fields (speaker-diarization D1, Task 2).
   *
   * Verifies: provider defaults to 'assemblyai' (§6.2), assemblyaiModels default,
   * assemblyaiApiKey defaults to '', and the cold-start round-trip (save → disk
   * has __enc__ → reload decrypts) for assemblyaiApiKey at BOTH sites
   * (saveConfig encrypt + initializeConfig decrypt) + __enc__ idempotency.
   * Mirrors config-crypto.test.ts.
   *
   * @vitest-environment node
   */
  import { describe, it, expect, vi, beforeEach } from 'vitest'
  import { mkdtempSync, readFileSync } from 'fs'
  import { join } from 'path'
  import { tmpdir } from 'os'

  let currentTmpDir: string

  beforeEach(() => {
    currentTmpDir = mkdtempSync(join(tmpdir(), 'hidock-cfg-aai-'))
    vi.resetModules()
    vi.mock('electron', () => ({
      app: {
        getPath: (name: string) => {
          if (name === 'userData') return currentTmpDir
          if (name === 'home') return currentTmpDir
          return currentTmpDir
        }
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from('ENC:' + s),
        decryptString: (b: Buffer) => b.toString().replace(/^ENC:/, '')
      }
    }))
  })

  describe('config — AssemblyAI defaults (§6.2)', () => {
    it('fresh initializeConfig → provider=assemblyai, assemblyaiApiKey="", models default', async () => {
      const { initializeConfig, getConfig } = await import('../config')
      await initializeConfig()
      const cfg = getConfig()
      expect(cfg.transcription.provider).toBe('assemblyai')
      expect(cfg.transcription.assemblyaiApiKey).toBe('')
      expect(cfg.transcription.assemblyaiModels).toEqual(['universal-3-pro', 'universal-2'])
    })
  })

  describe('config — assemblyaiApiKey crypto (both sites)', () => {
    it('cold-start round-trip: save → disk has __enc__ → reload decrypts', async () => {
      const { initializeConfig, saveConfig, getConfig } = await import('../config')
      await initializeConfig()

      const base = getConfig()
      await saveConfig({
        transcription: { ...base.transcription, assemblyaiApiKey: 'aai-secret' }
      })

      const configPath = join(currentTmpDir, 'config.json')
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(raw.transcription.assemblyaiApiKey).toMatch(/^__enc__/)
      expect(raw.transcription.assemblyaiApiKey).not.toContain('aai-secret')

      vi.resetModules()
      vi.mock('electron', () => ({
        app: {
          getPath: (name: string) => {
            if (name === 'userData') return currentTmpDir
            if (name === 'home') return currentTmpDir
            return currentTmpDir
          }
        },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (s: string) => Buffer.from('ENC:' + s),
          decryptString: (b: Buffer) => b.toString().replace(/^ENC:/, '')
        }
      }))
      const mod2 = await import('../config')
      await mod2.initializeConfig()
      expect(mod2.getConfig().transcription.assemblyaiApiKey).toBe('aai-secret')
    })

    it('__enc__ idempotency: an already-encrypted assemblyaiApiKey is not double-wrapped', async () => {
      const { initializeConfig, saveConfig, getConfig } = await import('../config')
      await initializeConfig()
      const base = getConfig()
      // First save encrypts.
      await saveConfig({ transcription: { ...base.transcription, assemblyaiApiKey: 'aai-secret' } })
      const configPath = join(currentTmpDir, 'config.json')
      const once = JSON.parse(readFileSync(configPath, 'utf-8')).transcription.assemblyaiApiKey
      // In-memory config now holds the decrypted value; a second save must not double-wrap.
      await saveConfig({ transcription: { ...getConfig().transcription } })
      const twice = JSON.parse(readFileSync(configPath, 'utf-8')).transcription.assemblyaiApiKey
      expect(twice).toBe(once)
      expect(twice.startsWith('__enc____enc__')).toBe(false)
    })
  })
  ```

- [ ] **Step 2: Run the test — expect FAIL.**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/config-assemblyai.test.ts
  ```
  Expected: failures — `expected 'gemini' to be 'assemblyai'`, `cfg.transcription.assemblyaiModels` is `undefined`, and the disk value for `assemblyaiApiKey` is plaintext (`/^__enc__/` does not match) because `saveConfig` does not yet encrypt it.

- [ ] **Step 3: Widen the `transcription` interface.**
  In `electron/main/services/config.ts`, replace the `transcription` block (lines 37-45):
  ```ts
    transcription: {
      provider: 'gemini' | 'openai-whisper' | 'assemblyai'
      geminiApiKey: string
      geminiModel: string
      openaiApiKey: string   // safeStorage-encrypted at rest (spec §5.4); decrypted in memory
      whisperModel: string   // fixed 'whisper-1' in v1 (spec §5.1; 4o-transcribe deferred §10)
      assemblyaiApiKey: string   // NEW — safeStorage-encrypted at rest (spec §6.2); decrypted in memory
      assemblyaiModels: string[] // NEW — priority-ordered speech_models (spec §5/§6.2)
      autoTranscribe: boolean
      language: string
    }
  ```

- [ ] **Step 4: Flip the default + add the new field defaults.**
  Replace `DEFAULT_CONFIG.transcription` (lines 91-99):
  ```ts
    transcription: {
      provider: 'assemblyai', // spec §6.2 — diarization is the default ASR; missing key fails LOUD (no silent fallback)
      geminiApiKey: '',
      geminiModel: 'gemini-3-pro-preview', // Best model for audio transcription
      openaiApiKey: '',
      whisperModel: 'whisper-1',
      assemblyaiApiKey: '',
      assemblyaiModels: ['universal-3-pro', 'universal-2'], // PLURAL array; never singular speech_model (spec §5)
      autoTranscribe: true,
      language: 'en'
    },
  ```

- [ ] **Step 5: Decrypt at load (`initializeConfig`).**
  In `initializeConfig`, immediately after the `openaiApiKey` decrypt block (currently lines 154-156), add:
  ```ts
        if (savedConfig.transcription?.assemblyaiApiKey) {
          savedConfig.transcription.assemblyaiApiKey = decryptSensitive(savedConfig.transcription.assemblyaiApiKey)
        }
  ```

- [ ] **Step 6: Encrypt at save (`saveConfig`).**
  In `saveConfig`'s `toWrite` object, replace the `transcription` block (currently lines 193-196):
  ```ts
      transcription: {
        ...config.transcription,
        openaiApiKey: encryptSensitive(config.transcription.openaiApiKey),
        assemblyaiApiKey: encryptSensitive(config.transcription.assemblyaiApiKey)
      },
  ```

- [ ] **Step 7: Run the test — expect PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/config-assemblyai.test.ts
  ```
  Expected: `Tests  3 passed (3)`.

- [ ] **Step 8: Guard the existing crypto test that asserts the old default.**
  `config-crypto.test.ts` test #3 asserts `cfg.transcription.provider` is `'gemini'`. That assertion is now stale. Open `electron/main/services/__tests__/config-crypto.test.ts` and change the assertion at line 152 from:
  ```ts
      expect(cfg.transcription.provider).toBe('gemini')
  ```
  to:
  ```ts
      expect(cfg.transcription.provider).toBe('assemblyai') // D1 §6.2 flipped the default
  ```
  Then run it to confirm green:
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/config-crypto.test.ts
  ```
  Expected: `Tests  6 passed (6)` (or whatever the prior count was — all passing, no regression).

- [ ] **Step 9: Commit.**
  ```
  git add electron/main/services/config.ts electron/main/services/__tests__/config-assemblyai.test.ts electron/main/services/__tests__/config-crypto.test.ts && git commit -m "feat(electron): D1 — config gains assemblyaiApiKey (encrypted both sites) + assemblyaiModels; default provider flips to assemblyai

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D1-T3: Implement `createAssemblyAiAsr` (upload → submit → poll → `Turn[]`)

**Files:**
- Create: `electron/main/services/asr/assemblyai-asr.ts`
- Test: `electron/main/services/asr/__tests__/assemblyai-asr.test.ts` (Create)

The provider: throw a canonical loud message when the key is empty (§8/AC9); upload bytes; submit with the **plural** `speech_models` array (`universal-3-pro`,`universal-2`), `model_region:'global'`, `speaker_labels`, `sentiment_analysis`, `keyterms_prompt`, `language_code:'en'` (AC8 — never singular `speech_model`, never `word_boost`); poll until `completed`/`error`; map `utterances` → `Turn[]` converting **seconds → ms ×1000** (AC1). Errors: 401 → `ProviderAuthError`, 429 → `ProviderRateLimitError`, `status:'error'`/timeout → retryable `Error` (§8/AC7).

- [ ] **Step 1: Write the failing provider test (happy path + AC8 body assertions + seconds→ms + key guard + errors).**
  Create `electron/main/services/asr/__tests__/assemblyai-asr.test.ts`:
  ```ts
  /**
   * assemblyai-asr tests — speaker-diarization D1, Task 3.
   *
   * Verifies the AssemblyAI provider: loud key-missing guard (§8/AC9), the
   * upload→submit→poll flow, the submit body (speech_models ARRAY incl.
   * universal-3-pro, model_region 'global', speaker_labels, sentiment_analysis,
   * keyterms_prompt, language_code 'en' — and NEVER singular speech_model,
   * NEVER word_boost — AC8), utterances→Turn[] with SECONDS→ms ×1000 (AC1),
   * roster, and 401/429/error/poll-timeout classification (§8/AC7).
   *
   * fs.readFileSync is mocked (no real file). global fetch is stubbed.
   *
   * @vitest-environment node
   */
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

  vi.mock('fs', () => ({ readFileSync: vi.fn(() => Buffer.from('AUDIO')) }))

  import { createAssemblyAiAsr } from '../assemblyai-asr'
  import { ProviderRateLimitError, ProviderAuthError } from '../provider-errors'

  function aaiConfig(
    assemblyaiApiKey = 'aai-key',
    assemblyaiModels = ['universal-3-pro', 'universal-2'],
    language = 'en'
  ): never {
    return { transcription: { provider: 'assemblyai', assemblyaiApiKey, assemblyaiModels, language } } as never
  }

  function res(opts: { status?: number; ok?: boolean; jsonBody?: unknown; textBody?: string; retryAfter?: string }) {
    const status = opts.status ?? 200
    const headers = new Map<string, string>()
    if (opts.retryAfter) headers.set('Retry-After', opts.retryAfter)
    return {
      status,
      ok: opts.ok ?? (status >= 200 && status < 300),
      headers: { get: (k: string) => headers.get(k) ?? null },
      json: async () => opts.jsonBody,
      text: async () => opts.textBody ?? ''
    }
  }

  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe('createAssemblyAiAsr — construction', () => {
    it('throws a loud canonical message when the key is missing (§8/AC9)', () => {
      expect(() => createAssemblyAiAsr(aaiConfig(''))).toThrow(
        'AssemblyAI API key not configured — add it in Settings → Transcription'
      )
    })
  })

  describe('createAssemblyAiAsr — happy path', () => {
    beforeEach(() => {
      fetchMock
        // 1. upload
        .mockResolvedValueOnce(res({ jsonBody: { upload_url: 'https://cdn.assemblyai.com/up/abc' } }))
        // 2. submit
        .mockResolvedValueOnce(res({ jsonBody: { id: 'txn_1', status: 'queued' } }))
        // 3. poll → completed
        .mockResolvedValueOnce(
          res({
            jsonBody: {
              id: 'txn_1',
              status: 'completed',
              text: 'Hello there. General Kenobi.',
              language_code: 'en',
              speech_model_used: 'universal-3-pro',
              utterances: [
                { speaker: 'A', start: 0, end: 1.5, text: 'Hello there.', sentiment: 'POSITIVE',
                  words: [{ text: 'Hello', start: 0, end: 0.5 }, { text: 'there.', start: 0.5, end: 1.5 }] },
                { speaker: 'B', start: 2, end: 3.25, text: 'General Kenobi.', sentiment: 'NEUTRAL',
                  words: [{ text: 'General', start: 2, end: 2.6 }, { text: 'Kenobi.', start: 2.6, end: 3.25 }] }
              ]
            }
          })
        )
    })

    it('returns text + language + structured turns with SECONDS→ms ×1000 (AC1)', async () => {
      const asr = createAssemblyAiAsr(aaiConfig())
      const result = await asr.transcribe('/recordings/a.hda', {})
      expect(result.text).toBe('Hello there. General Kenobi.')
      expect(result.language).toBe('en')
      expect(result.turns).toHaveLength(2)
      expect(result.turns![0]).toEqual({
        speaker: 'A',
        startMs: 0,
        endMs: 1500,
        text: 'Hello there.',
        sentiment: 'POSITIVE',
        words: [
          { text: 'Hello', startMs: 0, endMs: 500 },
          { text: 'there.', startMs: 500, endMs: 1500 }
        ]
      })
      expect(result.turns![1].startMs).toBe(2000)
      expect(result.turns![1].endMs).toBe(3250)
      expect(result.turns![1].sentiment).toBe('NEUTRAL')
    })

    it('submit body uses speech_models ARRAY incl. universal-3-pro, global region, labels+sentiment, language_code; NEVER singular speech_model or word_boost (AC8)', async () => {
      const asr = createAssemblyAiAsr(aaiConfig())
      await asr.transcribe('/recordings/a.hda', { meetingContext: 'Acme Corp; Project Phoenix' })

      // call[0] = upload, call[1] = submit
      const [uploadUrl, uploadInit] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(uploadUrl).toBe('https://api.assemblyai.com/v2/upload')
      expect((uploadInit.headers as Record<string, string>).Authorization).toBe('aai-key')

      const [submitUrl, submitInit] = fetchMock.mock.calls[1] as [string, RequestInit]
      expect(submitUrl).toBe('https://api.assemblyai.com/v2/transcript')
      expect((submitInit.headers as Record<string, string>).Authorization).toBe('aai-key')
      const body = JSON.parse(submitInit.body as string)
      expect(body.audio_url).toBe('https://cdn.assemblyai.com/up/abc')
      expect(Array.isArray(body.speech_models)).toBe(true)
      expect(body.speech_models).toEqual(['universal-3-pro', 'universal-2'])
      expect(body.model_region).toBe('global')
      expect(body.speaker_labels).toBe(true)
      expect(body.sentiment_analysis).toBe(true)
      expect(body.language_code).toBe('en')
      // forbidden keys — the rev-1 blocker + word_boost downgrade trap
      expect(body).not.toHaveProperty('speech_model')
      expect(body).not.toHaveProperty('word_boost')
    })

    it('builds keyterms_prompt from meetingContext (NOT word_boost)', async () => {
      const asr = createAssemblyAiAsr(aaiConfig())
      await asr.transcribe('/recordings/a.hda', { meetingContext: 'Acme Corp; Project Phoenix' })
      const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)
      expect(Array.isArray(body.keyterms_prompt)).toBe(true)
      expect(body.keyterms_prompt).toContain('Acme Corp')
      expect(body.keyterms_prompt).toContain('Project Phoenix')
    })
  })

  describe('createAssemblyAiAsr — error classification (§8/AC7)', () => {
    it('401 on submit → ProviderAuthError(AssemblyAI)', async () => {
      fetchMock
        .mockResolvedValueOnce(res({ jsonBody: { upload_url: 'u' } }))
        .mockResolvedValueOnce(res({ status: 401, textBody: 'unauthorized' }))
      const asr = createAssemblyAiAsr(aaiConfig())
      const err = await asr.transcribe('/r/a.hda', {}).catch((e) => e)
      expect(err).toBeInstanceOf(ProviderAuthError)
      expect((err as Error).message).toContain('AssemblyAI API key was rejected')
    })

    it('429 on submit → ProviderRateLimitError with retryAfterMs', async () => {
      fetchMock
        .mockResolvedValueOnce(res({ jsonBody: { upload_url: 'u' } }))
        .mockResolvedValueOnce(res({ status: 429, textBody: 'slow down', retryAfter: '30' }))
      const asr = createAssemblyAiAsr(aaiConfig())
      const err = await asr.transcribe('/r/a.hda', {}).catch((e) => e)
      expect(err).toBeInstanceOf(ProviderRateLimitError)
      expect((err as ProviderRateLimitError).provider).toBe('AssemblyAI')
      expect((err as ProviderRateLimitError).retryAfterMs).toBe(30000)
    })

    it("poll status 'error' → terminal retryable Error with the AssemblyAI message", async () => {
      fetchMock
        .mockResolvedValueOnce(res({ jsonBody: { upload_url: 'u' } }))
        .mockResolvedValueOnce(res({ jsonBody: { id: 'txn_1', status: 'queued' } }))
        .mockResolvedValueOnce(res({ jsonBody: { id: 'txn_1', status: 'error', error: 'transcoding failed' } }))
      const asr = createAssemblyAiAsr(aaiConfig())
      const err = await asr.transcribe('/r/a.hda', {}).catch((e) => e)
      expect((err as Error).message).toContain('AssemblyAI transcription failed')
      expect((err as Error).message).toContain('transcoding failed')
    })
  })
  ```

- [ ] **Step 2: Run the test — expect FAIL.**
  ```
  cd apps/electron && npx vitest run electron/main/services/asr/__tests__/assemblyai-asr.test.ts
  ```
  Expected: failure — `Failed to resolve import "../assemblyai-asr"` (file does not exist).

- [ ] **Step 3: Implement the provider.**
  Create `electron/main/services/asr/assemblyai-asr.ts`:
  ```ts
  import { readFileSync } from 'fs'
  import type { AppConfig } from '../config'
  import type { AsrProvider, AsrResult, Turn } from './asr-provider'
  import { ProviderRateLimitError, ProviderAuthError } from '../provider-errors'

  const BASE = 'https://api.assemblyai.com/v2'
  const HTTP_TIMEOUT_MS = 10 * 60 * 1000 // per-HTTP-call AbortController cap (AP-§7.4)
  const POLL_INTERVAL_MS = 3000          // bounded poll interval
  const POLL_WALL_CLOCK_MS = 30 * 60 * 1000 // hard cap so a hung job cannot run forever (§8)
  const KEYTERM_MAX = 1000               // keyterms_prompt cap (spec §2)

  /** Map seconds (AssemblyAI) → ms; null/undefined → 0. */
  function secToMs(s: number | undefined | null): number {
    return Math.round((s ?? 0) * 1000)
  }

  /** Build keyterms_prompt from the worker's meetingContext: split on
   *  newlines/semicolons, trim, drop empties, cap to 1000 (spec §2). FREE; this
   *  is NOT word_boost (word_boost silently downgrades the job — spec §2). */
  function buildKeyterms(meetingContext?: string): string[] {
    if (!meetingContext) return []
    return meetingContext
      .split(/[\n;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, KEYTERM_MAX)
  }

  interface AaiWord { text: string; start: number; end: number }
  interface AaiUtterance {
    speaker: string
    start: number
    end: number
    text: string
    sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
    words?: AaiWord[]
  }
  interface AaiTranscript {
    id: string
    status: 'queued' | 'processing' | 'completed' | 'error'
    text?: string
    language_code?: string
    error?: string
    speech_model_used?: string
    utterances?: AaiUtterance[]
  }

  async function aaiFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /** Throw the right typed error for a non-OK AssemblyAI response (§8/AC7). */
  async function throwForStatus(res: Response, what: string): Promise<never> {
    if (res.status === 401) throw new ProviderAuthError('AssemblyAI')
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After')
      throw new ProviderRateLimitError('AssemblyAI', retryAfter ? Number(retryAfter) * 1000 : undefined)
    }
    const body = (await res.text()).slice(0, 200)
    throw new Error(`AssemblyAI ${what} failed (HTTP ${res.status}): ${body}`)
  }

  export function createAssemblyAiAsr(config: AppConfig): AsrProvider {
    const apiKey = config.transcription.assemblyaiApiKey
    if (!apiKey) {
      // Loud, canonical — present in NON_RETRYABLE_ERRORS; NEVER a silent fallback (spec §8/§6.2/AC9).
      throw new Error('AssemblyAI API key not configured — add it in Settings → Transcription')
    }
    // PLURAL array; never the singular speech_model (streaming-only / invalid here — spec §5).
    const speechModels =
      config.transcription.assemblyaiModels && config.transcription.assemblyaiModels.length > 0
        ? config.transcription.assemblyaiModels
        : ['universal-3-pro', 'universal-2']
    const languageCode = config.transcription.language || 'en'

    return {
      async transcribe(filePath: string, opts: { meetingContext?: string }): Promise<AsrResult> {
        // 1. Upload the bytes (Authorization is the raw key — no "Bearer ").
        const audio = readFileSync(filePath)
        const uploadRes = await aaiFetch(`${BASE}/upload`, {
          method: 'POST',
          headers: { Authorization: apiKey, 'Content-Type': 'application/octet-stream' },
          body: audio
        })
        if (!uploadRes.ok) await throwForStatus(uploadRes, 'upload')
        const { upload_url } = (await uploadRes.json()) as { upload_url: string }

        // 2. Submit. speech_models PLURAL; keyterms_prompt (NOT word_boost); model_region 'global'.
        const submitBody = {
          audio_url: upload_url,
          speech_models: speechModels,
          model_region: 'global', // spec §2 — dodge the 2026-07-01 in-region bump; US in-region swap is a future residency change
          speaker_labels: true,
          sentiment_analysis: true,
          keyterms_prompt: buildKeyterms(opts.meetingContext),
          language_code: languageCode
        }
        const submitRes = await aaiFetch(`${BASE}/transcript`, {
          method: 'POST',
          headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(submitBody)
        })
        if (!submitRes.ok) await throwForStatus(submitRes, 'submit')
        const submitted = (await submitRes.json()) as AaiTranscript

        // 3. Poll until completed/error, with a hard wall-clock cap (§8).
        const deadline = Date.now() + POLL_WALL_CLOCK_MS
        let txn: AaiTranscript = submitted
        while (txn.status !== 'completed' && txn.status !== 'error') {
          if (Date.now() > deadline) {
            throw new Error('AssemblyAI poll timed out — retry')
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
          const pollRes = await aaiFetch(`${BASE}/transcript/${submitted.id}`, {
            method: 'GET',
            headers: { Authorization: apiKey }
          })
          if (!pollRes.ok) await throwForStatus(pollRes, 'poll')
          txn = (await pollRes.json()) as AaiTranscript
        }
        if (txn.status === 'error') {
          throw new Error(`AssemblyAI transcription failed: ${txn.error ?? 'unknown error'}`)
        }

        console.log(`[AssemblyAI] speech_model_used=${txn.speech_model_used ?? 'unknown'}`)

        // 4. Map utterances → Turn[], converting SECONDS → ms ×1000 (spec §5/AC1).
        const turns: Turn[] = (txn.utterances ?? []).map((u) => {
          const turn: Turn = {
            speaker: u.speaker,
            startMs: secToMs(u.start),
            endMs: secToMs(u.end),
            text: u.text
          }
          if (u.sentiment) turn.sentiment = u.sentiment
          if (u.words && u.words.length > 0) {
            turn.words = u.words.map((w) => ({ text: w.text, startMs: secToMs(w.start), endMs: secToMs(w.end) }))
          }
          return turn
        })

        return { text: txn.text ?? '', language: txn.language_code, turns }
      }
    }
  }
  ```

- [ ] **Step 4: Run the test — expect PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/services/asr/__tests__/assemblyai-asr.test.ts
  ```
  Expected: `Tests  7 passed (7)`. Note: the happy-path tests resolve poll on the first GET; the `setTimeout(POLL_INTERVAL_MS)` runs with real timers — at 3s the test is still well under Vitest's default timeout, but if it feels slow, no fake timers are needed because the mock returns `completed` on the first poll (one 3s wait). If you prefer instant, add `vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)` in those tests — optional refactor.

- [ ] **Step 5: Commit.**
  ```
  git add electron/main/services/asr/assemblyai-asr.ts electron/main/services/asr/__tests__/assemblyai-asr.test.ts && git commit -m "feat(electron): D1 — AssemblyAI ASR provider (upload->submit->poll->Turn[]); speech_models array, global region, keyterms (never speech_model/word_boost); seconds->ms

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D1-T4: Loud no-key preflight + non-retryable terminal-fail + re-pend marker (AC7/AC9)

**Files:**
- Modify: `electron/main/ipc/recording-handlers.ts`
  - `validateTranscriptionConfig` (lines 64-88) — add the `assemblyai` ASR branch
  - `transcription:retryAll` re-pend markers (line 364) — add `'AssemblyAI'`
- Modify: `electron/main/services/transcription.ts`
  - `NON_RETRYABLE_ERRORS` array (lines 119-132) — add the AssemblyAI key string
- Test: `electron/main/ipc/__tests__/recording-handlers.test.ts` (append a describe block; mirror existing `validateTranscriptionConfig`/`addToQueue` tests)
- Test: `electron/main/services/__tests__/transcription-nonretryable.test.ts` (Create — minimal, asserts the constant contains the AssemblyAI string)

The renderer preflight (`useOperations.queueTranscription`) and `recordings:addToQueue` already call `validateTranscriptionConfig()` — extending that one function makes the preflight block queueing with the visible Settings prompt for AssemblyAI (AC9) with no code change in `useOperations.ts`. The terminal-fail path (AC7/AC9) is the canonical key string already thrown by `createAssemblyAiAsr` (T3) being matched in `NON_RETRYABLE_ERRORS`.

- [ ] **Step 1: Write the failing preflight test.**
  Append to `electron/main/ipc/__tests__/recording-handlers.test.ts` (inside the existing top-level describe, after the existing `addToQueue` provider cases near line 897). Add:
  ```ts
    // Speaker-diarization D1 §6.2/§8/AC9: provider 'assemblyai' with no key must
    // block queueing (loud, no silent fallback to gemini/whisper).
    it('should reject an assemblyai provider with no AssemblyAI key (AC9 loud fail)', async () => {
      const { getConfig } = await import('../../services/config')
      const { addToQueue: addToQueueDb } = await import('../../services/database')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'assemblyai',
          geminiApiKey: 'gemini-present', // present but irrelevant — must NOT be used as a fallback
          openaiApiKey: '',
          assemblyaiApiKey: '', // missing → must block
          assemblyaiModels: ['universal-3-pro', 'universal-2'],
          geminiModel: 'm',
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'en'
        },
        summarization: { provider: 'ollama-cloud', ollamaCloudApiKey: 'ok', ollamaCloudModel: 'm' }
      } as never)

      const addToQueueCall = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === 'recordings:addToQueue')
      const handler = addToQueueCall![1] as (e: unknown, id: string) => Promise<unknown>
      const result = await handler({}, 'rec-1')

      expect(result).toEqual({
        success: false,
        error: 'Transcription API key not configured. Please add your API key in Settings.'
      })
      expect(addToQueueDb).not.toHaveBeenCalled()
    })

    it('should queue an assemblyai provider WITH a key', async () => {
      const { getConfig } = await import('../../services/config')
      const { addToQueue: addToQueueDb } = await import('../../services/database')
      vi.mocked(addToQueueDb).mockReturnValue('queue-item-id')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'assemblyai',
          geminiApiKey: '',
          openaiApiKey: '',
          assemblyaiApiKey: 'aai-key',
          assemblyaiModels: ['universal-3-pro', 'universal-2'],
          geminiModel: 'm',
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'en'
        },
        summarization: { provider: 'ollama-cloud', ollamaCloudApiKey: 'ok', ollamaCloudModel: 'm' }
      } as never)

      const addToQueueCall = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === 'recordings:addToQueue')
      const handler = addToQueueCall![1] as (e: unknown, id: string) => Promise<unknown>
      const result = await handler({}, 'rec-2')
      expect(result).toBe('queue-item-id')
      expect(addToQueueDb).toHaveBeenCalledWith('rec-2')
    })
  ```
  > Match the exact handler-lookup pattern already used by the neighboring `addToQueue` tests in this file (find the `ipcMain.handle` call whose first arg is `'recordings:addToQueue'`, then invoke its second arg). If the existing tests call `registerRecordingHandlers()` in a `beforeEach`, rely on that; do not re-register.

- [ ] **Step 2: Run the test — expect FAIL.**
  ```
  cd apps/electron && npx vitest run electron/main/ipc/__tests__/recording-handlers.test.ts -t "assemblyai"
  ```
  Expected: the "no key" case FAILS — `validateTranscriptionConfig` currently has no `assemblyai` branch, so `problems` is empty, `ok` is `true`, and `addToQueue` is wrongly called (result is `'queue-item-id'`, not the error object).

- [ ] **Step 3: Add the `assemblyai` branch to `validateTranscriptionConfig`.**
  In `electron/main/ipc/recording-handlers.ts`, after the `gemini` ASR check (currently lines 74-76), add:
  ```ts
    if (asrProvider === 'assemblyai' && !config.transcription.assemblyaiApiKey.trim()) {
      // Loud preflight (spec §6.2/§8/AC9): blocks queueing; NEVER substitutes gemini/whisper.
      problems.push({ stage: 'asr', provider: 'assemblyai', problem: 'missing-key' })
    }
  ```

- [ ] **Step 4: Run the test — expect PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/ipc/__tests__/recording-handlers.test.ts -t "assemblyai"
  ```
  Expected: both new cases pass — `Tests  2 passed`.

- [ ] **Step 5: Write the failing NON_RETRYABLE test.**
  Create `electron/main/services/__tests__/transcription-nonretryable.test.ts`:
  ```ts
  /**
   * transcription NON_RETRYABLE_ERRORS — speaker-diarization D1, Task 4.
   *
   * A missing AssemblyAI key throws the canonical
   * 'AssemblyAI API key not configured — add it in Settings → Transcription'
   * from createAssemblyAiAsr. That message must be matched as a terminal,
   * non-retryable failure (spec §8/AC7/AC9) so the queue does not retry it and
   * it lands in the failure chip. This test pins the canonical substring used by
   * the NON_RETRYABLE_ERRORS list in transcription.ts.
   *
   * @vitest-environment node
   */
  import { describe, it, expect, vi } from 'vitest'

  vi.mock('fs', () => ({ readFileSync: vi.fn(() => Buffer.from('AUDIO')) }))

  import { createAssemblyAiAsr } from '../asr/assemblyai-asr'

  // The literal substring the queue's NON_RETRYABLE_ERRORS list must contain.
  const ASSEMBLYAI_KEY_MARKER = 'AssemblyAI API key not configured'

  describe('AssemblyAI missing-key is a terminal (non-retryable) failure', () => {
    it('createAssemblyAiAsr throws a message containing the non-retryable marker', () => {
      const cfg = { transcription: { provider: 'assemblyai', assemblyaiApiKey: '' } } as never
      let message = ''
      try {
        createAssemblyAiAsr(cfg)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toContain(ASSEMBLYAI_KEY_MARKER)
    })
  })
  ```

- [ ] **Step 6: Run the test — expect PASS already (T3 throws this string).**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/transcription-nonretryable.test.ts
  ```
  Expected: `Tests  1 passed (1)`. This test documents the contract that the next edit relies on; it passes because T3 throws the matching string.

- [ ] **Step 7: Add the AssemblyAI key string to `NON_RETRYABLE_ERRORS` and the re-pend markers.**
  In `electron/main/services/transcription.ts`, in the `NON_RETRYABLE_ERRORS` array (lines 119-132), add the new entry after `'OpenAI API key not configured'` (line 123):
  ```ts
        'AssemblyAI API key not configured',
  ```
  Then in `electron/main/ipc/recording-handlers.ts`, `transcription:retryAll` (line 364), change:
  ```ts
        const count = rependFailedItems(['OpenAI', 'Ollama Cloud', 'Gemini API key'])
  ```
  to:
  ```ts
        const count = rependFailedItems(['OpenAI', 'Ollama Cloud', 'Gemini API key', 'AssemblyAI'])
  ```

- [ ] **Step 8: Run the full D1 file set — expect all PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/services/asr/__tests__/assemblyai-asr.test.ts electron/main/services/asr/__tests__/asr-provider.test.ts electron/main/services/__tests__/config-assemblyai.test.ts electron/main/services/__tests__/transcription-nonretryable.test.ts electron/main/ipc/__tests__/recording-handlers.test.ts
  ```
  Expected: all listed files pass (`Test Files  5 passed`).

- [ ] **Step 9: Run the gates — expect clean.**
  ```
  cd apps/electron && npm run typecheck && npm run lint && npm run test:run
  ```
  Expected: `typecheck` exits 0 (the widened `provider` union and new config fields compile; any narrow `AppConfig` test doubles cast with `as never` so they don't break), `lint` clean, and `vitest run` reports the full suite green with no new failures.

- [ ] **Step 10: Commit.**
  ```
  git add electron/main/ipc/recording-handlers.ts electron/main/services/transcription.ts electron/main/ipc/__tests__/recording-handlers.test.ts electron/main/services/__tests__/transcription-nonretryable.test.ts && git commit -m "feat(electron): D1 — loud AssemblyAI no-key preflight + non-retryable terminal-fail + retryAll AssemblyAI marker (AC7/AC9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### D1 exit criteria (verify before moving to D2)
- `getAsrProvider({provider:'assemblyai'})` returns the AssemblyAI provider; unknown provider throws (no fallback) — **AC9**.
- The submit body carries `speech_models: ['universal-3-pro','universal-2']`, `model_region:'global'`, `speaker_labels:true`, `sentiment_analysis:true`, `keyterms_prompt`, `language_code:'en'`, and **never** `speech_model`/`word_boost` — **AC8**.
- `utterances` map to `Turn[]` with ms timestamps (×1000), per-turn speaker + optional sentiment + optional words — **AC1** (the DB write of these is D2).
- A no-key install: preflight blocks queueing with the Settings prompt; a forced job throws the canonical string that `NON_RETRYABLE_ERRORS` matches (terminal, non-retryable) and `retryAll` re-pends it on key save — **AC7/AC9**.
- `config.transcription.provider` defaults to `'assemblyai'`; `assemblyaiApiKey` encrypts at both sites with the `__enc__` guard; `assemblyaiModels` defaults to the pinned array — **§6.2**.
- All gates green (`typecheck && lint && test:run`).

## Phase D2 — v26 migration + structured-turn persistence

**Spec sections:** §6.3, AC1. **Depends on:** D1 (the `Turn` interface and `AsrResult.turns?` must already exist in `electron/main/services/asr/asr-provider.ts`).

**Goal of this phase:** bump `SCHEMA_VERSION` 25 → 26; add `transcripts.turns TEXT` via the AP-§5.8 guarded-`ALTER` + SCHEMA-edit pattern; `CREATE TABLE IF NOT EXISTS recording_speakers` and `voiceprints`; extend `upsertTranscriptStage1` to **additively** write `turns` / `speakers` (roster JSON) / `sentiment` (roster-summary JSON `{label: dominantSentiment}`) without ever touching Stage-2 columns; add the `recording_speakers` insert/query helpers D3/D4 need; extend `e2e-smoke.test.ts` to assert the v26 column + tables exist on a fresh boot.

> **Version-clash check (do this first, §6.3 note):** the spec says to coordinate the bump with any outstanding AP `sync_baseline_meta` migration. As verified at read time, `database.ts` is at `SCHEMA_VERSION = 25` and the highest `MIGRATIONS` key is `25`; there is **no** `sync_baseline_meta` migration in the file (only `sync_baseline_files`, created inside `MIGRATIONS[25]`). So 26 is free. **If `git pull` since planning introduced a `MIGRATIONS[26]`, renumber this phase to the next free integer everywhere (SCHEMA_VERSION, the MIGRATIONS key, all test seeds that rewind to `currentVersion`).**

> **Mocks-first / no USB:** every test in this phase uses the real in-memory `sql.js` DB with only external boundaries mocked, exactly like `database-v25.test.ts`. No hardware, no fetch, no spawn touched in D2.

---

### Task D2-T1: Bump SCHEMA_VERSION to 26 and add the v26 migration (turns column + recording_speakers + voiceprints tables)

**Files:**
- Modify: `apps/electron/electron/main/services/database.ts`
  - `SCHEMA_VERSION` const at line `10` (`const SCHEMA_VERSION = 25`)
  - SCHEMA `transcripts` CREATE TABLE at lines `239-259` (add `turns TEXT`)
  - SCHEMA block — add two new `CREATE TABLE IF NOT EXISTS` statements near the other tables (insert after the `transcripts` table block, before `-- Embeddings for RAG` at line `261`)
  - `MIGRATIONS` object — add a `26:` entry just before the closing `}` at line `1413` (after `MIGRATIONS[25]` which ends at line `1411`)
- Test: `apps/electron/electron/main/services/__tests__/database-v26.test.ts` (Create — mirror `database-v25.test.ts`)

- [ ] **Step 1: Write the failing migration test file.** Create `apps/electron/electron/main/services/__tests__/database-v26.test.ts`. This mirrors `database-v25.test.ts` verbatim for the hoisted-tmpdir + external-boundary-mock harness (the only sanctioned pattern in this repo for real-sql.js DB tests). Start with just the fresh-boot schema assertions:

```ts
/**
 * Schema v26 tests — speaker diarization (spec 2026-06-17 §6.3, AC1)
 *
 * Uses the REAL sql.js in-memory database (same pattern as database-v25.test.ts /
 * e2e-smoke.test.ts): only external boundaries (electron, config, file-storage,
 * vector-store) are mocked; sql.js, fs, and database.ts run their real code.
 */
// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Hoisted shared state (real temp directory, resolves before vi.mock factories)
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-v26-'))
  const dataDir = _path.join(tmpDir, 'data')
  _fs.mkdirSync(dataDir, { recursive: true })

  return {
    tmpDir,
    dataDir,
    dbPath: _path.join(dataDir, 'hidock.db')
  }
})

// ---------------------------------------------------------------------------
// External-boundary mocks
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

// ---------------------------------------------------------------------------
// Real service imports (resolved AFTER the mocks above)
// ---------------------------------------------------------------------------
import {
  initializeDatabase,
  closeDatabase,
  queryAll,
  queryOne,
  run
} from '../database'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function insertTestRecording(id: string): void {
  run(
    `INSERT OR IGNORE INTO recordings
       (id, filename, date_recorded, status, transcription_status, location, on_device, on_local)
     VALUES (?, ?, ?, 'pending', 'none', 'device-only', 1, 0)`,
    [id, `${id}.hda`, new Date().toISOString()]
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('schema v26 (speaker diarization)', () => {
  beforeEach(async () => {
    fs.mkdirSync(shared.dataDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    await initializeDatabase()
  })

  afterEach(() => {
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
  })

  it('fresh boot has the transcripts.turns column', () => {
    const tCols = queryAll<{ name: string }>("SELECT name FROM pragma_table_info('transcripts')").map(c => c.name)
    expect(tCols).toContain('turns')
    // existing speakers/sentiment columns are still present (we reuse them)
    expect(tCols).toContain('speakers')
    expect(tCols).toContain('sentiment')
  })

  it('fresh boot has recording_speakers with the right PK + source CHECK', () => {
    const t = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recording_speakers'"
    )
    expect(t?.name).toBe('recording_speakers')
    const cols = queryAll<{ name: string; pk: number }>(
      "SELECT name, pk FROM pragma_table_info('recording_speakers')"
    )
    const colNames = cols.map(c => c.name)
    expect(colNames).toEqual(
      expect.arrayContaining(['recording_id', 'file_label', 'contact_id', 'confidence', 'source', 'created_at'])
    )
    // composite PK is (recording_id, file_label)
    const pkCols = cols.filter(c => c.pk > 0).map(c => c.name).sort()
    expect(pkCols).toEqual(['file_label', 'recording_id'])
  })

  it("recording_speakers rejects a source outside ('user','auto')", () => {
    insertTestRecording('rec_chk')
    expect(() =>
      run(
        `INSERT INTO recording_speakers (recording_id, file_label, source, created_at)
         VALUES ('rec_chk', 'A', 'robot', ?)`,
        [new Date().toISOString()]
      )
    ).toThrow(/CHECK constraint|constraint failed/i)
  })

  it('fresh boot has voiceprints with model_id/dim/embedding BLOB', () => {
    const t = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='voiceprints'"
    )
    expect(t?.name).toBe('voiceprints')
    const cols = queryAll<{ name: string; type: string }>(
      "SELECT name, type FROM pragma_table_info('voiceprints')"
    )
    const byName = Object.fromEntries(cols.map(c => [c.name, c.type]))
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining(['id', 'contact_id', 'model_id', 'dim', 'embedding', 'created_at'])
    )
    expect(byName['embedding']).toMatch(/BLOB/i)
    expect(byName['dim']).toMatch(/INTEGER/i)
  })

  it('upgrade path: a v25 DB gains turns + recording_speakers + voiceprints after re-init', async () => {
    // Rewind the recorded version to 25, then re-init the SAME db file so the REAL
    // MIGRATIONS[26] runs (no hand-copied SQL that could drift from the migration).
    run('DELETE FROM schema_version')
    run('INSERT INTO schema_version (version) VALUES (25)')
    closeDatabase()
    await initializeDatabase()

    const tCols = queryAll<{ name: string }>("SELECT name FROM pragma_table_info('transcripts')").map(c => c.name)
    expect(tCols).toContain('turns')
    expect(
      queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='recording_speakers'")
    ).toBeTruthy()
    expect(
      queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='voiceprints'")
    ).toBeTruthy()
    const ver = queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')
    expect(ver?.version).toBe(26)
  })
})
```

- [ ] **Step 2: Run the test and confirm it FAILS.** Command:

```
cd apps/electron && npx vitest run electron/main/services/__tests__/database-v26.test.ts
```

Expected FAIL (the `turns` column and the two tables do not exist yet):

```
 FAIL  electron/main/services/__tests__/database-v26.test.ts > schema v26 (speaker diarization) > fresh boot has the transcripts.turns column
AssertionError: expected [ 'id', 'recording_id', …, 'created_at' ] to contain 'turns'
 FAIL  … > fresh boot has recording_speakers with the right PK + source CHECK
AssertionError: expected undefined to be 'recording_speakers'
 FAIL  … > fresh boot has voiceprints with model_id/dim/embedding BLOB
AssertionError: expected undefined to be 'voiceprints'
 ❯ Test Files  1 failed (1)
 ❯      Tests  3 failed | 2 passed (5)
```

(The upgrade-path test and the CHECK test may also fail/error; that is expected pre-implementation.)

- [ ] **Step 3: Add `turns TEXT` to the SCHEMA `transcripts` table.** In `database.ts`, the `transcripts` CREATE TABLE ends at lines `248-258`. Add `turns TEXT` after the `speakers TEXT` line (line `249`). Replace:

```ts
    sentiment TEXT,
    speakers TEXT,
    word_count INTEGER,
```

with:

```ts
    sentiment TEXT,
    speakers TEXT,
    turns TEXT,
    word_count INTEGER,
```

- [ ] **Step 4: Add the two new tables to the SCHEMA string.** Insert immediately after the `transcripts` table's closing `);` (line `259`) and before the `-- Embeddings for RAG` comment (line `261`). Insert this block:

```ts

-- Per-recording speaker roster + contact mapping (spec 2026-06-17 §6.3, v26)
CREATE TABLE IF NOT EXISTS recording_speakers (
    recording_id TEXT NOT NULL,
    file_label TEXT NOT NULL,
    contact_id TEXT,
    confidence REAL,
    source TEXT NOT NULL CHECK(source IN ('user', 'auto')) DEFAULT 'user',
    created_at TEXT NOT NULL,
    PRIMARY KEY (recording_id, file_label)
);

-- Speaker voiceprint embeddings (capture-only in v1; read by nothing) (spec §6.3/§6.7, v26)
CREATE TABLE IF NOT EXISTS voiceprints (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    dim INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    created_at TEXT NOT NULL
);
```

- [ ] **Step 5: Bump SCHEMA_VERSION and add the `26:` migration.** First change line `10`:

```ts
const SCHEMA_VERSION = 25
```

to:

```ts
const SCHEMA_VERSION = 26
```

Then in the `MIGRATIONS` object, add the `26:` entry. The object currently ends with `MIGRATIONS[25]` whose closing brace is at line `1411`, followed by a blank line `1412` and the object's closing `}` at line `1413`. Change:

```ts
    console.log('Migration v25 complete')
  }

}
```

to:

```ts
    console.log('Migration v25 complete')
  },

  26: () => {
    // v26: Speaker diarization (spec 2026-06-17 §6.3) — structured turns column,
    // the recording_speakers roster/mapping table, and the voiceprints capture table.
    // Pattern mirrors MIGRATIONS[25] (AP-§5.8): try/catch-guarded ALTER for the new
    // column (duplicate-column is expected on a fresh DB created from current SCHEMA),
    // CREATE TABLE IF NOT EXISTS for the new tables. No data backfill — turns is
    // populated going forward by upsertTranscriptStage1; pre-v26 rows keep turns NULL
    // and render via the TranscriptViewer legacy text-prefix path (§6.5).
    console.log('Running migration to schema v26: speaker diarization tables')
    const database = getDatabase()

    const columnsToAdd = ['ALTER TABLE transcripts ADD COLUMN turns TEXT']
    for (const sql of columnsToAdd) {
      try {
        database.run(sql)
      } catch (e) {
        const msg = (e as Error).message
        if (msg.includes('duplicate column name')) {
          console.log(`Column already exists: ${sql}`)
        } else {
          console.warn(`[Migration v26] ALTER failed (${sql}):`, e)
        }
      }
    }

    database.run(`
      CREATE TABLE IF NOT EXISTS recording_speakers (
        recording_id TEXT NOT NULL,
        file_label TEXT NOT NULL,
        contact_id TEXT,
        confidence REAL,
        source TEXT NOT NULL CHECK(source IN ('user', 'auto')) DEFAULT 'user',
        created_at TEXT NOT NULL,
        PRIMARY KEY (recording_id, file_label)
      )
    `)

    database.run(`
      CREATE TABLE IF NOT EXISTS voiceprints (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dim INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL
      )
    `)

    console.log('Migration v26 complete')
  }

}
```

- [ ] **Step 6: Run the test and confirm it PASSES.** Command:

```
cd apps/electron && npx vitest run electron/main/services/__tests__/database-v26.test.ts
```

Expected PASS:

```
 ✓ electron/main/services/__tests__/database-v26.test.ts (5)
   ✓ schema v26 (speaker diarization) (5)
     ✓ fresh boot has the transcripts.turns column
     ✓ fresh boot has recording_speakers with the right PK + source CHECK
     ✓ recording_speakers rejects a source outside ('user','auto')
     ✓ fresh boot has voiceprints with model_id/dim/embedding BLOB
     ✓ upgrade path: a v25 DB gains turns + recording_speakers + voiceprints after re-init
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

- [ ] **Step 7: Commit.**

```
cd apps/electron && git add electron/main/services/database.ts electron/main/services/__tests__/database-v26.test.ts && git commit -m "feat(electron): v26 migration — transcripts.turns + recording_speakers + voiceprints (spec D2 §6.3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task D2-T2: Extend `upsertTranscriptStage1` to additively persist turns / speakers roster / sentiment roster-summary

**Files:**
- Modify: `apps/electron/electron/main/services/database.ts`
  - Import the `Turn` type from the ASR provider module (top of file; the existing imports are at lines `1-5`)
  - `upsertTranscriptStage1` signature + body at lines `2279-2307`
- Test: `apps/electron/electron/main/services/__tests__/database-v26.test.ts` (extend — add a new `describe` block)

> **Contract (spec §6.3, AC1):** Stage 1 writes `turns` (JSON `Turn[]`), `speakers` (distinct roster JSON, e.g. `["A","B","C"]`), and `sentiment` (derived roster summary `{ "<label>": "POSITIVE|NEUTRAL|NEGATIVE" }` of each speaker's **dominant/majority** turn sentiment; `{}` when sentiment absent). It must **never** touch Stage-2 columns. Providers that supply no `turns` (Whisper/Gemini) flow exactly as today — `turns`/`speakers`/`sentiment` stay untouched.

- [ ] **Step 1: Write the failing persistence tests.** Append this `describe` block to the end of `apps/electron/electron/main/services/__tests__/database-v26.test.ts`. Add `upsertTranscriptStage1` and `getTranscriptByRecordingId` to the import list at the top of the file (the existing import block pulls `initializeDatabase, closeDatabase, queryAll, queryOne, run` — extend it):

```ts
// ---------------------------------------------------------------------------
// D2-T2: upsertTranscriptStage1 turns/speakers/sentiment persistence (AC1)
// ---------------------------------------------------------------------------

describe('upsertTranscriptStage1 — turns/speakers/sentiment (spec §6.3, AC1)', () => {
  beforeEach(async () => {
    fs.mkdirSync(shared.dataDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    await initializeDatabase()
  })

  afterEach(() => {
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
  })

  it('writes turns JSON, a distinct speakers roster, and a dominant-sentiment roster summary', () => {
    insertTestRecording('rec_aa')
    upsertTranscriptStage1({
      recording_id: 'rec_aa',
      full_text: 'Hi there. Yes hello. Good to see you.',
      language: 'en',
      word_count: 8,
      transcription_provider: 'assemblyai',
      transcription_model: 'universal-3-pro',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'Hi there.', sentiment: 'POSITIVE' },
        { speaker: 'B', startMs: 1000, endMs: 2000, text: 'Yes hello.', sentiment: 'NEUTRAL' },
        // A has two turns; POSITIVE is the majority -> dominant POSITIVE
        { speaker: 'A', startMs: 2000, endMs: 3000, text: 'Good to see you.', sentiment: 'POSITIVE' }
      ]
    })

    const row = queryOne<{ turns: string; speakers: string; sentiment: string }>(
      "SELECT turns, speakers, sentiment FROM transcripts WHERE recording_id='rec_aa'"
    )
    expect(row).toBeDefined()

    const turns = JSON.parse(row!.turns)
    expect(turns).toHaveLength(3)
    expect(turns[0]).toMatchObject({ speaker: 'A', startMs: 0, endMs: 1000, text: 'Hi there.', sentiment: 'POSITIVE' })

    const speakers = JSON.parse(row!.speakers)
    expect(speakers).toEqual(['A', 'B']) // distinct roster, first-seen order

    const sentiment = JSON.parse(row!.sentiment)
    expect(sentiment).toEqual({ A: 'POSITIVE', B: 'NEUTRAL' }) // dominant per label
  })

  it('writes empty roster + {} sentiment when turns carry no sentiment field', () => {
    insertTestRecording('rec_bb')
    upsertTranscriptStage1({
      recording_id: 'rec_bb',
      full_text: 'one two three',
      language: 'en',
      word_count: 3,
      transcription_provider: 'assemblyai',
      transcription_model: 'universal-3-pro',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 500, text: 'one two' },
        { speaker: 'B', startMs: 500, endMs: 1000, text: 'three' }
      ]
    })
    const row = queryOne<{ speakers: string; sentiment: string }>(
      "SELECT speakers, sentiment FROM transcripts WHERE recording_id='rec_bb'"
    )
    expect(JSON.parse(row!.speakers)).toEqual(['A', 'B'])
    expect(JSON.parse(row!.sentiment)).toEqual({}) // no per-turn sentiment -> empty summary
  })

  it('breaks a sentiment tie deterministically toward the first-seen value for that label', () => {
    insertTestRecording('rec_tie')
    upsertTranscriptStage1({
      recording_id: 'rec_tie',
      full_text: 'a b',
      transcription_provider: 'assemblyai',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 1, text: 'a', sentiment: 'POSITIVE' },
        { speaker: 'A', startMs: 1, endMs: 2, text: 'b', sentiment: 'NEGATIVE' }
      ]
    })
    const row = queryOne<{ sentiment: string }>(
      "SELECT sentiment FROM transcripts WHERE recording_id='rec_tie'"
    )
    // 1 POSITIVE vs 1 NEGATIVE -> first-seen wins -> POSITIVE
    expect(JSON.parse(row!.sentiment)).toEqual({ A: 'POSITIVE' })
  })

  it('REGRESSION: a provider with no turns leaves turns/speakers/sentiment NULL (Whisper/Gemini path)', () => {
    insertTestRecording('rec_legacy')
    upsertTranscriptStage1({
      recording_id: 'rec_legacy',
      full_text: 'plain whisper transcript',
      language: 'en',
      word_count: 3,
      transcription_provider: 'openai-whisper',
      transcription_model: 'whisper-1'
      // no turns
    })
    const row = queryOne<{ turns: string | null; speakers: string | null; sentiment: string | null }>(
      "SELECT turns, speakers, sentiment FROM transcripts WHERE recording_id='rec_legacy'"
    )
    expect(row!.turns).toBeNull()
    expect(row!.speakers).toBeNull()
    expect(row!.sentiment).toBeNull()
  })

  it('never clobbers Stage-2 columns on a Stage-1 re-run with turns', () => {
    insertTestRecording('rec_s2safe')
    upsertTranscriptStage1({
      recording_id: 'rec_s2safe',
      full_text: 'v1',
      transcription_provider: 'assemblyai',
      turns: [{ speaker: 'A', startMs: 0, endMs: 1, text: 'v1' }]
    })
    // Simulate Stage 2 having completed:
    run(`UPDATE transcripts SET summary='S', summarization_provider='ollama-cloud' WHERE recording_id='rec_s2safe'`)
    // Re-run Stage 1 (e.g. re-transcribe) with different turns:
    upsertTranscriptStage1({
      recording_id: 'rec_s2safe',
      full_text: 'v2',
      transcription_provider: 'assemblyai',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 1, text: 'v2a' },
        { speaker: 'B', startMs: 1, endMs: 2, text: 'v2b' }
      ]
    })
    const row = queryOne<{ full_text: string; summary: string; summarization_provider: string; speakers: string }>(
      "SELECT full_text, summary, summarization_provider, speakers FROM transcripts WHERE recording_id='rec_s2safe'"
    )
    expect(row!.full_text).toBe('v2')                         // Stage-1 columns updated
    expect(JSON.parse(row!.speakers)).toEqual(['A', 'B'])     // roster recomputed
    expect(row!.summary).toBe('S')                            // Stage-2 untouched
    expect(row!.summarization_provider).toBe('ollama-cloud')  // marker untouched
  })
})
```

- [ ] **Step 2: Run the new tests and confirm they FAIL.** Command:

```
cd apps/electron && npx vitest run electron/main/services/__tests__/database-v26.test.ts -t "upsertTranscriptStage1"
```

Expected FAIL — `upsertTranscriptStage1` does not yet accept a `turns` field, so TypeScript errors on the test object and at runtime `turns`/`speakers`/`sentiment` stay NULL:

```
 FAIL  electron/main/services/__tests__/database-v26.test.ts > upsertTranscriptStage1 — turns/speakers/sentiment (spec §6.3, AC1) > writes turns JSON, a distinct speakers roster, and a dominant-sentiment roster summary
AssertionError: expected null to be defined  // row.turns is null
 ❯      Tests  4 failed | 1 passed (5)
```

(The "no turns leaves NULL" regression test passes immediately; the four turns-supplying tests fail.)

- [ ] **Step 3: Import the `Turn` type into database.ts.** At the top of `database.ts` the imports run lines `1-5`. After line `5` (`import { getDatabasePath } from './file-storage'`), add:

```ts
import type { Turn } from './asr/asr-provider'
```

- [ ] **Step 4: Extend `upsertTranscriptStage1` to write turns/speakers/sentiment.** Replace the entire function at lines `2279-2307`. The current body is:

```ts
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
```

Replace it with:

```ts
/**
 * Compute the derived diarization columns from a Turn[] (spec §6.3):
 *  - speakers: distinct speaker roster in first-seen order, e.g. ["A","B"]
 *  - sentiment: per-label dominant (majority) sentiment {label: 'POSITIVE'|...};
 *    ties break toward the first-seen sentiment for that label; {} when no turn
 *    carries a sentiment field.
 * Pure + exported so the persistence behavior is unit-testable in isolation.
 */
export function deriveSpeakerRosterSummary(turns: Turn[]): {
  speakers: string[]
  sentiment: Record<string, 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'>
} {
  const speakers: string[] = []
  // label -> ordered list of sentiments (first-seen order preserved for tie-break)
  const sentimentsByLabel = new Map<string, Array<'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'>>()

  for (const turn of turns) {
    if (!speakers.includes(turn.speaker)) speakers.push(turn.speaker)
    if (turn.sentiment) {
      const list = sentimentsByLabel.get(turn.speaker) ?? []
      list.push(turn.sentiment)
      sentimentsByLabel.set(turn.speaker, list)
    }
  }

  const sentiment: Record<string, 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'> = {}
  for (const [label, list] of sentimentsByLabel) {
    const counts = new Map<'POSITIVE' | 'NEUTRAL' | 'NEGATIVE', number>()
    for (const s of list) counts.set(s, (counts.get(s) ?? 0) + 1)
    // Pick the dominant; iterate list in first-seen order so ties resolve to the
    // earliest-seen sentiment for the label (deterministic).
    let best = list[0]
    let bestCount = counts.get(best) ?? 0
    for (const s of list) {
      const c = counts.get(s) ?? 0
      if (c > bestCount) {
        best = s
        bestCount = c
      }
    }
    sentiment[label] = best
  }

  return { speakers, sentiment }
}

export function upsertTranscriptStage1(t: {
  recording_id: string
  full_text: string
  language?: string
  word_count?: number
  transcription_provider: string
  transcription_model?: string
  turns?: Turn[]
}): void {
  // Diarization columns (spec §6.3) are additive and written ONLY when the
  // provider supplies turns. Whisper/Gemini (no turns) leave turns/speakers/
  // sentiment NULL — exactly today's behavior. These are Stage-1 columns, so the
  // ON CONFLICT update sets them alongside full_text and never touches the
  // Stage-2 (analysis) columns.
  let turnsJson: string | null = null
  let speakersJson: string | null = null
  let sentimentJson: string | null = null
  if (t.turns) {
    const { speakers, sentiment } = deriveSpeakerRosterSummary(t.turns)
    turnsJson = JSON.stringify(t.turns)
    speakersJson = JSON.stringify(speakers)
    sentimentJson = JSON.stringify(sentiment)
  }

  run(
    `INSERT INTO transcripts (id, recording_id, full_text, language, word_count,
       transcription_provider, transcription_model, turns, speakers, sentiment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(recording_id) DO UPDATE SET
       full_text = excluded.full_text,
       language = COALESCE(excluded.language, transcripts.language),
       word_count = excluded.word_count,
       transcription_provider = excluded.transcription_provider,
       transcription_model = excluded.transcription_model,
       turns = excluded.turns,
       speakers = excluded.speakers,
       sentiment = excluded.sentiment`,
    [
      `trans_${t.recording_id}`,
      t.recording_id,
      t.full_text,
      t.language ?? null,
      t.word_count ?? null,
      t.transcription_provider,
      t.transcription_model ?? null,
      turnsJson,
      speakersJson,
      sentimentJson
    ]
  )
}
```

> **Note on the regression test:** when `t.turns` is `undefined`, `turnsJson`/`speakersJson`/`sentimentJson` are all `null`, so on a fresh row they insert NULL and on a conflict they overwrite to NULL. The "leaves NULL" regression test seeds a brand-new whisper row (no prior diarization), so NULL is the correct asserted state. A Whisper re-transcribe over a prior AssemblyAI row would null the diarization columns — which is the intended semantic (the new transcript has no speakers), consistent with the §6.8 "re-transcribe drops prior mappings" rule that D3/D5 enforce on `recording_speakers`.

- [ ] **Step 5: Run the tests and confirm they PASS.** Command:

```
cd apps/electron && npx vitest run electron/main/services/__tests__/database-v26.test.ts
```

Expected PASS (all v26 tests, both T1 and T2 blocks):

```
 ✓ electron/main/services/__tests__/database-v26.test.ts (10)
   ✓ schema v26 (speaker diarization) (5)
   ✓ upsertTranscriptStage1 — turns/speakers/sentiment (spec §6.3, AC1) (5)
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

- [ ] **Step 6: Confirm no regression in the existing Stage-1 / two-stage tests.** The Stage-1 signature gained one optional field; verify the existing callers/tests still pass:

```
cd apps/electron && npx vitest run electron/main/services/__tests__/database-v25.test.ts electron/main/services/__tests__/two-stage-worker.test.ts
```

Expected: both files pass with no new failures (the existing `upsertTranscriptStage1` call sites omit `turns`, so they hit the NULL path unchanged).

- [ ] **Step 7: Commit.**

```
cd apps/electron && git add electron/main/services/database.ts electron/main/services/__tests__/database-v26.test.ts && git commit -m "feat(electron): persist turns/speakers/sentiment roster in upsertTranscriptStage1 (spec D2 §6.3 AC1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task D2-T3: Add `recording_speakers` insert/query helpers (used by D3/D4)

**Files:**
- Modify: `apps/electron/electron/main/services/database.ts`
  - Add a `RecordingSpeaker` interface + helpers near the transcript helpers (insert after `getTranscriptsByRecordingIds`, which ends at line `2262`, before the single-writer NOTE comment at line `2264`)
- Test: `apps/electron/electron/main/services/__tests__/database-v26.test.ts` (extend — add a `describe` block)

> These are the typed DB primitives D3 (`speakers:assign`, merge/reassign) and D4 (voiceprint capture trigger) build on. D2 lands them with their own unit coverage so later phases inherit a tested surface. The merge/reassign-on-turns algorithm itself (rewriting `transcripts.turns`) lives in D3; D2 provides only the row-level `recording_speakers` CRUD.

- [ ] **Step 1: Write the failing helper tests.** Append this `describe` block to `apps/electron/electron/main/services/__tests__/database-v26.test.ts`, and add `upsertRecordingSpeaker, getRecordingSpeakers, deleteRecordingSpeaker, deleteRecordingSpeakersForRecording` to the import list at the top of the file:

```ts
// ---------------------------------------------------------------------------
// D2-T3: recording_speakers CRUD helpers (powers D3/D4)
// ---------------------------------------------------------------------------

describe('recording_speakers helpers (spec §6.3)', () => {
  beforeEach(async () => {
    fs.mkdirSync(shared.dataDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    await initializeDatabase()
  })

  afterEach(() => {
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
  })

  it('upsertRecordingSpeaker inserts a row with default source=user and is read back by getRecordingSpeakers', () => {
    insertTestRecording('rec_rs1')
    upsertRecordingSpeaker({ recording_id: 'rec_rs1', file_label: 'A', contact_id: 'c1' })
    const rows = getRecordingSpeakers('rec_rs1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ recording_id: 'rec_rs1', file_label: 'A', contact_id: 'c1', source: 'user' })
    expect(rows[0].created_at).toBeTruthy()
  })

  it('upsertRecordingSpeaker updates contact_id/confidence on the (recording_id,file_label) PK conflict', () => {
    insertTestRecording('rec_rs2')
    upsertRecordingSpeaker({ recording_id: 'rec_rs2', file_label: 'A', contact_id: 'c1' })
    upsertRecordingSpeaker({ recording_id: 'rec_rs2', file_label: 'A', contact_id: 'c2', confidence: 0.9 })
    const rows = getRecordingSpeakers('rec_rs2')
    expect(rows).toHaveLength(1) // no duplicate — PK conflict updated in place
    expect(rows[0].contact_id).toBe('c2')
    expect(rows[0].confidence).toBe(0.9)
  })

  it('deleteRecordingSpeaker removes exactly one label (merge support, §6.3)', () => {
    insertTestRecording('rec_rs3')
    upsertRecordingSpeaker({ recording_id: 'rec_rs3', file_label: 'A', contact_id: 'c1' })
    upsertRecordingSpeaker({ recording_id: 'rec_rs3', file_label: 'C', contact_id: 'c3' })
    deleteRecordingSpeaker('rec_rs3', 'C')
    const rows = getRecordingSpeakers('rec_rs3')
    expect(rows.map(r => r.file_label)).toEqual(['A'])
  })

  it('deleteRecordingSpeakersForRecording clears all labels for the recording (re-transcribe, §6.3/§6.8)', () => {
    insertTestRecording('rec_rs4')
    upsertRecordingSpeaker({ recording_id: 'rec_rs4', file_label: 'A', contact_id: 'c1' })
    upsertRecordingSpeaker({ recording_id: 'rec_rs4', file_label: 'B', contact_id: 'c2' })
    const removed = deleteRecordingSpeakersForRecording('rec_rs4')
    expect(removed).toBe(2)
    expect(getRecordingSpeakers('rec_rs4')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run and confirm FAIL.** Command:

```
cd apps/electron && npx vitest run electron/main/services/__tests__/database-v26.test.ts -t "recording_speakers helpers"
```

Expected FAIL — the helpers do not exist (import resolves to `undefined`, calls throw):

```
 FAIL  … > recording_speakers helpers (spec §6.3) > upsertRecordingSpeaker inserts a row with default source=user …
TypeError: upsertRecordingSpeaker is not a function
 ❯      Tests  4 failed (4)
```

- [ ] **Step 3: Implement the helpers.** In `database.ts`, insert this block immediately after `getTranscriptsByRecordingIds` (which closes with `return results` + `}` at lines `2261-2262`) and before the `// NOTE (auto-pipeline P3 …` comment at line `2264`:

```ts

// ---------------------------------------------------------------------------
// recording_speakers — per-recording speaker label -> contact mapping (v26, §6.3)
// v1 writes source='user' only. Powers the Speakers panel (D3) and the
// voiceprint capture trigger (D4). Merge/reassign rewrite transcripts.turns in
// D3; these are the row-level primitives.
// ---------------------------------------------------------------------------

export interface RecordingSpeaker {
  recording_id: string
  file_label: string
  contact_id: string | null
  confidence: number | null
  source: 'user' | 'auto'
  created_at: string
}

/** Insert or update (PK = recording_id, file_label) a speaker mapping. */
export function upsertRecordingSpeaker(s: {
  recording_id: string
  file_label: string
  contact_id?: string | null
  confidence?: number | null
  source?: 'user' | 'auto'
}): void {
  run(
    `INSERT INTO recording_speakers (recording_id, file_label, contact_id, confidence, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(recording_id, file_label) DO UPDATE SET
       contact_id = excluded.contact_id,
       confidence = excluded.confidence,
       source = excluded.source`,
    [
      s.recording_id,
      s.file_label,
      s.contact_id ?? null,
      s.confidence ?? null,
      s.source ?? 'user',
      new Date().toISOString()
    ]
  )
}

/** All speaker rows for a recording (roster order = insertion order). */
export function getRecordingSpeakers(recordingId: string): RecordingSpeaker[] {
  return queryAll<RecordingSpeaker>(
    'SELECT * FROM recording_speakers WHERE recording_id = ? ORDER BY created_at, file_label',
    [recordingId]
  )
}

/** Delete one label's mapping (merge support, §6.3). */
export function deleteRecordingSpeaker(recordingId: string, fileLabel: string): void {
  run('DELETE FROM recording_speakers WHERE recording_id = ? AND file_label = ?', [recordingId, fileLabel])
}

/** Drop all mappings for a recording (re-transcribe, §6.3/§6.8). Returns the
 *  number of rows removed (counted before delete; run() resets sql.js's modified
 *  counter on each statement, so getRowsModified() is unreliable here). */
export function deleteRecordingSpeakersForRecording(recordingId: string): number {
  const before = queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM recording_speakers WHERE recording_id = ?',
    [recordingId]
  )
  run('DELETE FROM recording_speakers WHERE recording_id = ?', [recordingId])
  return before?.n ?? 0
}
```

- [ ] **Step 4: Run and confirm PASS.** Command:

```
cd apps/electron && npx vitest run electron/main/services/__tests__/database-v26.test.ts
```

Expected PASS (all three D2 task blocks):

```
 ✓ electron/main/services/__tests__/database-v26.test.ts (14)
   ✓ schema v26 (speaker diarization) (5)
   ✓ upsertTranscriptStage1 — turns/speakers/sentiment (spec §6.3, AC1) (5)
   ✓ recording_speakers helpers (spec §6.3) (4)
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

- [ ] **Step 5: Commit.**

```
cd apps/electron && git add electron/main/services/database.ts electron/main/services/__tests__/database-v26.test.ts && git commit -m "feat(electron): recording_speakers CRUD helpers (spec D2 §6.3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task D2-T4: Extend `e2e-smoke.test.ts` to assert the v26 schema on a fresh boot

**Files:**
- Modify: `apps/electron/electron/main/services/__tests__/e2e-smoke.test.ts`
  - The single `it(...)` runs lines `249-318`; add schema assertions immediately after `await initializeDatabase()` at line `251` (the fresh-boot point) or at the end of the test before its closing — add at the top so it guards first-launch
  - The real-service import block is at lines `191-200`; add `queryAll, queryOne` to it
- Test: this IS the test file.

> Spec §6.3 / §10 requires the e2e-smoke to assert the v26 `turns` column + `recording_speakers`/`voiceprints` tables on the real first-launch path (the test boots a non-existent DB so `initializeDatabase()` builds the full schema from scratch). This is the integration-level guard that the migration is wired into the boot sequence, not just unit-tested in isolation.

- [ ] **Step 1: Add the failing assertion.** First extend the import block at lines `191-200`. Change:

```ts
import {
  initializeDatabase,
  closeDatabase,
  upsertRecordingFromDevice,
  getRecordingById,
  getTranscriptByRecordingId,
  getMeetingById,
  getMeetings,
  getRecordingsForMeeting
} from '../database'
```

to:

```ts
import {
  initializeDatabase,
  closeDatabase,
  upsertRecordingFromDevice,
  getRecordingById,
  getTranscriptByRecordingId,
  getMeetingById,
  getMeetings,
  getRecordingsForMeeting,
  queryAll,
  queryOne
} from '../database'
```

Then, in the test body, the first line of the `it(...)` is at line `251` (`await initializeDatabase()`). Immediately after it, add the v26 schema guard. Change:

```ts
    // --- Boot a fresh real sql.js database (db file does not exist) ---
    await initializeDatabase()

    // --- Stage 1: device connect + list -> persist recording ---------------
```

to:

```ts
    // --- Boot a fresh real sql.js database (db file does not exist) ---
    await initializeDatabase()

    // --- v26 schema guard (spec 2026-06-17 §6.3): first-launch must carry the
    //     diarization column + tables, proving the migration is wired into boot. ---
    const transcriptCols = queryAll<{ name: string }>(
      "SELECT name FROM pragma_table_info('transcripts')"
    ).map(c => c.name)
    expect(transcriptCols).toContain('turns')
    expect(
      queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='recording_speakers'")
    ).toBeTruthy()
    expect(
      queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='voiceprints'")
    ).toBeTruthy()

    // --- Stage 1: device connect + list -> persist recording ---------------
```

- [ ] **Step 2: Run the e2e-smoke test and confirm it PASSES.** Because the schema change in D2-T1 already landed, this assertion passes immediately — it is a guard, not a red→green driver. Run it to prove it is wired:

```
cd apps/electron && npx vitest run electron/main/services/__tests__/e2e-smoke.test.ts
```

Expected PASS:

```
 ✓ electron/main/services/__tests__/e2e-smoke.test.ts (1)
   ✓ E2E knowledge pipeline smoke test (real services) > connects+lists, syncs calendar, downloads, transcribes, and correlates — all via real DB
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

> If this assertion FAILS (`expected … to contain 'turns'`), the D2-T1 SCHEMA edit was not applied to the fresh-boot path — fix D2-T1 before proceeding.

- [ ] **Step 3: Run the full phase gate (typecheck + lint + the touched test files).** Command:

```
cd apps/electron && npm run typecheck && npm run lint && npx vitest run electron/main/services/__tests__/database-v26.test.ts electron/main/services/__tests__/database-v25.test.ts electron/main/services/__tests__/e2e-smoke.test.ts electron/main/services/__tests__/two-stage-worker.test.ts
```

Expected: `typecheck` exits 0 (the new `Turn` import and the optional `turns` field type-check; `deriveSpeakerRosterSummary` and the `RecordingSpeaker` helpers are fully typed), `lint` exits 0, and all four test files pass.

- [ ] **Step 4: Commit.**

```
cd apps/electron && git add electron/main/services/__tests__/e2e-smoke.test.ts && git commit -m "test(electron): e2e-smoke asserts v26 turns column + speaker tables on fresh boot (spec D2 §6.3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Phase D2 completion checklist
- [ ] `SCHEMA_VERSION === 26`; `MIGRATIONS[26]` adds `transcripts.turns` (guarded ALTER) + `recording_speakers` + `voiceprints` (CREATE TABLE IF NOT EXISTS), and the SCHEMA string carries all three so fresh boots and migrations agree.
- [ ] `upsertTranscriptStage1` additively writes `turns` / `speakers` roster / `sentiment` roster-summary when `turns` is supplied; never touches Stage-2 columns; no-turns providers leave them NULL (regression test green) — satisfies **AC1**.
- [ ] `recording_speakers` CRUD helpers (`upsertRecordingSpeaker`, `getRecordingSpeakers`, `deleteRecordingSpeaker`, `deleteRecordingSpeakersForRecording`) are exported and tested — ready for D3/D4.
- [ ] `e2e-smoke.test.ts` guards the v26 schema on the first-launch path.
- [ ] `npm run typecheck && npm run lint && npm run test:run` all green.

> **Hand-off to D3:** D3 sequences `contacts:create` IPC first (AC2 depends on it), then builds the Speakers panel + reassign/merge using the `recording_speakers` helpers added here. The merge algorithm (rewrite `transcripts.turns` where `speaker=='C'` → `'A'` + `deleteRecordingSpeaker(recordingId, 'C')`) and reassign (set `turn.speaker` + `upsertRecordingSpeaker`) operate on the `turns` JSON written in D2-T2 and the helpers from D2-T3.

## Phase D3 — `contacts:create` + Speakers panel + edit + structured render + disclosure

> Spec sections: §6.4, §6.5; ACs: **AC2, AC3, AC10**.
> **Sequence is load-bearing:** `contacts:create` (D3-T1) lands first because AC2's inline quick-add depends on it. Then the DB write layer for `recording_speakers` + `speakers:assign` IPC (D3-T2), then the Speakers panel + edit (D3-T3), then `TranscriptViewer` structured render (D3-T4), then the privacy disclosure (D3-T5).
> **Constraints:** Vitest run from `apps/electron`. Mocks-first, no USB/jensen/transfer code touched, no real hardware. The voiceprint capture hook fired by `speakers:assign` is **D4** — D3 leaves a marked TODO and does NOT import `voiceprint-service`.
> **Pre-req from D2:** the v26 migration creates the `recording_speakers` table. D3 adds the DB *helper functions* and the IPC; if a D2 commit already added a given helper, drop the duplicate and keep the test.

Verified anchors (read during planning):
- `electron/main/ipc/contacts-handlers.ts` — handlers `contacts:getAll/getById/update/delete/getForMeeting`; `mapToPerson` at `:181`; imports from `../services/database` at `:8-16`; validation imports `:18-23`. **No `contacts:create`.**
- `electron/main/services/database.ts` — `upsertContact` at `:2851`; `Contact` interface `:2757-2770`; `getContactById` `:2811`, `getContactByEmail` `:2815`, `getContactsForMeeting` `:2920`. **No `recording_speakers` helpers yet.**
- `electron/main/validation/contacts.ts` — Zod schemas; `OptionalStringSchema`, `UUIDSchema` from `./common` (`:8`).
- `electron/main/types/api.ts` — `success`/`error` `:49/:56`; `ErrorCode` = `'NOT_FOUND'|'VALIDATION_ERROR'|'DATABASE_ERROR'` `:78-81`.
- `electron/preload/index.ts` — `contacts` API type block `:116-122`; `contacts` impl block `:551-557`.
- `electron/main/ipc/handlers.ts` — registration list (`:29`, `:32`).
- `src/features/library/components/TranscriptViewer.tsx` — `TranscriptViewerProps` `:13-21`; `parseTranscriptSegments` `:86`; render `:170-275`; speaker badge `:257-261`.
- `src/features/library/components/SourceDetailDrawer.tsx` — `Transcript` interface `:21-38` (has `speakers`, no `turns`); transcript tab `:338-356`.
- `src/pages/People.tsx` — disabled quick-add button `:183-191`.
- `src/pages/Settings.tsx` — Transcription card `:611`; ASR provider group `:617-642`; provider conditional blocks `:644/:711`.
- `src/types/knowledge.ts` — `Person` interface `:201` (`id,name,email,type,role,company,notes,tags[],firstSeenAt,lastSeenAt,interactionCount,createdAt`).
- Test style: IPC tests mock `electron` (`ipcMain.handle`) + `../../services/database`, then find a handler via `ipcMain.handle.mock.calls.find(c => c[0] === '<channel>')?.[1]` (`electron/main/ipc/__tests__/contacts-handlers.test.ts`). React tests use `@testing-library/react`, `window.electronAPI` mock, `vi.mock` for child components (`src/features/library/components/__tests__/SourceReader.metadata.test.tsx`).

---

### Task D3-T1: `contacts:create` IPC (gap fix — sequence FIRST, AC2 depends on it)

**Files:**
- Modify: `electron/main/validation/contacts.ts` — add `CreateContactRequestSchema` (after `UpdateContactRequestSchema`, ~`:40`)
- Modify: `electron/main/ipc/contacts-handlers.ts` — add `contacts:create` handler (after `contacts:getAll`, ~`:52`); import `upsertContact` + `randomUUID` + new schema
- Modify: `electron/main/types/api.ts` — add `create` to `ContactsAPI` (`:304-308`)
- Modify: `electron/preload/index.ts` — add `create` to the `contacts` type block (`:116-122`) and impl block (`:551-557`)
- Test: `electron/main/ipc/__tests__/contacts-handlers.test.ts` (extend existing)

- [ ] **Step 1: Write the failing tests for `contacts:create`.** Append these three `it` blocks inside the existing `describe('Contacts IPC Handlers', ...)` (after the NOT_FOUND test, ~`:152`). They mirror the existing mock style and add `upsertContact` to the database mock.

  First extend the `vi.mock('../../services/database', ...)` block to include `upsertContact: vi.fn()` (add the line alongside the other db mocks, e.g. after `getContactsForMeeting: vi.fn(),` at `:24`):
  ```ts
    getContactsForMeeting: vi.fn(),
    upsertContact: vi.fn(),
  ```

  Then append the tests:
  ```ts
  it('should register contacts:create handler (AC2)', () => {
    registerContactsHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('contacts:create', expect.any(Function))
  })

  it('creates a contact with a required name and returns a Person (AC2)', async () => {
    const { upsertContact } = await import('../../services/database')
    vi.mocked(upsertContact).mockImplementation((c: any) => ({
      ...c,
      type: c.type ?? 'unknown',
      role: c.role ?? null,
      company: c.company ?? null,
      notes: c.notes ?? null,
      created_at: '2026-06-17T00:00:00.000Z'
    }))

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:create')?.[1]
    const result = await handler?.({} as any, { name: 'Speaker A', email: 'a@example.com' }) as any

    expect(result.success).toBe(true)
    expect(result.data.name).toBe('Speaker A')
    expect(result.data.email).toBe('a@example.com')
    expect(typeof result.data.id).toBe('string')
    expect(result.data.id.length).toBeGreaterThan(0)
    expect(upsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Speaker A', email: 'a@example.com' })
    )
  })

  it('rejects contacts:create with a missing/blank name (AC2)', async () => {
    const { upsertContact } = await import('../../services/database')
    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:create')?.[1]
    const result = await handler?.({} as any, { name: '   ' }) as any

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(upsertContact).not.toHaveBeenCalled()
  })

  it('allows duplicate emails on contacts:create (AC2)', async () => {
    const { upsertContact } = await import('../../services/database')
    vi.mocked(upsertContact).mockImplementation((c: any) => ({
      ...c, type: 'unknown', role: null, company: null, notes: null, created_at: '2026-06-17T00:00:00.000Z'
    }))

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:create')?.[1]
    const r1 = await handler?.({} as any, { name: 'Alice', email: 'dup@example.com' }) as any
    const r2 = await handler?.({} as any, { name: 'Alice (other)', email: 'dup@example.com' }) as any

    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(upsertContact).toHaveBeenCalledTimes(2)
  })
  ```

- [ ] **Step 2: Run the tests and confirm they FAIL.**
  ```
  cd apps/electron && npx vitest run electron/main/ipc/__tests__/contacts-handlers.test.ts
  ```
  Expected: FAIL — `expect(ipcMain.handle).toHaveBeenCalledWith('contacts:create', ...)` fails (handler not registered), and the create tests fail because `handler` is `undefined` (`Cannot read properties of undefined (reading ...)`).

- [ ] **Step 3: Add `CreateContactRequestSchema` to validation.** In `electron/main/validation/contacts.ts`, after `UpdateContactRequestSchema` (the block ending at `:40`), add:
  ```ts
  /**
   * Create contact request — name required; duplicate emails allowed (existing schema).
   */
  export const CreateContactRequestSchema = z.object({
    name: z.string().trim().min(1).max(500),
    email: z.string().email().max(500).nullable().optional(),
    type: z.enum(['team', 'candidate', 'customer', 'external', 'unknown']).optional(),
    role: OptionalStringSchema,
    company: OptionalStringSchema
  })
  ```
  And add the type export alongside the others (after `export type UpdateContactRequest = ...`, ~`:82`):
  ```ts
  export type CreateContactRequest = z.infer<typeof CreateContactRequestSchema>
  ```

- [ ] **Step 4: Add the `contacts:create` handler.** In `electron/main/ipc/contacts-handlers.ts`, extend the database import (`:8-16`) to include `upsertContact`:
  ```ts
  import {
    getContacts,
    getContactById,
    updateContact,
    deleteContact,
    getMeetingsForContact,
    getContactsForMeeting,
    upsertContact,
    Contact
  } from '../services/database'
  ```
  Add `randomUUID` import below the existing imports (after `:25`):
  ```ts
  import { randomUUID } from 'crypto'
  ```
  Extend the validation import (`:18-23`) to add the new schema:
  ```ts
  import {
    GetContactsRequestSchema,
    GetContactByIdRequestSchema,
    UpdateContactRequestSchema,
    DeleteContactRequestSchema,
    CreateContactRequestSchema
  } from '../validation/contacts'
  ```
  Then insert the handler immediately after the `contacts:getAll` handler closes (`:52`, before `contacts:getById`):
  ```ts
  /**
   * Create a new contact (wraps upsertContact). Name required; duplicate emails allowed.
   */
  ipcMain.handle(
    'contacts:create',
    async (_, request: unknown): Promise<Result<Person>> => {
      try {
        const parsed = CreateContactRequestSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid create request', parsed.error.format())
        }

        const now = new Date().toISOString()
        const created = upsertContact({
          id: randomUUID(),
          name: parsed.data.name,
          email: parsed.data.email ?? null,
          type: parsed.data.type ?? 'unknown',
          role: parsed.data.role ?? null,
          company: parsed.data.company ?? null,
          notes: null,
          tags: null,
          first_seen_at: now,
          last_seen_at: now,
          meeting_count: 0
        })

        return success(mapToPerson(created))
      } catch (err) {
        console.error('contacts:create error:', err)
        return error('DATABASE_ERROR', 'Failed to create contact', err)
      }
    }
  )
  ```

- [ ] **Step 5: Run the tests and confirm they PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/ipc/__tests__/contacts-handlers.test.ts
  ```
  Expected: PASS — all contacts-handlers tests green (the original 6 + the 4 new create tests).

- [ ] **Step 6: Wire the preload bridge + API type.** In `electron/main/types/api.ts`, extend `ContactsAPI` (`:304-308`) — add the import for `Person`/`CreateContactRequest` is unneeded here since the file already references `Contact`; use the existing `Contact` shape consistent with the runtime `mapToPerson`. Add:
  ```ts
  export interface ContactsAPI {
    getAll: (request?: GetContactsRequest) => Promise<Result<GetContactsResponse>>
    getById: (id: string) => Promise<Result<ContactWithMeetings>>
    create: (request: { name: string; email?: string | null; type?: string; role?: string | null; company?: string | null }) => Promise<Result<Contact>>
    update: (request: UpdateContactRequest) => Promise<Result<Contact>>
  }
  ```
  In `electron/preload/index.ts`, add `create` to the `contacts` type block (`:116-122`):
  ```ts
    create: (request: { name: string; email?: string | null; type?: string; role?: string | null; company?: string | null }) => Promise<Result<any>>
  ```
  and to the impl block (`:551-557`), after `getById`:
  ```ts
    create: (request) => callIPC('contacts:create', request),
  ```

- [ ] **Step 7: Typecheck the main+preload surface.**
  ```
  cd apps/electron && npm run typecheck
  ```
  Expected: no new TypeScript errors.

- [ ] **Step 8: Commit.**
  ```
  cd apps/electron && git add electron/main/validation/contacts.ts electron/main/ipc/contacts-handlers.ts electron/main/types/api.ts electron/preload/index.ts electron/main/ipc/__tests__/contacts-handlers.test.ts && git commit -m "feat(electron): D3-T1 contacts:create IPC (name required, dup emails allowed) wrapping upsertContact

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D3-T2: `recording_speakers` DB helpers + `speakers:assign` IPC (write source='user'; voiceprint hook deferred to D4)

**Files:**
- Modify: `electron/main/services/database.ts` — add `RecordingSpeaker` interface + helpers `getRecordingSpeakers`, `insertRecordingSpeaker`, `deleteRecordingSpeaker`, `mergeRecordingSpeakerLabel`, `clearRecordingSpeakers` (after the contacts helpers, ~`:2933`, before the Project section at `:2942`)
- Create: `electron/main/ipc/speakers-handlers.ts` — `registerSpeakersHandlers()` with `speakers:assign`
- Modify: `electron/main/ipc/handlers.ts` — register the new handlers
- Modify: `electron/preload/index.ts` — add `speakers.assign` to type block (`:116`) + impl block (`:551`)
- Test: `electron/main/services/__tests__/recording-speakers.test.ts` (new) and `electron/main/ipc/__tests__/speakers-handlers.test.ts` (new)

> The `recording_speakers` table is created by the D2 v26 migration. These helpers operate against it. The schema (contract): `recording_id TEXT NOT NULL, file_label TEXT NOT NULL, contact_id TEXT, confidence REAL, source TEXT NOT NULL CHECK(source IN ('user','auto')) DEFAULT 'user', created_at TEXT NOT NULL, PRIMARY KEY (recording_id, file_label)`.

- [ ] **Step 1: Write the failing DB-helper test** against a real in-memory sql.js DB (matches the integration style used elsewhere). Create `electron/main/services/__tests__/recording-speakers.test.ts`:
  ```ts
  import { describe, it, expect, beforeEach } from 'vitest'
  import initSqlJs from 'sql.js'
  import {
    __setTestDatabase,
    insertRecordingSpeaker,
    getRecordingSpeakers,
    deleteRecordingSpeaker,
    clearRecordingSpeakers
  } from '../database'

  const SCHEMA = `
    CREATE TABLE recording_speakers (
      recording_id TEXT NOT NULL,
      file_label TEXT NOT NULL,
      contact_id TEXT,
      confidence REAL,
      source TEXT NOT NULL CHECK(source IN ('user','auto')) DEFAULT 'user',
      created_at TEXT NOT NULL,
      PRIMARY KEY (recording_id, file_label)
    );`

  describe('recording_speakers DB helpers (AC3/AC4)', () => {
    beforeEach(async () => {
      const SQL = await initSqlJs()
      const db = new SQL.Database()
      db.run(SCHEMA)
      __setTestDatabase(db)
    })

    it('inserts a user-sourced row and reads it back', () => {
      insertRecordingSpeaker({ recording_id: 'rec-1', file_label: 'A', contact_id: 'c-1', source: 'user' })
      const rows = getRecordingSpeakers('rec-1')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ recording_id: 'rec-1', file_label: 'A', contact_id: 'c-1', source: 'user' })
      expect(typeof rows[0].created_at).toBe('string')
    })

    it('upserts on (recording_id, file_label) — reassigning a label replaces contact', () => {
      insertRecordingSpeaker({ recording_id: 'rec-1', file_label: 'A', contact_id: 'c-1', source: 'user' })
      insertRecordingSpeaker({ recording_id: 'rec-1', file_label: 'A', contact_id: 'c-2', source: 'user' })
      const rows = getRecordingSpeakers('rec-1')
      expect(rows).toHaveLength(1)
      expect(rows[0].contact_id).toBe('c-2')
    })

    it('deletes a single label row (merge support — no orphan)', () => {
      insertRecordingSpeaker({ recording_id: 'rec-1', file_label: 'A', contact_id: 'c-1', source: 'user' })
      insertRecordingSpeaker({ recording_id: 'rec-1', file_label: 'C', contact_id: 'c-3', source: 'user' })
      deleteRecordingSpeaker('rec-1', 'C')
      const rows = getRecordingSpeakers('rec-1')
      expect(rows.map(r => r.file_label)).toEqual(['A'])
    })

    it('clears all rows for a recording (re-transcribe support)', () => {
      insertRecordingSpeaker({ recording_id: 'rec-1', file_label: 'A', contact_id: 'c-1', source: 'user' })
      insertRecordingSpeaker({ recording_id: 'rec-1', file_label: 'B', contact_id: 'c-2', source: 'user' })
      clearRecordingSpeakers('rec-1')
      expect(getRecordingSpeakers('rec-1')).toHaveLength(0)
    })
  })
  ```
  > If `__setTestDatabase` is not already exported from `database.ts` (it is the test seam used by other DB tests — verify), use the same seam the sibling `*.test.ts` files in `electron/main/services/__tests__/` use to inject an in-memory DB. Match whatever the existing DB tests import.

- [ ] **Step 2: Run and confirm FAIL.**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/recording-speakers.test.ts
  ```
  Expected: FAIL — `insertRecordingSpeaker`/`getRecordingSpeakers`/`deleteRecordingSpeaker`/`clearRecordingSpeakers` are not exported (`No "insertRecordingSpeaker" export is defined`).

- [ ] **Step 3: Add the DB helpers.** In `electron/main/services/database.ts`, insert after `linkContactToMeeting` (`:2940`) and before the `// Project queries` banner (`:2942`):
  ```ts
  // =============================================================================
  // Recording speakers (speaker diarization — D3)
  // =============================================================================

  export interface RecordingSpeaker {
    recording_id: string
    file_label: string
    contact_id: string | null
    confidence: number | null
    source: 'user' | 'auto'
    created_at: string
  }

  /** All speaker-label → contact mappings for a recording. */
  export function getRecordingSpeakers(recordingId: string): RecordingSpeaker[] {
    return queryAll<RecordingSpeaker>(
      'SELECT * FROM recording_speakers WHERE recording_id = ? ORDER BY file_label',
      [recordingId]
    )
  }

  /** Insert or replace a (recording_id, file_label) mapping. v1 writes source='user'. */
  export function insertRecordingSpeaker(row: {
    recording_id: string
    file_label: string
    contact_id: string | null
    confidence?: number | null
    source?: 'user' | 'auto'
  }): void {
    run(
      `INSERT INTO recording_speakers (recording_id, file_label, contact_id, confidence, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(recording_id, file_label) DO UPDATE SET
         contact_id = excluded.contact_id,
         confidence = excluded.confidence,
         source = excluded.source`,
      [
        row.recording_id,
        row.file_label,
        row.contact_id,
        row.confidence ?? null,
        row.source ?? 'user',
        new Date().toISOString()
      ]
    )
  }

  /** Delete one label's row (merge / cleanup). */
  export function deleteRecordingSpeaker(recordingId: string, fileLabel: string): void {
    run('DELETE FROM recording_speakers WHERE recording_id = ? AND file_label = ?', [recordingId, fileLabel])
  }

  /** Delete ALL rows for a recording (re-transcribe — labels may change). */
  export function clearRecordingSpeakers(recordingId: string): void {
    run('DELETE FROM recording_speakers WHERE recording_id = ?', [recordingId])
  }
  ```

- [ ] **Step 4: Run and confirm PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/recording-speakers.test.ts
  ```
  Expected: PASS — 4 tests green.

- [ ] **Step 5: Write the failing `speakers:assign` IPC test.** Create `electron/main/ipc/__tests__/speakers-handlers.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach } from 'vitest'
  import { registerSpeakersHandlers } from '../speakers-handlers'
  import { ipcMain } from 'electron'

  vi.mock('electron', () => ({
    ipcMain: { handle: vi.fn() }
  }))

  vi.mock('../../services/database', () => ({
    insertRecordingSpeaker: vi.fn(),
    getContactById: vi.fn()
  }))

  describe('Speakers IPC Handlers (AC3/AC4)', () => {
    beforeEach(() => vi.clearAllMocks())

    it('registers speakers:assign', () => {
      registerSpeakersHandlers()
      expect(ipcMain.handle).toHaveBeenCalledWith('speakers:assign', expect.any(Function))
    })

    it('writes a recording_speakers row with source="user"', async () => {
      const { insertRecordingSpeaker, getContactById } = await import('../../services/database')
      vi.mocked(getContactById).mockReturnValue({ id: 'c-1', name: 'Alice' } as any)

      registerSpeakersHandlers()
      const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:assign')?.[1]
      const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A', contactId: 'c-1' }) as any

      expect(result.success).toBe(true)
      expect(insertRecordingSpeaker).toHaveBeenCalledWith(
        expect.objectContaining({ recording_id: 'rec-1', file_label: 'A', contact_id: 'c-1', source: 'user' })
      )
    })

    it('rejects when contactId does not resolve to a contact', async () => {
      const { insertRecordingSpeaker, getContactById } = await import('../../services/database')
      vi.mocked(getContactById).mockReturnValue(undefined)

      registerSpeakersHandlers()
      const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:assign')?.[1]
      const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A', contactId: 'missing' }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('NOT_FOUND')
      expect(insertRecordingSpeaker).not.toHaveBeenCalled()
    })

    it('rejects a missing fileLabel (validation)', async () => {
      const { insertRecordingSpeaker } = await import('../../services/database')
      registerSpeakersHandlers()
      const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:assign')?.[1]
      const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: '', contactId: 'c-1' }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('VALIDATION_ERROR')
      expect(insertRecordingSpeaker).not.toHaveBeenCalled()
    })
  })
  ```

- [ ] **Step 6: Run and confirm FAIL.**
  ```
  cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-handlers.test.ts
  ```
  Expected: FAIL — cannot resolve `../speakers-handlers` (`Failed to resolve import`).

- [ ] **Step 7: Create the `speakers:assign` handler.** Create `electron/main/ipc/speakers-handlers.ts`:
  ```ts
  /**
   * Speakers IPC Handlers (speaker diarization — D3)
   *
   * speakers:assign writes a recording_speakers row (source='user'). The voiceprint
   * capture hook is wired in D4 (see TODO below) — D3 does NOT import voiceprint-service.
   */

  import { ipcMain } from 'electron'
  import { insertRecordingSpeaker, getContactById } from '../services/database'
  import { success, error, Result } from '../types/api'
  import { z } from 'zod'

  const AssignSpeakerSchema = z.object({
    recordingId: z.string().min(1),
    fileLabel: z.string().min(1),
    contactId: z.string().min(1)
  })

  export function registerSpeakersHandlers(): void {
    /**
     * Map a recording's speaker label (file_label, e.g. "A") to a contact.
     * Writes recording_speakers(source='user'); fires the D4 voiceprint hook (TODO).
     */
    ipcMain.handle(
      'speakers:assign',
      async (_, request: unknown): Promise<Result<{ recordingId: string; fileLabel: string; contactId: string }>> => {
        try {
          const parsed = AssignSpeakerSchema.safeParse(request)
          if (!parsed.success) {
            return error('VALIDATION_ERROR', 'Invalid speaker assignment request', parsed.error.format())
          }

          const { recordingId, fileLabel, contactId } = parsed.data
          const contact = getContactById(contactId)
          if (!contact) {
            return error('NOT_FOUND', `Contact with ID ${contactId} not found`)
          }

          insertRecordingSpeaker({
            recording_id: recordingId,
            file_label: fileLabel,
            contact_id: contactId,
            source: 'user'
          })

          // TODO(D4): fire voiceprint capture hook here
          //   (voiceprint-service.captureVoiceprint(recordingId, fileLabel, contactId))
          //   — capture-only; never throws into this handler; respects isVoiceprintAvailable().

          return success({ recordingId, fileLabel, contactId })
        } catch (err) {
          console.error('speakers:assign error:', err)
          return error('DATABASE_ERROR', 'Failed to assign speaker', err)
        }
      }
    )
  }
  ```

- [ ] **Step 8: Run and confirm PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-handlers.test.ts
  ```
  Expected: PASS — 4 tests green.

- [ ] **Step 9: Register the handlers + preload bridge.** In `electron/main/ipc/handlers.ts`, add the import alongside the others (after `:8`):
  ```ts
  import { registerSpeakersHandlers } from './speakers-handlers'
  ```
  and call it next to `registerContactsHandlers()` (`:32`):
  ```ts
    registerSpeakersHandlers()
  ```
  In `electron/preload/index.ts`, add a `speakers` namespace to the type interface (after the `contacts` block `:122`):
  ```ts
    // Speakers (diarization)
    speakers: {
      assign: (request: { recordingId: string; fileLabel: string; contactId: string }) => Promise<Result<any>>
    }
  ```
  and to the impl object (after the `contacts` impl block `:557`):
  ```ts
    speakers: {
      assign: (request) => callIPC('speakers:assign', request)
    },
  ```

- [ ] **Step 10: Typecheck.**
  ```
  cd apps/electron && npm run typecheck
  ```
  Expected: no new TypeScript errors.

- [ ] **Step 11: Commit.**
  ```
  cd apps/electron && git add electron/main/services/database.ts electron/main/ipc/speakers-handlers.ts electron/main/ipc/handlers.ts electron/preload/index.ts electron/main/services/__tests__/recording-speakers.test.ts electron/main/ipc/__tests__/speakers-handlers.test.ts && git commit -m "feat(electron): D3-T2 recording_speakers DB helpers + speakers:assign IPC (source=user, voiceprint hook deferred to D4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D3-T3: SpeakersPanel component — attendee pre-fill, inline quick-add, reassign + merge (AC2, AC3)

**Files:**
- Create: `src/features/library/components/SpeakersPanel.tsx`
- Modify: `src/features/library/components/SourceDetailDrawer.tsx` — add `turns?: Turn[]` to `Transcript` interface (`:21-38`); render `<SpeakersPanel>` in the Transcript tab (`:338-356`)
- Create: `src/features/library/types/turns.ts` — shared `Turn` type for the renderer (mirrors the main-side contract)
- Test: `src/features/library/components/__tests__/SpeakersPanel.test.tsx` (new)

> The panel computes per-label turn-count and talk-time from `turns`, shows a Contact picker pre-filled with the recording's meeting attendees (top-sorted), supports inline quick-add via `contacts:create`, assign via `speakers:assign`, reassign (re-assign a label to a different contact), and merge (collapse label C into A: rewrite turns + delete C's mapping). Single-speaker → read-only (no merge). Zero-speaker → panel not rendered (caller passes `turns=[]`).

- [ ] **Step 1: Add the shared renderer `Turn` type.** Create `src/features/library/types/turns.ts`:
  ```ts
  /** Structured speaker turn (mirrors electron/main/services/asr/asr-provider.ts Turn). */
  export interface Turn {
    speaker: string
    startMs: number
    endMs: number
    text: string
    words?: Array<{ text: string; startMs: number; endMs: number }>
    sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
  }
  ```

- [ ] **Step 2: Write the failing SpeakersPanel test.** Create `src/features/library/components/__tests__/SpeakersPanel.test.tsx`:
  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest'
  import { render, screen, fireEvent, waitFor } from '@testing-library/react'
  import { SpeakersPanel } from '../SpeakersPanel'
  import type { Turn } from '../../types/turns'

  vi.mock('@/components/ui/toaster', () => ({
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  }))

  const mockAssign = vi.fn().mockResolvedValue({ success: true })
  const mockCreate = vi.fn()
  const mockGetForMeeting = vi.fn()
  const mockGetAll = vi.fn()

  function makeTurns(): Turn[] {
    return [
      { speaker: 'A', startMs: 0, endMs: 5000, text: 'Hello there.' },
      { speaker: 'B', startMs: 5000, endMs: 8000, text: 'Hi.' },
      { speaker: 'A', startMs: 8000, endMs: 12000, text: 'How are you?' },
    ]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetForMeeting.mockResolvedValue({ success: true, data: [{ id: 'c-att', name: 'Attendee Alice', email: 'alice@x.com' }] })
    mockGetAll.mockResolvedValue({ success: true, data: { contacts: [{ id: 'c-bob', name: 'Bob', email: 'bob@x.com' }], total: 1 } })
    Object.defineProperty(window, 'electronAPI', {
      value: {
        contacts: { getForMeeting: mockGetForMeeting, getAll: mockGetAll, create: mockCreate },
        speakers: { assign: mockAssign },
      },
      writable: true,
      configurable: true,
    })
  })

  describe('SpeakersPanel (AC2/AC3)', () => {
    it('renders one row per distinct file_label with turn-count and talk-time', async () => {
      render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={vi.fn()} />)
      // labels A and B
      expect(await screen.findByText('A')).toBeInTheDocument()
      expect(screen.getByText('B')).toBeInTheDocument()
      // A: 2 turns; talk-time 5000 + 4000 = 9s -> 00:00:09
      expect(screen.getByText(/2 turns/i)).toBeInTheDocument()
      expect(screen.getByText('00:00:09')).toBeInTheDocument()
    })

    it('pre-fills the contact picker with meeting attendees on top (AC2)', async () => {
      render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={vi.fn()} />)
      await waitFor(() => expect(mockGetForMeeting).toHaveBeenCalledWith('meet-1'))
      // Open the picker for label A
      fireEvent.click(screen.getAllByRole('button', { name: /assign contact/i })[0])
      expect(await screen.findByText('Attendee Alice')).toBeInTheDocument()
    })

    it('falls back to all-contacts search when there is no meeting (AC2)', async () => {
      render(<SpeakersPanel recordingId="rec-1" meetingId={undefined} turns={makeTurns()} onChanged={vi.fn()} />)
      await waitFor(() => expect(mockGetAll).toHaveBeenCalled())
      expect(mockGetForMeeting).not.toHaveBeenCalled()
    })

    it('assigns a contact via speakers:assign (AC3)', async () => {
      const onChanged = vi.fn()
      render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={onChanged} />)
      fireEvent.click(screen.getAllByRole('button', { name: /assign contact/i })[0])
      fireEvent.click(await screen.findByText('Attendee Alice'))
      await waitFor(() =>
        expect(mockAssign).toHaveBeenCalledWith({ recordingId: 'rec-1', fileLabel: 'A', contactId: 'c-att' })
      )
      expect(onChanged).toHaveBeenCalled()
    })

    it('inline quick-add: unmatched name creates a contact then assigns it (AC2)', async () => {
      mockCreate.mockResolvedValue({ success: true, data: { id: 'c-new', name: 'Carol', email: null } })
      render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={vi.fn()} />)
      fireEvent.click(screen.getAllByRole('button', { name: /assign contact/i })[0])
      const search = await screen.findByRole('textbox', { name: /search or add a contact/i })
      fireEvent.change(search, { target: { value: 'Carol' } })
      fireEvent.click(await screen.findByRole('button', { name: /create contact "carol"/i }))
      await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({ name: 'Carol' }))
      await waitFor(() =>
        expect(mockAssign).toHaveBeenCalledWith({ recordingId: 'rec-1', fileLabel: 'A', contactId: 'c-new' })
      )
    })

    it('merge C -> A rewrites turns and calls onMergeTurns + onChanged (AC3)', async () => {
      const onMergeTurns = vi.fn()
      const onChanged = vi.fn()
      const turns: Turn[] = [
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'a' },
        { speaker: 'C', startMs: 1000, endMs: 2000, text: 'c' },
      ]
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={turns}
          onChanged={onChanged}
          onMergeTurns={onMergeTurns}
        />
      )
      // Merge C into A via the per-row merge control
      fireEvent.click(await screen.findByRole('button', { name: /merge speaker c/i }))
      fireEvent.click(await screen.findByRole('button', { name: /merge into a/i }))
      await waitFor(() => expect(onMergeTurns).toHaveBeenCalledWith('C', 'A'))
      expect(onChanged).toHaveBeenCalled()
    })

    it('single-speaker recording renders read-only (no merge control)', async () => {
      const turns: Turn[] = [{ speaker: 'A', startMs: 0, endMs: 1000, text: 'solo' }]
      render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={turns} onChanged={vi.fn()} />)
      expect(await screen.findByText('A')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /merge speaker/i })).not.toBeInTheDocument()
    })
  })
  ```

- [ ] **Step 3: Run and confirm FAIL.**
  ```
  cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.test.tsx
  ```
  Expected: FAIL — cannot resolve `../SpeakersPanel` (`Failed to resolve import "../SpeakersPanel"`).

- [ ] **Step 4: Create the SpeakersPanel.** Create `src/features/library/components/SpeakersPanel.tsx`:
  ```tsx
  /**
   * SpeakersPanel
   *
   * One row per distinct speaker file_label with turn-count + talk-time, a contact
   * picker (meeting-attendee pre-filled, all-contacts fallback, inline quick-add),
   * reassign, and merge. Single-speaker → read-only. Naming only via Contacts.
   */

  import { useEffect, useMemo, useState } from 'react'
  import { Button } from '@/components/ui/button'
  import { Input } from '@/components/ui/input'
  import { toast } from '@/components/ui/toaster'
  import type { Turn } from '../types/turns'

  interface SpeakersPanelProps {
    recordingId: string
    meetingId?: string
    turns: Turn[]
    /** Existing label -> contact name map (from recording_speakers join), for display. */
    assignedNames?: Record<string, string>
    /** Called after any successful assign/merge so the host can refetch. */
    onChanged: () => void
    /** Merge rewrite hook: rewrite all turns with speaker===from to `to`, persist. */
    onMergeTurns?: (from: string, to: string) => void
  }

  interface PickContact {
    id: string
    name: string
    email: string | null
  }

  function formatTalkTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000)
    const h = Math.floor(totalSeconds / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(h)}:${pad(m)}:${pad(s)}`
  }

  export function SpeakersPanel({
    recordingId,
    meetingId,
    turns,
    assignedNames,
    onChanged,
    onMergeTurns
  }: SpeakersPanelProps) {
    const [attendees, setAttendees] = useState<PickContact[]>([])
    const [allContacts, setAllContacts] = useState<PickContact[]>([])
    const [openPickerLabel, setOpenPickerLabel] = useState<string | null>(null)
    const [openMergeLabel, setOpenMergeLabel] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [busy, setBusy] = useState(false)

    // Per-label stats: turn-count + talk-time (Σ endMs-startMs).
    const labels = useMemo(() => {
      const stats = new Map<string, { count: number; talkMs: number }>()
      for (const t of turns) {
        const cur = stats.get(t.speaker) ?? { count: 0, talkMs: 0 }
        cur.count += 1
        cur.talkMs += Math.max(0, t.endMs - t.startMs)
        stats.set(t.speaker, cur)
      }
      return [...stats.entries()]
        .map(([label, s]) => ({ label, ...s }))
        .sort((a, b) => a.label.localeCompare(b.label))
    }, [turns])

    const readOnly = labels.length <= 1

    // Load attendees (top-sorted) or fall back to all-contacts.
    useEffect(() => {
      let cancelled = false
      async function load() {
        const api = (window as any).electronAPI
        if (meetingId) {
          const res = await api.contacts.getForMeeting(meetingId)
          if (!cancelled && res?.success) setAttendees(res.data ?? [])
        }
        const all = await api.contacts.getAll({})
        if (!cancelled && all?.success) setAllContacts(all.data?.contacts ?? [])
      }
      void load()
      return () => { cancelled = true }
    }, [meetingId])

    // Attendees first (de-duped), then the rest, filtered by search.
    const pickList = useMemo(() => {
      const seen = new Set(attendees.map((a) => a.id))
      const rest = allContacts.filter((c) => !seen.has(c.id))
      const merged = [...attendees, ...rest]
      const q = search.trim().toLowerCase()
      if (!q) return merged
      return merged.filter((c) => c.name.toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q))
    }, [attendees, allContacts, search])

    const exactNameMatch = useMemo(
      () => pickList.some((c) => c.name.trim().toLowerCase() === search.trim().toLowerCase()),
      [pickList, search]
    )

    async function assign(fileLabel: string, contactId: string) {
      setBusy(true)
      try {
        const res = await (window as any).electronAPI.speakers.assign({ recordingId, fileLabel, contactId })
        if (res?.success) {
          setOpenPickerLabel(null)
          setSearch('')
          onChanged()
        } else {
          toast.error('Could not assign speaker', res?.error?.message)
        }
      } finally {
        setBusy(false)
      }
    }

    async function quickAddAndAssign(fileLabel: string, name: string) {
      setBusy(true)
      try {
        const res = await (window as any).electronAPI.contacts.create({ name: name.trim() })
        if (res?.success && res.data?.id) {
          await assign(fileLabel, res.data.id)
        } else {
          toast.error('Could not create contact', res?.error?.message)
        }
      } finally {
        setBusy(false)
      }
    }

    function mergeInto(from: string, to: string) {
      onMergeTurns?.(from, to)
      setOpenMergeLabel(null)
      onChanged()
    }

    if (labels.length === 0) return null

    return (
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Speakers</p>
        {labels.map(({ label, count, talkMs }) => {
          const assignedName = assignedNames?.[label]
          return (
            <div key={label} className="flex items-center gap-2 p-2 border rounded-lg bg-muted/30">
              <span className="font-semibold text-sm w-10">{label}</span>
              <span className="text-xs text-muted-foreground flex-1">
                {count} turns • {formatTalkTime(talkMs)}
                {assignedName && <span className="ml-2 text-foreground font-medium">→ {assignedName}</span>}
              </span>

              {!readOnly && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Merge speaker ${label}`}
                  onClick={() => setOpenMergeLabel(openMergeLabel === label ? null : label)}
                >
                  Merge
                </Button>
              )}

              <Button
                variant="outline"
                size="sm"
                aria-label={`Assign contact to ${label}`}
                onClick={() => { setOpenPickerLabel(openPickerLabel === label ? null : label); setSearch('') }}
              >
                {assignedName ? 'Reassign' : 'Assign'}
              </Button>

              {openMergeLabel === label && (
                <div className="absolute mt-2 ml-12 z-10 p-2 bg-background border rounded-lg shadow">
                  {labels.filter((l) => l.label !== label).map((target) => (
                    <button
                      key={target.label}
                      className="block w-full text-left text-sm px-2 py-1 hover:bg-muted rounded"
                      aria-label={`Merge into ${target.label}`}
                      onClick={() => mergeInto(label, target.label)}
                    >
                      Merge into {target.label}
                    </button>
                  ))}
                </div>
              )}

              {openPickerLabel === label && (
                <div className="absolute mt-2 ml-12 z-10 w-64 p-2 bg-background border rounded-lg shadow space-y-2">
                  <Input
                    aria-label="Search or add a contact"
                    placeholder="Search or add a contact…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    disabled={busy}
                  />
                  <div className="max-h-48 overflow-y-auto">
                    {pickList.map((c) => (
                      <button
                        key={c.id}
                        className="block w-full text-left text-sm px-2 py-1 hover:bg-muted rounded"
                        onClick={() => assign(label, c.id)}
                        disabled={busy}
                      >
                        {c.name}
                        {c.email && <span className="text-muted-foreground ml-1">({c.email})</span>}
                      </button>
                    ))}
                    {search.trim() && !exactNameMatch && (
                      <button
                        className="block w-full text-left text-sm px-2 py-1 text-primary hover:bg-muted rounded"
                        aria-label={`Create contact "${search.trim()}"`}
                        onClick={() => quickAddAndAssign(label, search)}
                        disabled={busy}
                      >
                        Create contact "{search.trim()}"
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }
  ```

- [ ] **Step 5: Run and confirm PASS.**
  ```
  cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.test.tsx
  ```
  Expected: PASS — 7 tests green.

- [ ] **Step 6: Wire SpeakersPanel into SourceDetailDrawer + add `turns` to the Transcript interface.** In `src/features/library/components/SourceDetailDrawer.tsx`, add the import near the other library imports (after `:19`):
  ```ts
  import { SpeakersPanel } from './SpeakersPanel'
  import type { Turn } from '../types/turns'
  ```
  Extend the `Transcript` interface (`:21-38`) — add `turns` after `speakers` (`:31`):
  ```ts
    speakers: string | null
    turns?: string | null
  ```
  In the Transcript tab body (`:347-355`, the "Full transcript" `<div>`), insert the panel above the full-text block. Replace:
  ```tsx
              {/* Full transcript */}
              <div>
  ```
  with:
  ```tsx
              {/* Speakers panel (structured turns only) */}
              {(() => {
                let parsedTurns: Turn[] = []
                if (transcript.turns) {
                  try { parsedTurns = JSON.parse(transcript.turns) } catch { parsedTurns = [] }
                }
                if (parsedTurns.length === 0) return null
                return (
                  <SpeakersPanel
                    recordingId={transcript.recording_id}
                    meetingId={meeting?.id}
                    turns={parsedTurns}
                    onChanged={() => { /* host refetch wired by caller via key/refresh */ }}
                  />
                )
              })()}

              {/* Full transcript */}
              <div>
  ```

- [ ] **Step 7: Run the drawer test suite to confirm no regression.**
  ```
  cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.test.tsx src/features/library/components/__tests__/SourceReader.metadata.test.tsx
  ```
  Expected: PASS — SpeakersPanel green; SourceReader metadata tests unchanged-green.

- [ ] **Step 8: Commit.**
  ```
  cd apps/electron && git add src/features/library/types/turns.ts src/features/library/components/SpeakersPanel.tsx src/features/library/components/SourceDetailDrawer.tsx src/features/library/components/__tests__/SpeakersPanel.test.tsx && git commit -m "feat(electron): D3-T3 SpeakersPanel (attendee pre-fill, inline quick-add, reassign/merge) wired into SourceDetailDrawer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D3-T4: TranscriptViewer structured render from `turns` with legacy fallback (AC3, AC8 no-regression)

**Files:**
- Modify: `src/features/library/components/TranscriptViewer.tsx` — add `turns?: Turn[]` prop (`:13-21`); render structured turns when present, else the existing text-prefix parser
- Test: `src/features/library/components/__tests__/TranscriptViewer.test.tsx` (new)

> When `turns` is present, render per-turn: color-coded speaker badge (mapped contact name via `speakerNames`, else `file_label`), `TimeAnchor`, text — preserving auto-scroll + active highlight. When `turns` is absent → the existing `parseTranscriptSegments` path (Whisper/Gemini, pre-migration rows). A named regression test asserts the absent-`turns` path renders no speaker UI.

- [ ] **Step 1: Write the failing TranscriptViewer test.** Create `src/features/library/components/__tests__/TranscriptViewer.test.tsx`:
  ```tsx
  import { describe, it, expect, vi } from 'vitest'
  import { render, screen } from '@testing-library/react'
  import { TranscriptViewer } from '../TranscriptViewer'
  import type { Turn } from '../../types/turns'

  // scrollIntoView is not implemented in jsdom
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  function makeTurns(): Turn[] {
    return [
      { speaker: 'A', startMs: 0, endMs: 4000, text: 'Opening remarks.' },
      { speaker: 'B', startMs: 4000, endMs: 9000, text: 'A reply.' },
    ]
  }

  describe('TranscriptViewer — structured turns (AC3/AC8)', () => {
    it('renders structured turns with speaker badges when turns present', () => {
      render(
        <TranscriptViewer transcript="ignored flat text" turns={makeTurns()} onSeek={vi.fn()} showSummary={false} />
      )
      expect(screen.getByText('Opening remarks.')).toBeInTheDocument()
      expect(screen.getByText('A reply.')).toBeInTheDocument()
      // Speaker labels render as badges
      expect(screen.getByText('A')).toBeInTheDocument()
      expect(screen.getByText('B')).toBeInTheDocument()
    })

    it('maps file_label to a contact name via speakerNames', () => {
      render(
        <TranscriptViewer
          transcript=""
          turns={makeTurns()}
          speakerNames={{ A: 'Alice', B: 'Bob' }}
          onSeek={vi.fn()}
          showSummary={false}
        />
      )
      expect(screen.getByText('Alice')).toBeInTheDocument()
      expect(screen.getByText('Bob')).toBeInTheDocument()
      // raw labels no longer shown as the badge
      expect(screen.queryByText('A')).not.toBeInTheDocument()
    })

    it('REGRESSION: falls back to legacy text-prefix parser when turns absent (AC8)', () => {
      render(
        <TranscriptViewer
          transcript={'[00:00] Alice: Hello\n[00:05] Bob: Hi'}
          onSeek={vi.fn()}
          showSummary={false}
        />
      )
      // legacy parser extracts "Alice"/"Bob" as text-prefix speakers
      expect(screen.getByText('Hello')).toBeInTheDocument()
      expect(screen.getByText('Hi')).toBeInTheDocument()
    })

    it('REGRESSION: plain text (no timestamps, no turns) renders as a single block (AC8)', () => {
      render(<TranscriptViewer transcript="Just some plain text." onSeek={vi.fn()} showSummary={false} />)
      expect(screen.getByText('Just some plain text.')).toBeInTheDocument()
    })
  })
  ```
  > Add `import { describe, it, expect, vi, beforeAll } from 'vitest'` if your tsconfig/global setup does not inject `beforeAll` — match the project's existing import style (the metadata test imports the hooks it uses).

- [ ] **Step 2: Run and confirm FAIL.**
  ```
  cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.test.tsx
  ```
  Expected: FAIL — the structured-turns tests fail because `turns`/`speakerNames` props don't exist yet and no structured rendering occurs (`Unable to find an element with the text: Alice`). The two regression tests should already pass.

- [ ] **Step 3: Add the `turns`/`speakerNames` props + structured rendering.** In `src/features/library/components/TranscriptViewer.tsx`, add the import (after `:11`):
  ```ts
  import type { Turn } from '../types/turns'
  ```
  Extend `TranscriptViewerProps` (`:13-21`):
  ```ts
  interface TranscriptViewerProps {
    transcript: string
    turns?: Turn[]
    speakerNames?: Record<string, string>
    currentTimeMs?: number
    onSeek: (startMs: number, endMs?: number) => void
    showSummary?: boolean
    showActionItems?: boolean
    summary?: string
    actionItems?: string[]
  }
  ```
  Add a deterministic badge-color helper after `parseTranscriptSegments` (`:125`):
  ```ts
  const SPEAKER_BADGE_CLASSES = [
    'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
    'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
    'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300'
  ]

  function speakerBadgeClass(label: string): string {
    let hash = 0
    for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0
    return SPEAKER_BADGE_CLASSES[Math.abs(hash) % SPEAKER_BADGE_CLASSES.length]
  }
  ```
  Update the component signature (`:127-135`) to destructure the new props:
  ```ts
  export function TranscriptViewer({
    transcript,
    turns,
    speakerNames,
    currentTimeMs,
    onSeek,
    showSummary = true,
    showActionItems = true,
    summary,
    actionItems
  }: TranscriptViewerProps) {
  ```
  Replace the segments memo (`:144`) so structured turns take precedence, deriving the same `TranscriptSegment[]` shape (so highlight/auto-scroll are reused) and keeping a flag for structured-mode badge styling:
  ```ts
    const hasStructuredTurns = !!turns && turns.length > 0

    // Parse transcript into segments (structured turns take precedence)
    const segments = useMemo(() => {
      if (hasStructuredTurns) {
        return turns!.map((t) => ({
          startMs: t.startMs,
          endMs: t.endMs,
          text: t.text,
          speaker: t.speaker
        }))
      }
      return parseTranscriptSegments(transcript)
    }, [hasStructuredTurns, turns, transcript])
  ```
  Update `hasTimestamps` (`:168`) so structured turns always use the timeline layout:
  ```ts
    const hasTimestamps = hasStructuredTurns || segments.length > 1 || (segments.length === 1 && segments[0].startMs > 0)
  ```
  Replace the speaker-badge block inside the segment render (`:257-261`) so structured mode shows a color-coded badge using `speakerNames` (legacy mode keeps the plain bold name):
  ```tsx
                      {segment.speaker && (
                        hasStructuredTurns ? (
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${speakerBadgeClass(segment.speaker)}`}>
                            {speakerNames?.[segment.speaker] ?? segment.speaker}
                          </span>
                        ) : (
                          <span className="font-semibold text-foreground">
                            {segment.speaker}
                          </span>
                        )
                      )}
  ```

- [ ] **Step 4: Run and confirm PASS.**
  ```
  cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.test.tsx
  ```
  Expected: PASS — 4 tests green (2 structured + 2 regression).

- [ ] **Step 5: Typecheck the renderer.**
  ```
  cd apps/electron && npm run typecheck
  ```
  Expected: no new TypeScript errors.

- [ ] **Step 6: Commit.**
  ```
  cd apps/electron && git add src/features/library/components/TranscriptViewer.tsx src/features/library/components/__tests__/TranscriptViewer.test.tsx && git commit -m "feat(electron): D3-T4 TranscriptViewer renders structured turns (color-coded speaker badges, name mapping) with legacy text-prefix fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D3-T5: Privacy disclosure in Settings + un-stub People quick-add (AC10)

**Files:**
- Modify: `src/pages/Settings.tsx` — render the AssemblyAI cloud/global-routing disclosure in the Transcription card when AssemblyAI is the selected provider (`:644`/`:711` conditional area)
- Modify: `src/pages/People.tsx` — un-stub the "Add Person" quick-add button (`:183-191`) to open a small create dialog wired to `contacts:create`
- Create: `src/components/QuickAddContact.tsx` — reusable inline create dialog (used by People; SpeakersPanel already inlines its own quick-add)
- Test: `src/pages/__tests__/Settings.disclosure.test.tsx` (new); `src/components/__tests__/QuickAddContact.test.tsx` (new)

> AC10: the disclosure renders when AssemblyAI is the selected provider. The spec copy (verbatim §6.5): *"Speaker detection uses AssemblyAI (cloud, global routing); recordings are uploaded for processing."*

- [ ] **Step 1: Write the failing disclosure test.** Create `src/pages/__tests__/Settings.disclosure.test.tsx`. Mirror the Settings test scaffolding the repo already uses (mock `window.electronAPI.config`, toaster). Render `<Settings>`, set the ASR provider to `assemblyai`, and assert the disclosure text appears; assert it is absent for Gemini.
  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest'
  import { render, screen, fireEvent, waitFor } from '@testing-library/react'
  import { Settings } from '../Settings'

  vi.mock('@/components/ui/toaster', () => ({
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  }))

  const baseConfig = {
    transcription: {
      provider: 'assemblyai',
      geminiApiKey: '',
      geminiModel: 'gemini-2.5-pro',
      openaiApiKey: '',
      whisperModel: 'whisper-1',
      assemblyaiApiKey: '',
      assemblyaiModels: ['universal-3-pro', 'universal-2'],
      autoTranscribe: true,
      language: 'en',
    },
    chat: { provider: 'gemini' },
    summarization: { provider: 'ollama-cloud', ollamaCloudApiKey: '', ollamaCloudModel: '' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'electronAPI', {
      value: {
        config: {
          get: vi.fn().mockResolvedValue({ success: true, data: baseConfig }),
          update: vi.fn().mockResolvedValue({ success: true }),
        },
        ollama: { listModels: vi.fn().mockResolvedValue({ success: true, data: [] }) },
      },
      writable: true,
      configurable: true,
    })
  })

  describe('Settings — AssemblyAI privacy disclosure (AC10)', () => {
    it('renders the cloud/global-routing disclosure when AssemblyAI is the selected provider', async () => {
      render(<Settings />)
      expect(
        await screen.findByText(/Speaker detection uses AssemblyAI \(cloud, global routing\); recordings are uploaded for processing\./i)
      ).toBeInTheDocument()
    })

    it('does not render the disclosure when Gemini is the selected provider', async () => {
      render(<Settings />)
      // switch to Gemini
      fireEvent.click(await screen.findByRole('button', { name: /use gemini asr provider/i }))
      await waitFor(() =>
        expect(
          screen.queryByText(/Speaker detection uses AssemblyAI \(cloud, global routing\)/i)
        ).not.toBeInTheDocument()
      )
    })
  })
  ```
  > Match the actual Settings mock surface (`config.get`/`config.update`, Ollama model listing) used by any existing Settings test; if the page reads additional IPC on mount, add those mocks. The two assertions (present for AssemblyAI, absent for Gemini) are the load-bearing part.

- [ ] **Step 2: Run and confirm FAIL.**
  ```
  cd apps/electron && npx vitest run src/pages/__tests__/Settings.disclosure.test.tsx
  ```
  Expected: FAIL — `Unable to find an element with the text: Speaker detection uses AssemblyAI ...` (the disclosure is not rendered yet). Note: D1 adds the `assemblyai` provider button; this test assumes the AssemblyAI provider option exists in the picker (a D1 deliverable). If D1 has not landed in this branch, gate this step on D1 or render the disclosure based purely on `asrProvider === 'assemblyai'` state.

- [ ] **Step 3: Render the disclosure.** In `src/pages/Settings.tsx`, inside the Transcription `<CardContent>` (after the provider button group `:642` and before the provider-specific blocks `:644`), add:
  ```tsx
              {asrProvider === 'assemblyai' && (
                <p className="text-xs text-muted-foreground rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-2">
                  Speaker detection uses AssemblyAI (cloud, global routing); recordings are uploaded for processing.{' '}
                  <a
                    href="https://www.assemblyai.com/legal/terms-of-service"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Terms of Service
                  </a>
                </p>
              )}
  ```

- [ ] **Step 4: Run and confirm PASS.**
  ```
  cd apps/electron && npx vitest run src/pages/__tests__/Settings.disclosure.test.tsx
  ```
  Expected: PASS — both disclosure tests green.

- [ ] **Step 5: Write the failing QuickAddContact test.** Create `src/components/__tests__/QuickAddContact.test.tsx`:
  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest'
  import { render, screen, fireEvent, waitFor } from '@testing-library/react'
  import { QuickAddContact } from '../QuickAddContact'

  vi.mock('@/components/ui/toaster', () => ({
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  }))

  const mockCreate = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'electronAPI', {
      value: { contacts: { create: mockCreate } },
      writable: true,
      configurable: true,
    })
  })

  describe('QuickAddContact (AC2 reusable quick-add)', () => {
    it('creates a contact via contacts:create and fires onCreated', async () => {
      mockCreate.mockResolvedValue({ success: true, data: { id: 'c-new', name: 'Dana', email: null } })
      const onCreated = vi.fn()
      render(<QuickAddContact open onClose={vi.fn()} onCreated={onCreated} />)

      fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'Dana' } })
      fireEvent.click(screen.getByRole('button', { name: /create/i }))

      await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Dana' })))
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-new' })))
    })

    it('blocks an empty name (no IPC call)', async () => {
      render(<QuickAddContact open onClose={vi.fn()} onCreated={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /create/i }))
      await new Promise((r) => setTimeout(r, 0))
      expect(mockCreate).not.toHaveBeenCalled()
    })
  })
  ```

- [ ] **Step 6: Run and confirm FAIL.**
  ```
  cd apps/electron && npx vitest run src/components/__tests__/QuickAddContact.test.tsx
  ```
  Expected: FAIL — cannot resolve `../QuickAddContact` (`Failed to resolve import`).

- [ ] **Step 7: Create QuickAddContact + un-stub People.** Create `src/components/QuickAddContact.tsx`:
  ```tsx
  /**
   * QuickAddContact — reusable inline create dialog wrapping contacts:create.
   * Used by People.tsx; SpeakersPanel inlines its own variant.
   */

  import { useState } from 'react'
  import { Button } from '@/components/ui/button'
  import { Input } from '@/components/ui/input'
  import { toast } from '@/components/ui/toaster'

  interface QuickAddContactProps {
    open: boolean
    onClose: () => void
    onCreated: (contact: { id: string; name: string; email: string | null }) => void
  }

  export function QuickAddContact({ open, onClose, onCreated }: QuickAddContactProps) {
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [busy, setBusy] = useState(false)

    if (!open) return null

    async function create() {
      const trimmed = name.trim()
      if (!trimmed) {
        toast.error('Name is required')
        return
      }
      setBusy(true)
      try {
        const res = await (window as any).electronAPI.contacts.create({
          name: trimmed,
          email: email.trim() || null
        })
        if (res?.success && res.data) {
          onCreated(res.data)
          setName('')
          setEmail('')
          onClose()
        } else {
          toast.error('Could not create contact', res?.error?.message)
        }
      } finally {
        setBusy(false)
      }
    }

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
        <div className="w-80 p-4 bg-background rounded-lg border space-y-3">
          <h3 className="text-sm font-semibold">Add Person</h3>
          <Input
            aria-label="Name"
            placeholder="Name (required)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <Input
            aria-label="Email"
            placeholder="Email (optional)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button size="sm" onClick={create} disabled={busy}>Create</Button>
          </div>
        </div>
      </div>
    )
  }
  ```
  In `src/pages/People.tsx`, add the import (after `:33`):
  ```ts
  import { QuickAddContact } from '@/components/QuickAddContact'
  ```
  Add the open-state next to the other `useState` hooks (after `:42`):
  ```ts
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  ```
  Replace the disabled "Add Person" button (`:183-191`):
  ```tsx
            <Button
              size="sm"
              variant="default"
              onClick={() => setQuickAddOpen(true)}
            >
              <UserPlus className="h-4 w-4 mr-2" />
              Add Person
            </Button>
  ```
  And render the dialog — add it just before the closing `</div>` of the page root (after the header/list, inside the top-level `<div className="flex flex-col h-full">`):
  ```tsx
      <QuickAddContact
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        onCreated={() => { setQuickAddOpen(false); loadPeople(currentPage) }}
      />
  ```

- [ ] **Step 8: Run and confirm PASS.**
  ```
  cd apps/electron && npx vitest run src/components/__tests__/QuickAddContact.test.tsx
  ```
  Expected: PASS — 2 tests green.

- [ ] **Step 9: Run the full D3 gate (typecheck + lint + the D3 test files).**
  ```
  cd apps/electron && npm run typecheck && npm run lint && npx vitest run electron/main/ipc/__tests__/contacts-handlers.test.ts electron/main/services/__tests__/recording-speakers.test.ts electron/main/ipc/__tests__/speakers-handlers.test.ts src/features/library/components/__tests__/SpeakersPanel.test.tsx src/features/library/components/__tests__/TranscriptViewer.test.tsx src/pages/__tests__/Settings.disclosure.test.tsx src/components/__tests__/QuickAddContact.test.tsx
  ```
  Expected: typecheck clean, lint clean, all listed test files green.

- [ ] **Step 10: Commit.**
  ```
  cd apps/electron && git add src/pages/Settings.tsx src/pages/People.tsx src/components/QuickAddContact.tsx src/pages/__tests__/Settings.disclosure.test.tsx src/components/__tests__/QuickAddContact.test.tsx && git commit -m "feat(electron): D3-T5 AssemblyAI privacy disclosure in Settings + un-stub People quick-add (reusable QuickAddContact)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```


## Phase D4 — Voiceprint capture hook (capture-only)

> **Spec:** §6.7, §8 (voiceprint), AC4. Implements the v1 *capture* hook: `sherpa-onnx-node` lazy-load with graceful degradation, ffmpeg PCM decode + ≥10 s clean-speech gate, BLOB store in `voiceprints`, and wiring `speakers:assign` → capture.
>
> **Prereqs from earlier phases (consumed verbatim, NOT created here):**
> - D1 declared `interface Turn { speaker; startMs; endMs; text; words?; sentiment? }` in `electron/main/services/asr/asr-provider.ts`.
> - D2 ran the v26 migration: created `voiceprints(id, contact_id, model_id, dim, embedding BLOB, created_at)` and `recording_speakers(...)`, and added `transcripts.turns TEXT` (JSON `Turn[]`).
> - D3 added the `speakers:assign` IPC handler (writes a `recording_speakers` row, `source='user'`). D4 *adds the voiceprint-capture call inside that existing handler* — the handler file is `electron/main/ipc/speakers-handlers.ts`.
>
> **Mocks-first, zero real-hardware/USB.** All tests are Vitest run from `apps/electron`; `child_process`, `fs`, `electron`, `sherpa-onnx-node`, and `../services/database` are mocked. No real ffmpeg, no real sherpa addon, no device.
>
> **Key load-bearing facts verified by reading the tree:**
> - BLOB precedent: `insertEmbedding` (`database.ts:2409-2414`) binds a `Uint8Array` directly as a SQLite BLOB param via the shared `run(sql, params)` helper (`database.ts:1656-1659`). Voiceprints follow this exactly.
> - ffmpeg path resolution: `resolveFfmpegPath()` (`asr/audio-normalize.ts:17-24`) already rewrites `app.asar`→`app.asar.unpacked`; reuse it.
> - The Whisper decode emits MP3 (`audio-normalize.ts:58` `-b:a 32k`); D4's decode is a **distinct** `-ar 16000 -ac 1 -f pcm_s16le pipe:1` invocation.
> - `getRecordingById(id).file_path` (`database.ts:1980`) is the downloaded-file locator (`null` when not local).
> - `getTranscriptByRecordingId(recordingId).turns` (D2 column) holds JSON `Turn[]`.
> - electron-builder `asarUnpack` (`electron-builder.yml:12-15`) already lists `**/*.node` and `**/ffmpeg-static/**`; D4 adds the WeSpeaker model.

---

### Task D4-T1: `voiceprint-service.ts` — sherpa lazy-load + graceful degradation (`isVoiceprintAvailable`)

**Files:**
- Create: `electron/main/services/voiceprint-service.ts`
- Test: `electron/main/services/__tests__/voiceprint-service.test.ts`

The module-level `try/catch` `require('sherpa-onnx-node')` sets an availability flag. Because `sherpa-onnx-node` lives in `optionalDependencies`, on a machine where the prebuilt addon did not install the `require` throws and the feature is silently disabled (one operator log line, no toast). AC4 requires asserting **both** the load-success and load-failure paths, which forces the loader to be re-importable under a swapped mock.

- [ ] **Step 1: Write the failing test for the load-success and load-failure availability paths.**
  Mirror `audio-normalize.test.ts` style: hoisted shared state, `vi.mock` factories declared before the import, `vi.resetModules()` + `vi.doMock` to exercise the load-failure branch.
  ```ts
  /**
   * voiceprint-service tests — speaker-diarization D4 (spec §6.7, AC4).
   *
   * Capture-only hook. sherpa-onnx-node, ffmpeg (child_process), fs, electron,
   * and ../database are all mocked — no real addon, no real ffmpeg, no device.
   *
   * @vitest-environment node
   */
  import { describe, it, expect, vi, beforeEach } from 'vitest'

  // Hoisted controllable state — resolves before vi.mock factories run.
  const shared = vi.hoisted(() => ({
    sherpaThrows: false as boolean,
    extractorDim: 256 as number,
    computeResult: null as Float32Array | null
  }))

  // Mock: sherpa-onnx-node — a SpeakerEmbeddingExtractor whose ctor can throw.
  vi.mock('sherpa-onnx-node', () => {
    class SpeakerEmbeddingExtractor {
      dim = shared.extractorDim
      constructor() {
        if (shared.sherpaThrows) throw new Error('addon load failed')
      }
      createStream() {
        return {}
      }
      acceptWaveform() {}
      isReady() {
        return true
      }
      compute() {
        return shared.computeResult ?? new Float32Array(shared.extractorDim)
      }
    }
    return { SpeakerEmbeddingExtractor }
  })

  import { isVoiceprintAvailable } from '../voiceprint-service'

  beforeEach(() => {
    shared.sherpaThrows = false
    shared.extractorDim = 256
    shared.computeResult = null
    vi.clearAllMocks()
  })

  describe('voiceprint-service load (§6.7, AC4)', () => {
    it('1. isVoiceprintAvailable() is true when sherpa-onnx-node loads', () => {
      expect(isVoiceprintAvailable()).toBe(true)
    })

    it('2. isVoiceprintAvailable() is false when sherpa-onnx-node is missing', async () => {
      vi.resetModules()
      vi.doMock('sherpa-onnx-node', () => {
        throw new Error('Cannot find module sherpa-onnx-node')
      })
      try {
        const { isVoiceprintAvailable: probe } = await import('../voiceprint-service')
        expect(probe()).toBe(false)
      } finally {
        vi.doUnmock('sherpa-onnx-node')
        vi.resetModules()
      }
    })
  })
  ```

- [ ] **Step 2: Run the test — expect a FAIL (module does not exist yet).**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts
  ```
  Expected output contains:
  ```
  Error: Failed to load url ../voiceprint-service (resolved id: ...voiceprint-service) ... Does the file exist?
   FAIL  electron/main/services/__tests__/voiceprint-service.test.ts
  ```

- [ ] **Step 3: Create `voiceprint-service.ts` with the graceful module-level loader.**
  ```ts
  /**
   * Voiceprint capture hook — speaker-diarization D4 (spec §6.7).
   *
   * v1 = CAPTURE ONLY. Nothing reads voiceprints in v1 (the matcher is Phase 2).
   * On every confirmed speaker→contact mapping (speakers:assign IPC) we pool the
   * label's clean speech, decode it to 16 kHz mono PCM with ffmpeg-static, embed
   * it with sherpa-onnx-node (WeSpeaker), and store a BLOB in `voiceprints`.
   *
   * Graceful degradation (§6.7): sherpa-onnx-node is an OPTIONAL dependency
   * (prebuilt Windows-x64 addon). If it fails to load — non-Windows, missing
   * addon, optionalDependencies no-op — the feature is SILENTLY disabled: one
   * operator log line, no toast; mapping still succeeds. AC4 covers both paths.
   */

  // The WeSpeaker model bundled in app resources (electron-builder asarUnpack).
  // model_id is persisted on every voiceprints row so a future model swap can
  // re-embed (spec §6.3).
  export const VOICEPRINT_MODEL_ID = 'wespeaker_en_voxceleb_resnet34_LM'

  // ---------------------------------------------------------------------------
  // Module-level optional-dependency load. A failed require sets the addon to
  // null; isVoiceprintAvailable() reports it. One log line, no throw (§6.7).
  // ---------------------------------------------------------------------------
  type SherpaModule = {
    SpeakerEmbeddingExtractor: new (config: unknown) => {
      dim: number
      createStream(): unknown
      acceptWaveform(stream: unknown, wave: { sampleRate: number; samples: Float32Array }): void
      isReady(stream: unknown): boolean
      compute(stream: unknown): Float32Array
    }
  }

  let sherpa: SherpaModule | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require('sherpa-onnx-node') as SherpaModule
  } catch (e) {
    console.warn(
      `[Voiceprint] sherpa-onnx-node unavailable — voiceprint capture disabled: ${(e as Error).message}`
    )
    sherpa = null
  }

  /** True when the sherpa-onnx-node addon loaded; false → capture is a no-op. */
  export function isVoiceprintAvailable(): boolean {
    return sherpa !== null
  }
  ```

- [ ] **Step 4: Run the test — expect PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts
  ```
  Expected output:
  ```
   ✓ electron/main/services/__tests__/voiceprint-service.test.ts (2 tests)
     ✓ voiceprint-service load (§6.7, AC4) > 1. isVoiceprintAvailable() is true when sherpa-onnx-node loads
     ✓ voiceprint-service load (§6.7, AC4) > 2. isVoiceprintAvailable() is false when sherpa-onnx-node is missing

   Test Files  1 passed (1)
        Tests  2 passed (2)
  ```

- [ ] **Step 5: Commit.**
  ```
  cd apps/electron && git add electron/main/services/voiceprint-service.ts electron/main/services/__tests__/voiceprint-service.test.ts && git commit -m "feat(diarization): D4-T1 voiceprint-service sherpa lazy-load + graceful degrade (§6.7, AC4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D4-T2: clean-speech gate — pool ≥10 s of non-overlapped speech for a label

**Files:**
- Modify: `electron/main/services/voiceprint-service.ts` (add `collectCleanSpeechMs` + `MIN_CLEAN_SPEECH_MS`)
- Test: `electron/main/services/__tests__/voiceprint-service.test.ts` (extend)

Per §6.7 step (4): *clean speech* = Σ of the label's turn durations where the label's time-range does **not** intersect another label's range. <10 s → skip enrollment. This is a pure function over `Turn[]`, so it is tested in isolation first.

- [ ] **Step 1: Write the failing test for the clean-speech accumulator.**
  Append to `voiceprint-service.test.ts`:
  ```ts
  import { collectCleanSpeechMs, MIN_CLEAN_SPEECH_MS } from '../voiceprint-service'
  import type { Turn } from '../asr/asr-provider'

  describe('collectCleanSpeechMs() — ≥10 s clean-speech gate (§6.7)', () => {
    it('3. sums non-overlapped turns for the target label', () => {
      const turns: Turn[] = [
        { speaker: 'A', startMs: 0, endMs: 4000, text: 'one' },
        { speaker: 'B', startMs: 4000, endMs: 6000, text: 'two' },
        { speaker: 'A', startMs: 6000, endMs: 13000, text: 'three' }
      ]
      // A: 4000 + 7000 = 11000 ms clean (no overlap with B)
      expect(collectCleanSpeechMs(turns, 'A')).toBe(11000)
    })

    it('4. excludes the portion of a label turn that overlaps another label', () => {
      const turns: Turn[] = [
        { speaker: 'A', startMs: 0, endMs: 10000, text: 'a' },
        { speaker: 'B', startMs: 5000, endMs: 7000, text: 'b' } // overlaps A in [5000,7000]
      ]
      // A keeps [0,5000] + [7000,10000] = 5000 + 3000 = 8000 ms clean.
      expect(collectCleanSpeechMs(turns, 'A')).toBe(8000)
    })

    it('5. MIN_CLEAN_SPEECH_MS is 10 s', () => {
      expect(MIN_CLEAN_SPEECH_MS).toBe(10_000)
    })
  })
  ```

- [ ] **Step 2: Run — expect FAIL (`collectCleanSpeechMs` / `MIN_CLEAN_SPEECH_MS` not exported).**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts
  ```
  Expected output contains:
  ```
   FAIL  electron/main/services/__tests__/voiceprint-service.test.ts
   ✓ 1. isVoiceprintAvailable() is true ...
   ✗ 3. sums non-overlapped turns for the target label
     TypeError: collectCleanSpeechMs is not a function
  ```

- [ ] **Step 3: Implement `collectCleanSpeechMs` (overlap subtraction) in `voiceprint-service.ts`.**
  Add after the loader block:
  ```ts
  import type { Turn } from './asr/asr-provider'

  /** §6.7: require ≥10 s of clean (non-overlapped) speech before enrolling. */
  export const MIN_CLEAN_SPEECH_MS = 10_000

  /**
   * Sum the milliseconds of `label`'s turns that do NOT overlap any OTHER
   * label's turn (overlap = intersecting time-ranges, §6.7 step 4). Overlapped
   * sub-ranges are subtracted, not the whole turn — partial overlaps keep their
   * clean remainder.
   */
  export function collectCleanSpeechMs(turns: Turn[], label: string): number {
    const mine = turns.filter((t) => t.speaker === label)
    const others = turns.filter((t) => t.speaker !== label)
    let cleanMs = 0
    for (const turn of mine) {
      // Build the set of [start,end) sub-ranges of this turn not covered by others.
      let segments: Array<[number, number]> = [[turn.startMs, turn.endMs]]
      for (const o of others) {
        const next: Array<[number, number]> = []
        for (const [s, e] of segments) {
          const oStart = Math.max(s, o.startMs)
          const oEnd = Math.min(e, o.endMs)
          if (oStart >= oEnd) {
            next.push([s, e]) // no intersection — keep whole
            continue
          }
          if (s < oStart) next.push([s, oStart]) // clean left remainder
          if (oEnd < e) next.push([oEnd, e]) // clean right remainder
        }
        segments = next
      }
      for (const [s, e] of segments) cleanMs += e - s
    }
    return cleanMs
  }
  ```

- [ ] **Step 4: Run — expect PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts
  ```
  Expected output:
  ```
   ✓ electron/main/services/__tests__/voiceprint-service.test.ts (5 tests)
     ✓ 3. sums non-overlapped turns for the target label
     ✓ 4. excludes the portion of a label turn that overlaps another label
     ✓ 5. MIN_CLEAN_SPEECH_MS is 10 s

   Test Files  1 passed (1)
        Tests  5 passed (5)
  ```

- [ ] **Step 5: Commit.**
  ```
  cd apps/electron && git add electron/main/services/voiceprint-service.ts electron/main/services/__tests__/voiceprint-service.test.ts && git commit -m "feat(diarization): D4-T2 clean-speech gate (≥10s non-overlapped) (§6.7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D4-T3: `voiceprints` DB insert + read (`insertVoiceprint`, `getVoiceprintsByContactId`)

**Files:**
- Modify: `electron/main/services/database.ts` (add `Voiceprint` interface + `insertVoiceprint` + `getVoiceprintsByContactId`, after `insertEmbedding` ~`:2409-2418`)
- Test: `electron/main/services/__tests__/voiceprints-db.test.ts`

The `voiceprints` table already exists (D2 v26 migration). D4 adds the writer/reader. BLOB is bound as a `Uint8Array` exactly like `insertEmbedding` (`database.ts:2409-2414`). Uses the real in-memory sql.js DB (same harness as `database-v25.test.ts`).

- [ ] **Step 1: Write the failing test (real sql.js round-trip of a BLOB embedding).**
  ```ts
  /**
   * voiceprints DB round-trip — speaker-diarization D4 (spec §6.3, AC4).
   *
   * Uses the REAL sql.js in-memory database (same pattern as database-v25.test.ts):
   * only external boundaries (electron, config, file-storage, vector-store) are
   * mocked; sql.js, fs, and database.ts run their real implementations.
   *
   * @vitest-environment node
   */
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
    const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-vp-'))
    const dataDir = _path.join(tmpDir, 'data')
    _fs.mkdirSync(dataDir, { recursive: true })
    return { tmpDir, dataDir, dbPath: _path.join(dataDir, 'hidock.db') }
  })

  vi.mock('electron', () => ({
    app: { getPath: vi.fn(() => os.tmpdir()), getName: vi.fn(() => 'test') },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
    Notification: { isSupported: vi.fn(() => false) }
  }))
  vi.mock('../config', () => ({
    getConfig: vi.fn(() => ({
      storage: { dataPath: shared.tmpDir, maxRecordingsGB: 50 },
      transcription: { provider: 'assemblyai', autoTranscribe: false }
    })),
    updateConfig: vi.fn(async () => {}),
    getDataPath: vi.fn(() => shared.tmpDir)
  }))
  vi.mock('../file-storage', () => ({
    getDatabasePath: vi.fn(() => shared.dbPath),
    getRecordingsPath: vi.fn(() => shared.tmpDir),
    getCachePath: vi.fn(() => os.tmpdir()),
    saveRecording: vi.fn(async (filename: string, _data: Buffer) => path.join(shared.tmpDir, filename))
  }))
  vi.mock('../vector-store', () => ({ initVectorStore: vi.fn(async () => {}) }))

  import { initializeDatabase, closeDatabase, insertVoiceprint, getVoiceprintsByContactId } from '../database'

  beforeEach(async () => {
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    await initializeDatabase()
  })
  afterEach(() => closeDatabase())

  describe('voiceprints insert/read (§6.3, AC4)', () => {
    it('1. round-trips a BLOB embedding with model_id and dim', () => {
      const emb = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      insertVoiceprint({
        id: 'vp_1',
        contact_id: 'c_1',
        model_id: 'wespeaker_en_voxceleb_resnet34_LM',
        dim: 256,
        embedding: emb
      })
      const rows = getVoiceprintsByContactId('c_1')
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe('vp_1')
      expect(rows[0].model_id).toBe('wespeaker_en_voxceleb_resnet34_LM')
      expect(rows[0].dim).toBe(256)
      expect(Array.from(rows[0].embedding)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(typeof rows[0].created_at).toBe('string')
    })

    it('2. allows multiple voiceprints per contact', () => {
      insertVoiceprint({ id: 'vp_a', contact_id: 'c_2', model_id: 'm', dim: 4, embedding: new Uint8Array([1]) })
      insertVoiceprint({ id: 'vp_b', contact_id: 'c_2', model_id: 'm', dim: 4, embedding: new Uint8Array([2]) })
      expect(getVoiceprintsByContactId('c_2')).toHaveLength(2)
    })
  })
  ```

- [ ] **Step 2: Run — expect FAIL (`insertVoiceprint` not exported).**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprints-db.test.ts
  ```
  Expected output contains:
  ```
   FAIL  electron/main/services/__tests__/voiceprints-db.test.ts
   SyntaxError: The requested module '../database' does not provide an export named 'insertVoiceprint'
  ```

- [ ] **Step 3: Add the `Voiceprint` interface + insert/read functions in `database.ts`.**
  Insert immediately after `getAllEmbeddings()` (`database.ts:2420-2422`):
  ```ts
  // Voiceprint queries (speaker-diarization §6.3) — v1 CAPTURE ONLY; nothing
  // reads these for matching in v1 (matcher is Phase 2). BLOB is bound as a
  // Uint8Array exactly like insertEmbedding above.
  export interface Voiceprint {
    id: string
    contact_id: string
    model_id: string
    dim: number
    embedding: Uint8Array
    created_at: string
  }

  export function insertVoiceprint(vp: Omit<Voiceprint, 'created_at'>): void {
    run(
      `INSERT INTO voiceprints (id, contact_id, model_id, dim, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [vp.id, vp.contact_id, vp.model_id, vp.dim, vp.embedding, new Date().toISOString()]
    )
  }

  export function getVoiceprintsByContactId(contactId: string): Voiceprint[] {
    return queryAll<Voiceprint>(
      'SELECT * FROM voiceprints WHERE contact_id = ? ORDER BY created_at',
      [contactId]
    )
  }
  ```

- [ ] **Step 4: Run — expect PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprints-db.test.ts
  ```
  Expected output:
  ```
   ✓ electron/main/services/__tests__/voiceprints-db.test.ts (2 tests)
     ✓ 1. round-trips a BLOB embedding with model_id and dim
     ✓ 2. allows multiple voiceprints per contact

   Test Files  1 passed (1)
        Tests  2 passed (2)
  ```

- [ ] **Step 5: Commit.**
  ```
  cd apps/electron && git add electron/main/services/database.ts electron/main/services/__tests__/voiceprints-db.test.ts && git commit -m "feat(diarization): D4-T3 voiceprints insert/read (BLOB, model_id, dim) (§6.3, AC4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D4-T4: PCM decode of a label's segments (`-ar 16000 -ac 1 -f pcm_s16le pipe:1`)

**Files:**
- Modify: `electron/main/services/voiceprint-service.ts` (add `decodeLabelPcm`)
- Test: `electron/main/services/__tests__/voiceprint-service.test.ts` (extend)

§6.7 step (3): decode the audio to 16 kHz mono PCM, slicing the label's segments. This is a **distinct** invocation from the Whisper MP3 path. Uses `execFile` (the repo's only spawn primitive — verified no `spawn` usage in services) with `maxBuffer` raised for raw PCM, capturing stdout (`pipe:1`) as a `Buffer`. ffmpeg-decode failure → throw (the caller treats it as "skip enrollment, keep mapping", §8). Reuses `resolveFfmpegPath()` from `audio-normalize.ts`.

- [ ] **Step 1: Write the failing test (asserts the exact PCM args + decode-failure throw).**
  Add the `child_process` + `audio-normalize` mocks near the top of `voiceprint-service.test.ts` (alongside the existing `sherpa-onnx-node` mock), then the tests. Extend the hoisted `shared` object first:
  ```ts
  // EXTEND the hoisted shared object (add these fields):
  //   execFileReject: null as null | { message: string; stderr: string },
  //   pcmStdout: Buffer.alloc(0) as Buffer,
  //   capturedArgs: [] as string[]

  vi.mock('child_process', () => {
    const execFile = vi.fn((...args: unknown[]) => {
      const callback = args[args.length - 1] as (e: Error | null, stdout: Buffer, stderr: string) => void
      shared.capturedArgs = args[1] as string[]
      if (shared.execFileReject) {
        const err = Object.assign(new Error(shared.execFileReject!.message), { stderr: shared.execFileReject!.stderr })
        callback(err, Buffer.alloc(0), shared.execFileReject!.stderr)
      } else {
        callback(null, shared.pcmStdout, '')
      }
      return { pid: 1 }
    })
    return { execFile }
  })

  // Reuse the real resolveFfmpegPath by stubbing only its ffmpeg-static + electron deps:
  vi.mock('../asr/audio-normalize', () => ({
    resolveFfmpegPath: vi.fn(() => '/fake/ffmpeg')
  }))

  import { decodeLabelPcm } from '../voiceprint-service'

  describe('decodeLabelPcm() — distinct PCM invocation (§6.7 step 3)', () => {
    beforeEach(() => {
      shared.execFileReject = null
      shared.pcmStdout = Buffer.from([0, 1, 0, 2]) // 2 s16le samples
      shared.capturedArgs = []
    })

    it('6. decodes 16 kHz mono pcm_s16le to stdout (pipe:1), NOT mp3', async () => {
      const buf = await decodeLabelPcm('/recordings/m.hda')
      expect(shared.capturedArgs).toContain('-ar')
      expect(shared.capturedArgs).toContain('16000')
      expect(shared.capturedArgs).toContain('-ac')
      expect(shared.capturedArgs).toContain('1')
      expect(shared.capturedArgs).toContain('-f')
      expect(shared.capturedArgs).toContain('pcm_s16le')
      expect(shared.capturedArgs).toContain('pipe:1')
      expect(shared.capturedArgs).not.toContain('-b:a') // never the MP3 bitrate flag
      expect(Buffer.isBuffer(buf)).toBe(true)
      expect(buf.length).toBe(4)
    })

    it('7. ffmpeg decode failure throws (caller skips enrollment, keeps mapping)', async () => {
      shared.execFileReject = { message: 'exit 1', stderr: 'bad input' }
      await expect(decodeLabelPcm('/recordings/bad.hda')).rejects.toThrow(/pcm decode failed/i)
    })
  })
  ```

- [ ] **Step 2: Run — expect FAIL (`decodeLabelPcm` not exported).**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts
  ```
  Expected output contains:
  ```
   ✗ 6. decodes 16 kHz mono pcm_s16le to stdout (pipe:1), NOT mp3
     TypeError: decodeLabelPcm is not a function
  ```

- [ ] **Step 3: Implement `decodeLabelPcm` in `voiceprint-service.ts`.**
  Add the imports at the top and the function:
  ```ts
  import { execFile } from 'child_process'
  import { promisify } from 'util'
  import { resolveFfmpegPath } from './asr/audio-normalize'

  const execFileAsync = promisify(execFile)
  // Raw PCM is far larger than MP3; lift the stdout cap well above the default 1 MB.
  const PCM_MAX_BUFFER = 256 * 1024 * 1024

  /**
   * Decode the whole input to 16 kHz mono signed-16-bit little-endian PCM on
   * stdout (`pipe:1`). DISTINCT from the Whisper path's MP3 output (§6.7) — no
   * `-b:a`, format is pcm_s16le. Returns the raw PCM Buffer; throws on ffmpeg
   * failure so the caller can skip enrollment while keeping the mapping (§8).
   * Segment slicing by the label's turns is applied by the caller in PCM space
   * (16-bit samples → 32000 bytes/s), avoiding one ffmpeg call per turn.
   */
  export async function decodeLabelPcm(filePath: string): Promise<Buffer> {
    const ffmpeg = resolveFfmpegPath()
    const args = ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'pcm_s16le', 'pipe:1']
    try {
      const { stdout } = await execFileAsync(ffmpeg, args, {
        encoding: 'buffer',
        maxBuffer: PCM_MAX_BUFFER
      })
      return stdout as Buffer
    } catch (e) {
      throw new Error(`pcm decode failed for ${filePath}: ${String((e as { stderr?: string }).stderr ?? (e as Error).message).slice(-200)}`)
    }
  }
  ```

- [ ] **Step 4: Run — expect PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts
  ```
  Expected output:
  ```
   ✓ electron/main/services/__tests__/voiceprint-service.test.ts (7 tests)
     ✓ 6. decodes 16 kHz mono pcm_s16le to stdout (pipe:1), NOT mp3
     ✓ 7. ffmpeg decode failure throws (caller skips enrollment, keeps mapping)

   Test Files  1 passed (1)
        Tests  7 passed (7)
  ```

- [ ] **Step 5: Commit.**
  ```
  cd apps/electron && git add electron/main/services/voiceprint-service.ts electron/main/services/__tests__/voiceprint-service.test.ts && git commit -m "feat(diarization): D4-T4 PCM decode (-f pcm_s16le pipe:1, distinct from MP3) (§6.7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D4-T5: `captureVoiceprint(recordingId, fileLabel, contactId)` — the full hook (AC4)

**Files:**
- Modify: `electron/main/services/voiceprint-service.ts` (add `captureVoiceprint`)
- Test: `electron/main/services/__tests__/voiceprint-service.test.ts` (extend; mock `../database`)

The orchestrator. AC4 enumerates the four outcomes: (a) ≥10 s clean → one `voiceprints` row with correct `model_id`/`dim`; (b) <10 s clean → no row; (c) ffmpeg-decode failure → no row; (d) sherpa unavailable → no-op. All return `{ captured: boolean; reason?: string }` so the IPC handler never throws (mapping always succeeds, §6.7/§8). `model_id = VOICEPRINT_MODEL_ID`; `dim = extractor.dim`.

- [ ] **Step 1: Write the failing tests for all four AC4 outcomes.**
  Add the `../database` mock and tests to `voiceprint-service.test.ts`:
  ```ts
  vi.mock('../database', () => ({
    getRecordingById: vi.fn(),
    getTranscriptByRecordingId: vi.fn(),
    insertVoiceprint: vi.fn()
  }))
  import { captureVoiceprint } from '../voiceprint-service'
  import * as db from '../database'

  describe('captureVoiceprint() — AC4 four outcomes (§6.7)', () => {
    const longTurns = JSON.stringify([
      { speaker: 'A', startMs: 0, endMs: 12000, text: 'plenty' } // 12 s clean ≥ 10 s
    ])
    beforeEach(() => {
      vi.mocked(db.getRecordingById).mockReturnValue({ file_path: '/recordings/m.hda' } as never)
      vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ turns: longTurns } as never)
      vi.mocked(db.insertVoiceprint).mockReset()
      shared.execFileReject = null
      shared.pcmStdout = Buffer.alloc(32000 * 12) // 12 s of 16 kHz s16le mono
      shared.extractorDim = 256
      shared.computeResult = new Float32Array(256).fill(0.5)
    })

    it('8a. ≥10s clean speech → one voiceprints row with model_id + dim', async () => {
      const res = await captureVoiceprint('rec_1', 'A', 'c_1')
      expect(res.captured).toBe(true)
      expect(vi.mocked(db.insertVoiceprint)).toHaveBeenCalledTimes(1)
      const row = vi.mocked(db.insertVoiceprint).mock.calls[0][0]
      expect(row.contact_id).toBe('c_1')
      expect(row.model_id).toBe('wespeaker_en_voxceleb_resnet34_LM')
      expect(row.dim).toBe(256)
      expect(row.embedding).toBeInstanceOf(Uint8Array)
    })

    it('8b. <10s clean speech → mapping kept, NO voiceprint', async () => {
      vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
        turns: JSON.stringify([{ speaker: 'A', startMs: 0, endMs: 3000, text: 'short' }])
      } as never)
      const res = await captureVoiceprint('rec_1', 'A', 'c_1')
      expect(res.captured).toBe(false)
      expect(res.reason).toMatch(/clean speech/i)
      expect(vi.mocked(db.insertVoiceprint)).not.toHaveBeenCalled()
    })

    it('8c. ffmpeg decode failure → mapping kept, NO voiceprint', async () => {
      shared.execFileReject = { message: 'exit 1', stderr: 'bad' }
      const res = await captureVoiceprint('rec_1', 'A', 'c_1')
      expect(res.captured).toBe(false)
      expect(res.reason).toMatch(/decode/i)
      expect(vi.mocked(db.insertVoiceprint)).not.toHaveBeenCalled()
    })

    it('8d. sherpa unavailable → no-op, no throw', async () => {
      vi.resetModules()
      vi.doMock('sherpa-onnx-node', () => {
        throw new Error('missing addon')
      })
      try {
        const mod = await import('../voiceprint-service')
        const res = await mod.captureVoiceprint('rec_1', 'A', 'c_1')
        expect(res.captured).toBe(false)
        expect(res.reason).toMatch(/unavailable/i)
      } finally {
        vi.doUnmock('sherpa-onnx-node')
        vi.resetModules()
      }
    })

    it('8e. audio file not downloaded (file_path null) → no-op, no throw', async () => {
      vi.mocked(db.getRecordingById).mockReturnValue({ file_path: null } as never)
      const res = await captureVoiceprint('rec_1', 'A', 'c_1')
      expect(res.captured).toBe(false)
      expect(vi.mocked(db.insertVoiceprint)).not.toHaveBeenCalled()
    })
  })
  ```

- [ ] **Step 2: Run — expect FAIL (`captureVoiceprint` not exported).**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts
  ```
  Expected output contains:
  ```
   ✗ 8a. ≥10s clean speech → one voiceprints row with model_id + dim
     TypeError: captureVoiceprint is not a function
  ```

- [ ] **Step 3: Implement `captureVoiceprint` in `voiceprint-service.ts`.**
  Add the imports + the orchestrator and a lazy extractor initializer:
  ```ts
  import { randomUUID } from 'crypto'
  import { join } from 'path'
  import { app } from 'electron'
  import { getRecordingById, getTranscriptByRecordingId, insertVoiceprint } from './database'

  export interface CaptureResult {
    captured: boolean
    reason?: string
  }

  // Lazy-init the extractor on first use (§6.7). null until first capture; the
  // ctor can throw on a bad/missing model — that degrades to "unavailable".
  type Extractor = InstanceType<SherpaModule['SpeakerEmbeddingExtractor']>
  let extractor: Extractor | null = null

  function getExtractor(): Extractor | null {
    if (!sherpa) return null
    if (extractor) return extractor
    try {
      const modelPath = app.isPackaged
        ? join(process.resourcesPath, 'models', `${VOICEPRINT_MODEL_ID}.onnx`)
        : join(app.getAppPath(), 'resources', 'models', `${VOICEPRINT_MODEL_ID}.onnx`)
      extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false })
      return extractor
    } catch (e) {
      console.warn(`[Voiceprint] extractor init failed — capture disabled: ${(e as Error).message}`)
      return null
    }
  }

  /** Float32 embedding → little-endian byte BLOB (4 bytes/element). */
  function embeddingToBlob(vec: Float32Array): Uint8Array {
    return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
  }

  /**
   * Capture-only voiceprint hook (§6.7, AC4). Fired by the speakers:assign IPC
   * after the recording_speakers row is written. NEVER throws — every failure
   * mode returns { captured:false, reason } so the mapping always succeeds.
   *
   * Outcomes (AC4): sherpa unavailable → no-op; file not downloaded → no-op;
   * <10 s clean speech → skip; ffmpeg decode failure → skip; otherwise store one
   * voiceprints row with model_id=WeSpeaker + dim=extractor.dim.
   */
  export async function captureVoiceprint(
    recordingId: string,
    fileLabel: string,
    contactId: string
  ): Promise<CaptureResult> {
    const ext = getExtractor()
    if (!ext) return { captured: false, reason: 'voiceprint unavailable' }

    const recording = getRecordingById(recordingId)
    if (!recording?.file_path) return { captured: false, reason: 'audio file not downloaded' }

    const transcript = getTranscriptByRecordingId(recordingId)
    let turns: Turn[] = []
    try {
      turns = transcript?.turns ? (JSON.parse(transcript.turns) as Turn[]) : []
    } catch {
      turns = []
    }

    const cleanMs = collectCleanSpeechMs(turns, fileLabel)
    if (cleanMs < MIN_CLEAN_SPEECH_MS) {
      return { captured: false, reason: `insufficient clean speech (${cleanMs} ms < ${MIN_CLEAN_SPEECH_MS} ms)` }
    }

    let pcm: Buffer
    try {
      pcm = await decodeLabelPcm(recording.file_path)
    } catch (e) {
      return { captured: false, reason: `decode failed: ${(e as Error).message}` }
    }

    // pcm_s16le mono → Float32 in [-1,1]; slice this label's clean ranges.
    const samples = pcmToFloat32(pcm, turns, fileLabel)
    if (samples.length === 0) return { captured: false, reason: 'no usable samples after slicing' }

    const stream = ext.createStream()
    ext.acceptWaveform(stream, { sampleRate: 16000, samples })
    if (!ext.isReady(stream)) return { captured: false, reason: 'extractor not ready' }
    const embedding = ext.compute(stream)

    insertVoiceprint({
      id: `vp_${randomUUID()}`,
      contact_id: contactId,
      model_id: VOICEPRINT_MODEL_ID,
      dim: ext.dim,
      embedding: embeddingToBlob(embedding)
    })
    return { captured: true }
  }

  /** Convert 16 kHz s16le mono PCM bytes to Float32 samples, keeping only the
   *  label's turn ranges (16 samples/ms → 32 bytes/ms). */
  function pcmToFloat32(pcm: Buffer, turns: Turn[], label: string): Float32Array {
    const BYTES_PER_MS = 32 // 16000 samples/s * 2 bytes / 1000 ms
    const out: number[] = []
    for (const t of turns) {
      if (t.speaker !== label) continue
      const start = Math.max(0, Math.floor(t.startMs * BYTES_PER_MS))
      const end = Math.min(pcm.length, Math.floor(t.endMs * BYTES_PER_MS))
      for (let i = start; i + 1 < end; i += 2) {
        out.push(pcm.readInt16LE(i) / 32768)
      }
    }
    return Float32Array.from(out)
  }
  ```

- [ ] **Step 4: Run — expect PASS (all five AC4 cases).**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts
  ```
  Expected output:
  ```
   ✓ electron/main/services/__tests__/voiceprint-service.test.ts (12 tests)
     ✓ 8a. ≥10s clean speech → one voiceprints row with model_id + dim
     ✓ 8b. <10s clean speech → mapping kept, NO voiceprint
     ✓ 8c. ffmpeg decode failure → mapping kept, NO voiceprint
     ✓ 8d. sherpa unavailable → no-op, no throw
     ✓ 8e. audio file not downloaded (file_path null) → no-op, no throw

   Test Files  1 passed (1)
        Tests  12 passed (12)
  ```

- [ ] **Step 5: Commit.**
  ```
  cd apps/electron && git add electron/main/services/voiceprint-service.ts electron/main/services/__tests__/voiceprint-service.test.ts && git commit -m "feat(diarization): D4-T5 captureVoiceprint orchestrator — AC4 four outcomes (§6.7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D4-T6: wire `speakers:assign` IPC → `captureVoiceprint` (mapping always succeeds)

**Files:**
- Modify: `electron/main/ipc/speakers-handlers.ts` (the `speakers:assign` handler created in D3)
- Test: `electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts`

D3's `speakers:assign` already writes the `recording_speakers` row. D4 adds a **fire-and-forget** call to `captureVoiceprint` after that write so a slow/failed capture never blocks or fails the assignment (§6.7 — "mapping still works"). The handler returns the same `Person`/success shape it returned in D3; the capture result is only logged.

- [ ] **Step 1: Read the current D3 handler to anchor the edit.**
  ```
  cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts
  ```
  (Will FAIL — test does not exist yet; this step is to confirm the handler file/signature from D3 before editing. Open `electron/main/ipc/speakers-handlers.ts` and locate the `ipcMain.handle('speakers:assign', ...)` body that calls the D3 `recording_speakers` writer.)

- [ ] **Step 2: Write the failing test (capture invoked after the row write; failure does not fail the IPC).**
  ```ts
  /**
   * speakers:assign → voiceprint capture wiring — D4 (§6.7, AC4).
   *
   * Asserts the handler fires captureVoiceprint after writing the
   * recording_speakers row, and that a capture failure never fails the IPC.
   *
   * @vitest-environment node
   */
  import { describe, it, expect, vi, beforeEach } from 'vitest'

  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  vi.mock('electron', () => ({
    ipcMain: { handle: vi.fn((ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn)) }
  }))
  vi.mock('../../services/voiceprint-service', () => ({
    captureVoiceprint: vi.fn(async () => ({ captured: true }))
  }))
  // D3's recording_speakers writer + any contact lookups the handler uses:
  vi.mock('../../services/database', () => ({
    upsertRecordingSpeaker: vi.fn(),
    getContactById: vi.fn(() => ({ id: 'c_1', name: 'Alice' }))
  }))

  import { registerSpeakersHandlers } from '../speakers-handlers'
  import { captureVoiceprint } from '../../services/voiceprint-service'

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerSpeakersHandlers()
  })

  describe('speakers:assign → voiceprint capture (§6.7)', () => {
    it('1. invokes captureVoiceprint(recordingId, fileLabel, contactId) after assign', async () => {
      const fn = handlers.get('speakers:assign')!
      await fn({}, { recordingId: 'rec_1', fileLabel: 'A', contactId: 'c_1' })
      expect(vi.mocked(captureVoiceprint)).toHaveBeenCalledWith('rec_1', 'A', 'c_1')
    })

    it('2. capture failure does not fail the assignment IPC', async () => {
      vi.mocked(captureVoiceprint).mockRejectedValueOnce(new Error('boom'))
      const fn = handlers.get('speakers:assign')!
      const res = (await fn({}, { recordingId: 'rec_1', fileLabel: 'A', contactId: 'c_1' })) as { success: boolean }
      expect(res.success).toBe(true)
    })
  })
  ```

- [ ] **Step 3: Run — expect FAIL (handler does not yet call captureVoiceprint).**
  ```
  cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts
  ```
  Expected output contains:
  ```
   ✗ 1. invokes captureVoiceprint(recordingId, fileLabel, contactId) after assign
     AssertionError: expected "captureVoiceprint" to be called with arguments: [ 'rec_1', 'A', 'c_1' ]
     Number of calls: 0
  ```

- [ ] **Step 4: Add the fire-and-forget capture call to the `speakers:assign` handler.**
  In `electron/main/ipc/speakers-handlers.ts`, add the import and, immediately after the D3 `recording_speakers` write inside the `speakers:assign` handler (before `return success(...)`), insert the capture trigger:
  ```ts
  import { captureVoiceprint } from '../services/voiceprint-service'

  // … inside ipcMain.handle('speakers:assign', async (_, req) => { … after the
  //    recording_speakers row is written, before the success return:

  // Fire-and-forget voiceprint capture (§6.7). NEVER block or fail the mapping:
  // a slow/missing sherpa addon or short clean-speech must not affect assign.
  void captureVoiceprint(recordingId, fileLabel, contactId)
    .then((r) => {
      if (!r.captured) console.log(`[Voiceprint] skipped (${recordingId}/${fileLabel}): ${r.reason}`)
    })
    .catch((e) => console.warn(`[Voiceprint] capture error (${recordingId}/${fileLabel}): ${(e as Error).message}`))
  ```
  > Use the exact `recordingId`/`fileLabel`/`contactId` identifiers the D3 handler already destructured from its validated request; rename only if D3 used different locals.

- [ ] **Step 5: Run — expect PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts
  ```
  Expected output:
  ```
   ✓ electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts (2 tests)
     ✓ 1. invokes captureVoiceprint(recordingId, fileLabel, contactId) after assign
     ✓ 2. capture failure does not fail the assignment IPC

   Test Files  1 passed (1)
        Tests  2 passed (2)
  ```

- [ ] **Step 6: Commit.**
  ```
  cd apps/electron && git add electron/main/ipc/speakers-handlers.ts electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts && git commit -m "feat(diarization): D4-T6 wire speakers:assign -> fire-and-forget captureVoiceprint (§6.7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D4-T7: dependency + bundle config (`sherpa-onnx-node` optionalDependency, electron-builder model)

**Files:**
- Modify: `apps/electron/package.json` (add `optionalDependencies`)
- Modify: `apps/electron/electron-builder.yml` (`asarUnpack` model + `extraResources` model file)
- Test: `electron/main/services/__tests__/voiceprint-bundle-config.test.ts`

`sherpa-onnx-node` is version-pinned in `optionalDependencies` so a failed prebuilt-addon install never breaks `npm install` (graceful degrade, §6.7/§11). The `.node` addon is already covered by the existing `**/*.node` `asarUnpack` glob (`electron-builder.yml:13`); D4 adds the WeSpeaker ONNX model to `extraResources` + `asarUnpack`, mirroring `ffmpeg-static`. A small JSON-shape test guards both files against regression.

- [ ] **Step 1: Write the failing test asserting the dependency + bundle wiring.**
  ```ts
  /**
   * Voiceprint bundle config — D4 (§6.7, §11). Guards the optionalDependency pin
   * and the electron-builder model bundling so a refactor can't silently drop them.
   *
   * @vitest-environment node
   */
  import { describe, it, expect } from 'vitest'
  import { readFileSync } from 'fs'
  import { join } from 'path'

  const root = join(__dirname, '..', '..', '..', '..') // apps/electron

  describe('voiceprint bundle config (§6.7, §11)', () => {
    it('1. sherpa-onnx-node is a version-pinned optionalDependency', () => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
      expect(pkg.optionalDependencies?.['sherpa-onnx-node']).toBeDefined()
      // Pinned exact version (no ^ / ~ range — the prebuilt addon is platform-fragile).
      expect(pkg.optionalDependencies['sherpa-onnx-node']).toMatch(/^\d+\.\d+\.\d+/)
    })

    it('2. electron-builder unpacks the WeSpeaker model + ships it in extraResources', () => {
      const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf-8')
      expect(yml).toContain('wespeaker_en_voxceleb_resnet34_LM.onnx')
      expect(yml).toContain('resources/models')
    })
  })
  ```

- [ ] **Step 2: Run — expect FAIL (no optionalDependencies / model not in yml).**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-bundle-config.test.ts
  ```
  Expected output contains:
  ```
   ✗ 1. sherpa-onnx-node is a version-pinned optionalDependency
     AssertionError: expected undefined to be defined
  ```

- [ ] **Step 3a: Add the `optionalDependencies` block to `package.json`.**
  Insert after the `dependencies` block (after `package.json:64` `}`), before `devDependencies`:
  ```json
  "optionalDependencies": {
    "sherpa-onnx-node": "1.10.30"
  },
  ```
  > Pin to the latest published `sherpa-onnx-node` with a prebuilt `sherpa-onnx-win-x64` addon at implementation time; `1.10.30` is the placeholder pin — verify the exact published version with `npm view sherpa-onnx-node version` before committing and update the test's expectation accordingly. No `^`/`~` (the prebuilt addon is platform-fragile).

- [ ] **Step 3b: Add the model to `electron-builder.yml`.**
  Extend `asarUnpack` and add an `extraResources` mapping for the bundled ONNX model. Replace the existing `asarUnpack` block (`electron-builder.yml:12-15`):
  ```yaml
  asarUnpack:
    - '**/*.node'
    - '**/usb/**'
    - '**/ffmpeg-static/**'
    - '**/sherpa-onnx-node/**'
    - 'resources/models/wespeaker_en_voxceleb_resnet34_LM.onnx'
  extraResources:
    - from: resources/models/wespeaker_en_voxceleb_resnet34_LM.onnx
      to: models/wespeaker_en_voxceleb_resnet34_LM.onnx
  ```
  > The model file (~26.5 MB) must be placed at `apps/electron/resources/models/wespeaker_en_voxceleb_resnet34_LM.onnx` (download from the k2-fsa WeSpeaker release). `getExtractor()` in D4-T5 resolves it from `process.resourcesPath/models/` in packaged builds and `resources/models/` in dev — matching this `to:` target.

- [ ] **Step 4: Run — expect PASS.**
  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-bundle-config.test.ts
  ```
  Expected output:
  ```
   ✓ electron/main/services/__tests__/voiceprint-bundle-config.test.ts (2 tests)
     ✓ 1. sherpa-onnx-node is a version-pinned optionalDependency
     ✓ 2. electron-builder unpacks the WeSpeaker model + ships it in extraResources

   Test Files  1 passed (1)
        Tests  2 passed (2)
  ```

- [ ] **Step 5: Commit.**
  ```
  cd apps/electron && git add package.json electron-builder.yml electron/main/services/__tests__/voiceprint-bundle-config.test.ts && git commit -m "build(diarization): D4-T7 sherpa-onnx-node optionalDependency + WeSpeaker model bundling (§6.7, §11)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D4-T8: phase gate — typecheck, lint, full test run

**Files:**
- Test: (none new) — run the existing gates over the whole D4 surface

- [ ] **Step 1: Run the full quality gates (spec §10).**
  ```
  cd apps/electron && npm run typecheck && npm run lint && npm run test:run
  ```
  Expected: typecheck exits 0, lint exits 0, and the new D4 specs all pass within the full Vitest run:
  ```
   ✓ electron/main/services/__tests__/voiceprint-service.test.ts (12 tests)
   ✓ electron/main/services/__tests__/voiceprints-db.test.ts (2 tests)
   ✓ electron/main/services/__tests__/voiceprint-bundle-config.test.ts (2 tests)
   ✓ electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts (2 tests)

   Test Files  N passed (N)
        Tests  M passed (M)
  ```

- [ ] **Step 2: If typecheck flags the `require('sherpa-onnx-node')` (no types), confirm the cast-through-`SherpaModule` is honored; if lint flags the `require`, the `// eslint-disable-next-line @typescript-eslint/no-require-imports` directive (already on that line in D4-T1) suppresses it — matching the `ffmpeg-static` precedent in `audio-normalize.ts:7`. No code change unless a gate actually fails; then fix and re-run Step 1.**

- [ ] **Step 3: Commit only if Step 2 required a fix.**
  ```
  cd apps/electron && git add -A && git commit -m "chore(diarization): D4-T8 satisfy typecheck/lint gates for voiceprint hook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

**Phase D4 done-when:** `voiceprint-service.ts` exists with `isVoiceprintAvailable`, `collectCleanSpeechMs`, `decodeLabelPcm`, `captureVoiceprint`; `voiceprints` insert/read live in `database.ts`; `speakers:assign` fires fire-and-forget capture; `sherpa-onnx-node` is a pinned optionalDependency with the WeSpeaker model bundled; all four AC4 outcomes (≥10 s capture, <10 s skip, decode-failure skip, sherpa-missing no-op) plus the file-not-downloaded no-op are green; typecheck/lint/test gates pass. **Voiceprints are written but read by nothing (matcher is Phase 2).**

## Phase D5 — Attributed summaries + staleness badge + re-transcribe confirm

> Spec sections: §6.6 (attributed summaries + staleness badge), §6.8 (re-transcribe confirmation). ACs: **AC5** (summary input speaker-labeled; staleness badge appears after mapping and clears after resummarize; resummarize does NOT re-call AssemblyAI), **AC6** ("transcribe again" shows confirm; confirm re-runs AssemblyAI + replaces transcript + drops prior `recording_speakers`; cancel does nothing).
>
> **Depends on:** D2 (`transcripts.turns TEXT` column, `recording_speakers` table, Stage-1 persistence of `turns`/`speakers`/`sentiment`), D3 (`TranscriptViewer` `turns?: Turn[]` prop already rendering structured turns + `getRecordingSpeakers` / `speakers:assign`). D5 adds NO migration — it bumps `SCHEMA_VERSION` for nothing and creates no tables.
>
> **Mocks-first; zero real-hardware/USB.** All Vitest, run from `apps/electron`. Main-side tests use the real in-memory sql.js DB (mirror `two-stage-worker.test.ts`); renderer tests mock `window.electronAPI` (mirror `SourceReader.metadata.test.tsx`).
>
> **Staleness design decision (no new column):** there is no `summarized_at` column and adding one is D2's province. `transcripts.created_at` is NOT used for sort/ordering anywhere load-bearing (verified: the only `transcripts.created_at` reader is the drawer "Transcribed" label). So the Stage-2 write is extended to stamp `created_at = CURRENT_TIMESTAMP` on every (re)summarize, and `isSummaryStale(recordingId)` returns true iff `MAX(recording_speakers.created_at) > transcripts.created_at`. After a resummarize the stamp moves past the mapping rows and the badge clears. The drawer label is relabeled "Last processed" to match the new semantics.

---

### Task D5-T1: Stage-2 input is built from `turns` + mapped contact names (attributed summaries)

**Files:**
- Modify: `electron/main/services/database.ts` — add `getRecordingSpeakers(recordingId)` reader near `getTranscriptByRecordingId` (~`:2234`) if D3 has not already landed it; add `buildAttributedTranscript(recordingId)` helper (after `clearTranscriptStage2Marker`, ~`:2376`).
- Modify: `electron/main/services/transcription.ts` — Stage 2 builds `fullText` for the analysis prompt from `turns` + mapped names (around the analysis prompt build, ~`:539-554`).
- Test: `electron/main/services/__tests__/attributed-summary.test.ts` (new).

> The Stage-2 LLM call (`llm.generate`) and the JSON parsing are unchanged — only the **input text** the worker passes into `analysisPrompt` changes (spec §6.6: "Stage 2 builds its input from `turns`, prefixing each with the mapped contact name if available, else the `file_label`"). When `turns` is absent (Whisper/Gemini / pre-migration rows) the worker falls back to today's flat `full_text` — the named regression in §10(c).

- [ ] **Step 1: Write the failing test for `buildAttributedTranscript` (turns + mapped names).**

  Create `electron/main/services/__tests__/attributed-summary.test.ts`:

  ```ts
  // @vitest-environment node
  import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
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
    const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-attrib-'))
    const dataDir = _path.join(tmpDir, 'data')
    _fs.mkdirSync(dataDir, { recursive: true })
    return { tmpDir, dataDir, dbPath: _path.join(dataDir, 'hidock.db') }
  })

  vi.mock('electron', () => ({
    app: { getPath: vi.fn(() => os.tmpdir()), getName: vi.fn(() => 'test') },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
    Notification: { isSupported: vi.fn(() => false) }
  }))
  vi.mock('../file-storage', () => ({
    getDatabasePath: vi.fn(() => shared.dbPath),
    getRecordingsPath: vi.fn(() => shared.dataDir),
    getCachePath: vi.fn(() => os.tmpdir())
  }))

  import {
    initializeDatabase,
    closeDatabase,
    run,
    upsertTranscriptStage1,
    buildAttributedTranscript
  } from '../database'

  function insertRecording(id: string): void {
    run(
      `INSERT OR IGNORE INTO recordings
         (id, filename, file_path, date_recorded, status, transcription_status,
          location, on_device, on_local, created_at)
       VALUES (?, ?, ?, ?, 'complete', 'complete', 'local-only', 0, 1, ?)`,
      [id, `${id}.hda`, `/tmp/${id}.hda`, new Date().toISOString(), new Date().toISOString()]
    )
  }
  function insertContact(id: string, name: string): void {
    run(
      `INSERT OR IGNORE INTO contacts (id, name, type, created_at) VALUES (?, ?, 'person', ?)`,
      [id, name, new Date().toISOString()]
    )
  }

  describe('buildAttributedTranscript (spec §6.6)', () => {
    beforeEach(async () => {
      if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
      await initializeDatabase()
    })
    afterEach(() => { try { closeDatabase() } catch { /* ignore */ } })

    it('prefixes each turn with the mapped contact name when a recording_speakers row exists, else the file_label', async () => {
      insertRecording('rA')
      insertContact('cA', 'Alice')
      const turns = [
        { speaker: 'A', startMs: 0, endMs: 2000, text: 'Hello there' },
        { speaker: 'B', startMs: 2000, endMs: 4000, text: 'Hi back' },
        { speaker: 'A', startMs: 4000, endMs: 6000, text: 'How are you' }
      ]
      upsertTranscriptStage1({
        recording_id: 'rA',
        full_text: 'Hello there Hi back How are you',
        language: 'en',
        word_count: 7,
        transcription_provider: 'assemblyai',
        transcription_model: 'universal-3-pro'
      })
      run('UPDATE transcripts SET turns = ? WHERE recording_id = ?', [JSON.stringify(turns), 'rA'])
      // Map only label A -> Alice; B stays generic.
      run(
        `INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at)
         VALUES ('rA', 'A', 'cA', 'user', ?)`,
        [new Date().toISOString()]
      )

      const text = buildAttributedTranscript('rA')!
      expect(text).toBe('Alice: Hello there\nSpeaker B: Hi back\nAlice: How are you')
    })

    it('returns the flat full_text when turns is absent (Whisper/Gemini / pre-migration)', async () => {
      insertRecording('rB')
      upsertTranscriptStage1({
        recording_id: 'rB',
        full_text: 'flat transcript with no turns',
        language: 'en',
        word_count: 5,
        transcription_provider: 'gemini',
        transcription_model: 'gemini-2.0-flash'
      })
      const text = buildAttributedTranscript('rB')!
      expect(text).toBe('flat transcript with no turns')
    })

    it('returns the flat full_text when turns is an empty array (zero-speaker)', async () => {
      insertRecording('rC')
      upsertTranscriptStage1({
        recording_id: 'rC',
        full_text: 'music only no speech',
        language: 'en',
        word_count: 4,
        transcription_provider: 'assemblyai',
        transcription_model: 'universal-3-pro'
      })
      run('UPDATE transcripts SET turns = ? WHERE recording_id = ?', ['[]', 'rC'])
      const text = buildAttributedTranscript('rC')!
      expect(text).toBe('music only no speech')
    })
  })

  afterAll(() => {
    try { fs.rmSync(shared.tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })
  ```

- [ ] **Step 2: Run the test, confirm it FAILS (helper does not exist).**

  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/attributed-summary.test.ts
  ```

  Expected output (compile/runtime error — `buildAttributedTranscript` is not exported):

  ```
  FAIL  electron/main/services/__tests__/attributed-summary.test.ts
   × buildAttributedTranscript (spec §6.6) > prefixes each turn ...
     → buildAttributedTranscript is not a function
  Test Files  1 failed (1)
  ```

- [ ] **Step 3: Implement `getRecordingSpeakers` + `buildAttributedTranscript` in `database.ts`.**

  Insert AFTER `clearTranscriptStage2Marker` (ends ~`:2376`). If D3 already added `getRecordingSpeakers`, skip its block and keep only `buildAttributedTranscript`.

  ```ts
  /** D5 §6.6: roster of label->contact_id maps written by speakers:assign (source 'user').
   *  Returns one row per file_label that has been mapped to a contact. */
  export function getRecordingSpeakers(recordingId: string): Array<{
    recording_id: string
    file_label: string
    contact_id: string | null
    confidence: number | null
    source: string
    created_at: string
  }> {
    return queryAll('SELECT * FROM recording_speakers WHERE recording_id = ?', [recordingId])
  }

  /** D5 §6.6: build the Stage-2 analysis input from structured turns, prefixing
   *  each turn with the mapped contact NAME (via recording_speakers -> contacts)
   *  when present, else the human "Speaker <label>" form. Falls back to the flat
   *  full_text when turns is absent/empty (Whisper/Gemini / pre-migration / zero-
   *  speaker rows) — the §10(c) regression path. Returns undefined when there is
   *  no transcript row. */
  export function buildAttributedTranscript(recordingId: string): string | undefined {
    const t = queryOne<{ full_text: string; turns: string | null }>(
      'SELECT full_text, turns FROM transcripts WHERE recording_id = ?',
      [recordingId]
    )
    if (!t) return undefined

    let turns: Array<{ speaker: string; text: string }> = []
    if (t.turns) {
      try {
        const parsed = JSON.parse(t.turns)
        if (Array.isArray(parsed)) turns = parsed
      } catch {
        turns = []
      }
    }
    if (turns.length === 0) return t.full_text

    // label -> contact name (only for mapped labels)
    const speakers = getRecordingSpeakers(recordingId)
    const nameByLabel = new Map<string, string>()
    for (const s of speakers) {
      if (!s.contact_id) continue
      const c = queryOne<{ name: string }>('SELECT name FROM contacts WHERE id = ?', [s.contact_id])
      if (c?.name) nameByLabel.set(s.file_label, c.name)
    }

    return turns
      .map((turn) => {
        const label = nameByLabel.get(turn.speaker) ?? `Speaker ${turn.speaker}`
        return `${label}: ${turn.text}`
      })
      .join('\n')
  }
  ```

- [ ] **Step 4: Run the test, confirm it PASSES.**

  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/attributed-summary.test.ts
  ```

  Expected output:

  ```
  ✓ electron/main/services/__tests__/attributed-summary.test.ts (3)
  Test Files  1 passed (1)
  Tests  3 passed (3)
  ```

- [ ] **Step 5: Wire the worker to use `buildAttributedTranscript` for the Stage-2 prompt input.**

  In `electron/main/services/transcription.ts`, import the helper. Edit the import block (`:3-29`) to add `buildAttributedTranscript` to the `from './database'` list:

  ```ts
    resetStuckTranscriptions,
    buildAttributedTranscript
  } from './database'
  ```

  Then, in `transcribeRecording`, just BEFORE the `analysisPrompt` template literal that interpolates `${fullText}` (~`:539`), derive an attributed input. Replace the single line `Transcript:\n${fullText}` usage by introducing a local `analysisInput` immediately above the `const analysisPrompt = ...`:

  ```ts
  // D5 §6.6: Stage 2 summarizes a SPEAKER-LABELED transcript when structured turns
  // exist — each turn prefixed with the mapped contact name if available, else
  // "Speaker <label>". Falls back to flat full_text for Whisper/Gemini / pre-
  // migration / zero-speaker rows. The LLM call + JSON parse are unchanged.
  const analysisInput = buildAttributedTranscript(recordingId) ?? fullText
  ```

  Then change the prompt's transcript interpolation from `${fullText}` to `${analysisInput}` (the line `Transcript:\n${fullText}` ~`:553-554`):

  ```ts
  Transcript:
  ${analysisInput}
  ```

  > Leave the `detectActionables(llm, fullText, ...)` call and the vector-store `indexTranscript(fullText, ...)` call UNCHANGED — those keep operating on raw `full_text` (actionables/RAG are speaker-agnostic in v1).

- [ ] **Step 6: Add a worker-level test proving the LLM receives the attributed input.**

  Append a `transcribeManually`-driven case to `electron/main/services/__tests__/two-stage-worker.test.ts` (it already has the full Gemini-mock harness + `insertRecordingWithFile`). Add inside the top-level `describe`:

  ```ts
  it('Stage-2 input is speaker-labeled when turns + mappings exist (spec §6.6 / AC5)', async () => {
    insertRecordingWithFile('recAttr')
    insertContact('cAttr', 'Dana') // helper added below
    // Stage 1 already wrote full_text + turns (simulate AssemblyAI output).
    shared.audioResponse = 'flat asr text'
    const turns = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'lets ship it' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'agreed' }
    ]
    // Capture exactly what the analysis (text) call receives.
    let analysisInput = ''
    shared.onTextCall = (prompt: string) => { analysisInput = prompt }
    shared.textResponses = [validAnalysisJson('Attributed')]

    // Pre-seed Stage 1 with turns + one mapping (label A -> Dana), then run Stage 2 only.
    upsertTranscriptStage1({
      recording_id: 'recAttr',
      full_text: 'lets ship it agreed',
      language: 'en',
      word_count: 4,
      transcription_provider: 'assemblyai',
      transcription_model: 'universal-3-pro'
    })
    run('UPDATE transcripts SET turns = ? WHERE recording_id = ?', [JSON.stringify(turns), 'recAttr'])
    run(
      `INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at)
       VALUES ('recAttr', 'A', 'cAttr', 'user', ?)`,
      [new Date().toISOString()]
    )

    await transcribeManually('recAttr')

    // The analysis prompt embedded the attributed transcript: Dana mapped, B generic.
    expect(analysisInput).toContain('Dana: lets ship it')
    expect(analysisInput).toContain('Speaker B: agreed')
    expect(shared.audioCalls).toBe(0) // Stage-2-only resume (full_text already present)
  })
  ```

  Add a contact helper alongside the other inline INSERT helpers (~`:197`):

  ```ts
  /** Insert a contacts row so attributed-summary mapping resolves. */
  function insertContact(id: string, name: string): void {
    run(
      `INSERT OR IGNORE INTO contacts (id, name, type, created_at) VALUES (?, ?, 'person', ?)`,
      [id, name, new Date().toISOString()]
    )
  }
  ```

  Extend the hoisted `shared` object (~`:40-62`) with the text-call spy hook:

  ```ts
    textCalls: 0,
    onTextCall: undefined as ((prompt: string) => void) | undefined,
  ```

  Reset it in `beforeEach` (~`:308`):

  ```ts
    shared.textCalls = 0
    shared.onTextCall = undefined
  ```

  And invoke it inside the Gemini text-call branch of the `generateContent` mock (~`:128`, the `else` for non-array args), right after `shared.textCalls += 1`:

  ```ts
    shared.textCalls += 1
    if (typeof arg === 'string') shared.onTextCall?.(arg)
  ```

- [ ] **Step 7: Run both suites, confirm PASS.**

  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/attributed-summary.test.ts electron/main/services/__tests__/two-stage-worker.test.ts
  ```

  Expected output (the existing two-stage cases plus the new one all green):

  ```
  ✓ electron/main/services/__tests__/attributed-summary.test.ts (3)
  ✓ electron/main/services/__tests__/two-stage-worker.test.ts (13)
  Test Files  2 passed (2)
  ```

- [ ] **Step 8: Commit.**

  ```
  git add apps/electron/electron/main/services/database.ts apps/electron/electron/main/services/transcription.ts apps/electron/electron/main/services/__tests__/attributed-summary.test.ts apps/electron/electron/main/services/__tests__/two-stage-worker.test.ts && git commit -m "feat(electron): D5 — Stage-2 summarizes speaker-attributed transcript (§6.6, AC5)

Add buildAttributedTranscript() (turns + recording_speakers -> contact names,
flat full_text fallback) and feed it to the analysis prompt; actionables/RAG
keep raw full_text.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D5-T2: Staleness signal — Stage-2 stamps `created_at`; `isSummaryStale` + IPC

**Files:**
- Modify: `electron/main/services/database.ts` — extend `updateTranscriptStage2` (~`:2325-2365`) to also stamp `created_at = CURRENT_TIMESTAMP`; add `isSummaryStale(recordingId)` helper after `buildAttributedTranscript`.
- Modify: `electron/main/ipc/recording-handlers.ts` — add `transcription:isSummaryStale` IPC near `transcription:resummarize` (~`:391-403`).
- Modify: `electron/preload/index.ts` — expose `isSummaryStale` on the recordings API (type decl ~`:169`, impl ~`:598`).
- Test: `electron/main/services/__tests__/summary-staleness.test.ts` (new).

> §6.6: "once speakers are mapped but the summary predates the mapping, show a badge … that clears on successful resummarize." Concretely: `isSummaryStale` = a mapping exists AND `MAX(recording_speakers.created_at) > transcripts.created_at`. The Stage-2 write now stamps `created_at`, so a resummarize after mapping pushes the stamp past the mapping rows → not stale.

- [ ] **Step 1: Write the failing test for `isSummaryStale`.**

  Create `electron/main/services/__tests__/summary-staleness.test.ts`:

  ```ts
  // @vitest-environment node
  import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
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
    const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-stale-'))
    const dataDir = _path.join(tmpDir, 'data')
    _fs.mkdirSync(dataDir, { recursive: true })
    return { tmpDir, dataDir, dbPath: _path.join(dataDir, 'hidock.db') }
  })

  vi.mock('electron', () => ({
    app: { getPath: vi.fn(() => os.tmpdir()), getName: vi.fn(() => 'test') },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
    Notification: { isSupported: vi.fn(() => false) }
  }))
  vi.mock('../file-storage', () => ({
    getDatabasePath: vi.fn(() => shared.dbPath),
    getRecordingsPath: vi.fn(() => shared.dataDir),
    getCachePath: vi.fn(() => os.tmpdir())
  }))

  import {
    initializeDatabase,
    closeDatabase,
    run,
    upsertTranscriptStage1,
    updateTranscriptStage2,
    isSummaryStale
  } from '../database'

  function insertRecording(id: string): void {
    run(
      `INSERT OR IGNORE INTO recordings
         (id, filename, file_path, date_recorded, status, transcription_status,
          location, on_device, on_local, created_at)
       VALUES (?, ?, ?, ?, 'complete', 'complete', 'local-only', 0, 1, ?)`,
      [id, `${id}.hda`, `/tmp/${id}.hda`, new Date().toISOString(), new Date().toISOString()]
    )
  }
  function seedStage1And2(id: string): void {
    upsertTranscriptStage1({
      recording_id: id,
      full_text: 'text',
      language: 'en',
      word_count: 1,
      transcription_provider: 'assemblyai',
      transcription_model: 'universal-3-pro'
    })
    updateTranscriptStage2(id, { summary: 'S', summarization_provider: 'ollama-cloud', summarization_model: 'm' })
  }
  /** Force a recording_speakers row's created_at to a fixed ISO instant. */
  function mapSpeakerAt(id: string, label: string, createdAt: string): void {
    run(
      `INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at)
       VALUES (?, ?, NULL, 'user', ?)
       ON CONFLICT(recording_id, file_label) DO UPDATE SET created_at = excluded.created_at`,
      [id, label, createdAt]
    )
  }
  /** Force the transcript's summary stamp to a fixed ISO instant. */
  function stampSummaryAt(id: string, createdAt: string): void {
    run('UPDATE transcripts SET created_at = ? WHERE recording_id = ?', [createdAt, id])
  }

  describe('isSummaryStale (spec §6.6 / AC5)', () => {
    beforeEach(async () => {
      if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
      await initializeDatabase()
    })
    afterEach(() => { try { closeDatabase() } catch { /* ignore */ } })

    it('false when no speakers are mapped (generic summary, nothing to attribute)', async () => {
      insertRecording('s1')
      seedStage1And2('s1')
      stampSummaryAt('s1', '2026-06-17T10:00:00.000Z')
      expect(isSummaryStale('s1')).toBe(false)
    })

    it('true when a mapping is NEWER than the summary stamp', async () => {
      insertRecording('s2')
      seedStage1And2('s2')
      stampSummaryAt('s2', '2026-06-17T10:00:00.000Z')
      mapSpeakerAt('s2', 'A', '2026-06-17T11:00:00.000Z') // mapped AFTER summarizing
      expect(isSummaryStale('s2')).toBe(true)
    })

    it('false when the summary stamp is NEWER than every mapping (re-summarized after mapping)', async () => {
      insertRecording('s3')
      seedStage1And2('s3')
      mapSpeakerAt('s3', 'A', '2026-06-17T10:00:00.000Z')
      stampSummaryAt('s3', '2026-06-17T12:00:00.000Z') // re-summarized after mapping
      expect(isSummaryStale('s3')).toBe(false)
    })

    it('false when there is no transcript row', async () => {
      expect(isSummaryStale('does-not-exist')).toBe(false)
    })
  })

  afterAll(() => {
    try { fs.rmSync(shared.tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })
  ```

- [ ] **Step 2: Run the test, confirm it FAILS (`isSummaryStale` not exported).**

  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/summary-staleness.test.ts
  ```

  Expected:

  ```
  FAIL  electron/main/services/__tests__/summary-staleness.test.ts
   → isSummaryStale is not a function
  Test Files  1 failed (1)
  ```

- [ ] **Step 3: Stamp `created_at` in the Stage-2 write.**

  In `database.ts`, edit `updateTranscriptStage2` (~`:2345-2364`). Add `created_at = CURRENT_TIMESTAMP` to the SET clause (this is the "last processed / summarized" stamp the staleness check keys on):

  ```ts
    run(
      `UPDATE transcripts SET
         summary = ?, action_items = ?, topics = ?, key_points = ?,
         title_suggestion = ?, question_suggestions = ?,
         language = COALESCE(language, ?),
         summarization_provider = ?, summarization_model = ?,
         created_at = CURRENT_TIMESTAMP
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
  ```

- [ ] **Step 4: Add the `isSummaryStale` helper.**

  In `database.ts`, AFTER `buildAttributedTranscript` (D5-T1):

  ```ts
  /** D5 §6.6: the Stage-2 summary is "stale" iff at least one speaker mapping
   *  exists whose created_at is strictly NEWER than the transcript's summary stamp
   *  (transcripts.created_at, re-stamped by updateTranscriptStage2). Used to drive
   *  the "Summary uses generic speaker labels — re-summarize to attribute names"
   *  badge; clears once a resummarize moves the stamp past every mapping. Returns
   *  false when no transcript row exists or no mappings exist. Both timestamps are
   *  ISO/space-format TEXT and lexically comparable in SQLite. */
  export function isSummaryStale(recordingId: string): boolean {
    const row = queryOne<{ stale: number }>(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM recording_speakers rs
         JOIN transcripts t ON t.recording_id = rs.recording_id
         WHERE rs.recording_id = ? AND rs.created_at > t.created_at
       ) THEN 1 ELSE 0 END AS stale`,
      [recordingId]
    )
    return row?.stale === 1
  }
  ```

  > **Note on timestamp formats:** `updateTranscriptStage2` writes `CURRENT_TIMESTAMP` (SQLite space-format, UTC, `YYYY-MM-DD HH:MM:SS`) while `recording_speakers.created_at` is written by `speakers:assign` as `new Date().toISOString()` (`YYYY-MM-DDTHH:MM:SS.sssZ`). The `T`/space and `Z`/`.sss` differences make a raw lexical `>` unreliable across formats. The test forces both to ISO via `stampSummaryAt`; in production, normalize by having `speakers:assign` (D4) and the Stage-2 stamp use the SAME format. **Resolve at implementation time:** make `isSummaryStale` compare via `strftime('%Y-%m-%dT%H:%M:%fZ', rs.created_at) > strftime('%Y-%m-%dT%H:%M:%fZ', t.created_at)` to normalize both, OR stamp Stage 2 with `datetime('now')` and assert format parity in the test. See Open Question 1.

- [ ] **Step 5: Run the test, confirm it PASSES.**

  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/summary-staleness.test.ts
  ```

  Expected:

  ```
  ✓ electron/main/services/__tests__/summary-staleness.test.ts (4)
  Test Files  1 passed (1)
  Tests  4 passed (4)
  ```

- [ ] **Step 6: Add the `transcription:isSummaryStale` IPC + preload bridge.**

  In `electron/main/ipc/recording-handlers.ts`, import `isSummaryStale` (add to the existing `from '../services/database'` import block) and register the handler immediately after `transcription:resummarize` (~`:403`):

  ```ts
  // D5 §6.6: staleness probe for the "generic speaker labels" badge — true once
  // a mapping post-dates the summary, false after a names-attributing resummarize.
  ipcMain.handle('transcription:isSummaryStale', async (_, recordingId: unknown): Promise<boolean> => {
    try {
      const result = TranscribeRecordingSchema.safeParse({ recordingId })
      if (!result.success) return false
      return isSummaryStale(result.data.recordingId)
    } catch (error) {
      console.error('transcription:isSummaryStale error:', error)
      return false
    }
  })
  ```

  In `electron/preload/index.ts`, add the type decl right after `resummarize` (~`:169`):

  ```ts
    resummarize: (recordingId: string) => Promise<{ success: boolean; error?: string }>
    isSummaryStale: (recordingId: string) => Promise<boolean>
  ```

  And the implementation right after the `resummarize` impl (~`:598`):

  ```ts
    resummarize: (recordingId) => callIPC('transcription:resummarize', recordingId),
    isSummaryStale: (recordingId) => callIPC('transcription:isSummaryStale', recordingId),
  ```

- [ ] **Step 7: Run typecheck + the staleness suite to confirm wiring compiles.**

  ```
  cd apps/electron && npm run typecheck && npx vitest run electron/main/services/__tests__/summary-staleness.test.ts
  ```

  Expected: typecheck exits 0, then:

  ```
  ✓ electron/main/services/__tests__/summary-staleness.test.ts (4)
  Test Files  1 passed (1)
  ```

- [ ] **Step 8: Commit.**

  ```
  git add apps/electron/electron/main/services/database.ts apps/electron/electron/main/ipc/recording-handlers.ts apps/electron/electron/preload/index.ts apps/electron/electron/main/services/__tests__/summary-staleness.test.ts && git commit -m "feat(electron): D5 — summary-staleness signal + IPC (§6.6, AC5)

Stage-2 write stamps transcripts.created_at; isSummaryStale() returns true when a
recording_speakers mapping post-dates the summary stamp. Expose
transcription:isSummaryStale IPC + preload bridge.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D5-T3: Staleness badge in `SourceReader` + clears after resummarize

**Files:**
- Modify: `src/features/library/components/SourceReader.tsx` — add a staleness badge above the transcript content (~`:535-549`, beside the existing "Summary failed" banner); fetch staleness via `window.electronAPI.recordings.isSummaryStale`; re-check on `recording.id` / `transcript` change.
- Test: `src/features/library/components/__tests__/SourceReader.staleness.test.tsx` (new).

> The badge text (§6.6): "Summary uses generic speaker labels — re-summarize to attribute names." It renders only when `isSummaryStale` resolves true and offers the existing `onResummarize` action. It must DISAPPEAR after a resummarize (the parent refreshes `transcript`, the effect re-runs, the probe returns false).

- [ ] **Step 1: Write the failing renderer test.**

  Create `src/features/library/components/__tests__/SourceReader.staleness.test.tsx` (mirror `SourceReader.metadata.test.tsx` mocking style):

  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest'
  import { render, screen, waitFor } from '@testing-library/react'
  import { SourceReader } from '../SourceReader'
  import type { UnifiedRecording } from '@/types/unified-recording'
  import type { Transcript } from '@/types'

  vi.mock('@radix-ui/react-portal', () => ({
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }))
  vi.mock('@/components/ui/toaster', () => ({
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  }))
  // AudioPlayer pulls in IPC/media APIs — stub it out.
  vi.mock('@/components/AudioPlayer', () => ({ AudioPlayer: () => <div data-testid="audio-player" /> }))

  const isSummaryStale = vi.fn()
  beforeEach(() => {
    isSummaryStale.mockReset()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      recordings: { isSummaryStale }
    }
  })

  const recording = {
    id: 'rec-1',
    filename: 'rec-1.hda',
    title: 'Standup',
    location: 'local-only',
    localPath: 'C:/recordings/rec-1.hda',
    transcriptionStatus: 'complete',
    dateRecorded: new Date('2026-06-17T09:00:00Z'),
    size: 1024,
    duration: 60
  } as unknown as UnifiedRecording

  const transcript = {
    id: 't1',
    recording_id: 'rec-1',
    full_text: 'hello world',
    language: 'en',
    summary: 'A short summary.',
    action_items: null,
    topics: null,
    key_points: null,
    sentiment: null,
    speakers: null,
    word_count: 2,
    transcription_provider: 'assemblyai',
    transcription_model: 'universal-3-pro',
    title_suggestion: 'Standup',
    question_suggestions: null,
    created_at: '2026-06-17T10:00:00Z'
  } as Transcript

  const STALE_MSG = /generic speaker labels/i

  describe('SourceReader staleness badge (spec §6.6 / AC5)', () => {
    it('renders the staleness badge when isSummaryStale resolves true', async () => {
      isSummaryStale.mockResolvedValue(true)
      render(<SourceReader recording={recording} transcript={transcript} onResummarize={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(STALE_MSG)).toBeInTheDocument())
      expect(isSummaryStale).toHaveBeenCalledWith('rec-1')
    })

    it('does NOT render the badge when isSummaryStale resolves false', async () => {
      isSummaryStale.mockResolvedValue(false)
      render(<SourceReader recording={recording} transcript={transcript} onResummarize={vi.fn()} />)
      await waitFor(() => expect(isSummaryStale).toHaveBeenCalled())
      expect(screen.queryByText(STALE_MSG)).not.toBeInTheDocument()
    })

    it('does NOT probe staleness when there is no transcript', async () => {
      render(<SourceReader recording={recording} transcript={undefined} onResummarize={vi.fn()} />)
      await waitFor(() => {}, { timeout: 50 })
      expect(isSummaryStale).not.toHaveBeenCalled()
    })
  })
  ```

- [ ] **Step 2: Run the test, confirm it FAILS (no badge yet).**

  ```
  cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReader.staleness.test.tsx
  ```

  Expected:

  ```
  FAIL  src/features/library/components/__tests__/SourceReader.staleness.test.tsx
   × renders the staleness badge when isSummaryStale resolves true
     → Unable to find an element with the text: /generic speaker labels/i
   × does NOT probe staleness when there is no transcript  (isSummaryStale defined but never called -> passes) 
  Test Files  1 failed (1)
  ```

- [ ] **Step 3: Add the staleness state + effect + badge to `SourceReader`.**

  In `src/features/library/components/SourceReader.tsx`, add state after the existing transcription-warning state (~`:96`):

  ```ts
    // D5 §6.6: "summary uses generic speaker labels" staleness badge.
    const [summaryStale, setSummaryStale] = useState(false)
  ```

  Add an effect after the existing reset-on-recording-change effect (~`:100`):

  ```ts
    // D5 §6.6: probe staleness whenever the recording or transcript changes. The
    // badge appears once a speaker mapping post-dates the summary and clears after
    // a successful resummarize (parent refreshes `transcript`, this re-runs).
    useEffect(() => {
      let cancelled = false
      if (!recording || !transcript?.full_text) {
        setSummaryStale(false)
        return
      }
      window.electronAPI.recordings
        .isSummaryStale(recording.id)
        .then((stale) => { if (!cancelled) setSummaryStale(stale) })
        .catch(() => { if (!cancelled) setSummaryStale(false) })
      return () => { cancelled = true }
    }, [recording, transcript])
  ```

  Render the badge inside the `transcript ? (...)` block, immediately BEFORE the existing `recording.transcriptionStatus === 'error'` banner (~`:538-539`):

  ```tsx
            {summaryStale && (
              <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm">
                <AlertCircle className="h-4 w-4 text-amber-600" />
                <span>Summary uses generic speaker labels — re-summarize to attribute names.</span>
                {onResummarize && (
                  <Button variant="link" size="sm" className="h-auto p-0" onClick={onResummarize}>
                    Re-summarize
                  </Button>
                )}
              </div>
            )}
  ```

  > `AlertCircle` and `Button` are already imported (`:17-18`). No new imports.

- [ ] **Step 4: Run the test, confirm it PASSES.**

  ```
  cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReader.staleness.test.tsx
  ```

  Expected:

  ```
  ✓ src/features/library/components/__tests__/SourceReader.staleness.test.tsx (3)
  Test Files  1 passed (1)
  Tests  3 passed (3)
  ```

- [ ] **Step 5: Commit.**

  ```
  git add apps/electron/src/features/library/components/SourceReader.tsx apps/electron/src/features/library/components/__tests__/SourceReader.staleness.test.tsx && git commit -m "feat(electron): D5 — staleness badge in SourceReader (§6.6, AC5)

Probe transcription:isSummaryStale on recording/transcript change; show the
'generic speaker labels' badge with a Re-summarize action; hide when fresh or no
transcript.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D5-T4: Re-transcribe drops prior `recording_speakers` (server semantics, §6.8 / AC6)

**Files:**
- Modify: `electron/main/services/transcription.ts` — in `transcribeRecording`, in the Stage-1 (non-`stage2Only`) branch, DELETE prior `recording_speakers` rows for the recording before the ASR write (§6.3 / §6.8: re-transcribe may reassign labels, so mappings are dropped and re-mapped).
- Modify: `electron/main/services/database.ts` — add `deleteRecordingSpeakers(recordingId)` helper.
- Test: extend `electron/main/services/__tests__/two-stage-worker.test.ts` (new case).

> §6.8: "prior `recording_speakers` rows for the recording are dropped" on a re-transcribe. The trigger is a Stage-1 run (new ASR), NOT a Stage-2-only resume/resummarize — a resummarize must keep mappings (otherwise the staleness badge logic + attributed summaries break). So the delete lives in the Stage-1 branch only. AC3 (no orphaned rows) and AC6 (confirm re-runs + drops mappings) both rely on this.

- [ ] **Step 1: Write the failing test.**

  Add to `electron/main/services/__tests__/two-stage-worker.test.ts` inside the top-level `describe`:

  ```ts
  it('re-transcribe (Stage-1 run) DROPS prior recording_speakers; resummarize (Stage-2-only) KEEPS them (spec §6.8 / AC3/AC6)', async () => {
    const filePath = insertRecordingWithFile('recRT')
    // First full run produces a transcript; then the user maps a speaker.
    shared.audioResponse = 'FIRST PASS TEXT'
    shared.textResponses = [validAnalysisJson('First')]
    await transcribeManually('recRT')
    run(
      `INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at)
       VALUES ('recRT', 'A', NULL, 'user', ?)`,
      [new Date().toISOString()]
    )
    expect(queryAll("SELECT 1 FROM recording_speakers WHERE recording_id='recRT'").length).toBe(1)

    // --- Resummarize (Stage-2-only): clear marker, re-run. Mappings MUST survive. ---
    run("UPDATE transcripts SET summarization_provider=NULL WHERE recording_id='recRT'")
    shared.textResponses = [validAnalysisJson('Second')]
    await transcribeManually('recRT')
    expect(queryAll("SELECT 1 FROM recording_speakers WHERE recording_id='recRT'").length)
      .toBe(1) // resummarize keeps mappings

    // --- Re-transcribe (Stage-1 run): force a fresh ASR by clearing full_text so
    //     the worker takes the Stage-1 branch. Prior mappings MUST be dropped. ---
    run("UPDATE transcripts SET full_text='', summarization_provider=NULL WHERE recording_id='recRT'")
    fs.writeFileSync(filePath, Buffer.from('fresh-audio')) // ensure file exists for Stage 1
    shared.audioResponse = 'RE-TRANSCRIBED TEXT'
    shared.textResponses = [validAnalysisJson('Third')]
    await transcribeManually('recRT')

    expect(queryAll("SELECT 1 FROM recording_speakers WHERE recording_id='recRT'").length)
      .toBe(0) // re-transcribe dropped prior mappings — no orphans
    expect(getTranscriptByRecordingId('recRT')!.full_text).toBe('RE-TRANSCRIBED TEXT')
  })
  ```

  > The worker's resume rule keys on `existing?.full_text` being truthy → Stage-2-only. Setting `full_text=''` (falsy) + marker NULL forces the Stage-1 branch, which is exactly the re-transcribe path the `recordings:transcribe` IPC drives after overwrite.

- [ ] **Step 2: Run the test, confirm it FAILS (mappings not dropped).**

  ```
  cd apps/electron && npx vitest run -t "re-transcribe (Stage-1 run) DROPS prior" electron/main/services/__tests__/two-stage-worker.test.ts
  ```

  Expected:

  ```
  FAIL  electron/main/services/__tests__/two-stage-worker.test.ts
   × re-transcribe (Stage-1 run) DROPS prior recording_speakers ...
     → expected 1 to be 0  // mappings still present after re-transcribe
  ```

- [ ] **Step 3: Add `deleteRecordingSpeakers` to `database.ts`.**

  After `getRecordingSpeakers` (D5-T1):

  ```ts
  /** D5 §6.8: drop ALL speaker mappings for a recording. Called when a NEW ASR
   *  pass runs (re-transcribe) because AssemblyAI may assign different generic
   *  labels — prior label->contact maps no longer apply and must be re-made.
   *  Voiceprints are per-contact (not recording-scoped) and are untouched. */
  export function deleteRecordingSpeakers(recordingId: string): void {
    run('DELETE FROM recording_speakers WHERE recording_id = ?', [recordingId])
  }
  ```

- [ ] **Step 4: Call it in the worker's Stage-1 branch.**

  In `transcription.ts`, add `deleteRecordingSpeakers` to the `from './database'` import. Then, inside the `else` (Stage-1) branch of `transcribeRecording`, immediately after `progressCallback?.('reading_file', 5)` (~`:463`) and before the meeting-context build:

  ```ts
      // D5 §6.8: a NEW ASR pass may re-letter speakers (AssemblyAI labels are
      // per-job), so prior label->contact mappings no longer apply. Drop them
      // here — at the START of Stage 1 — so AC3 holds (no orphaned rows) even if
      // the ASR call later fails. Stage-2-only resumes/resummarize never reach
      // this branch, so their mappings survive. Voiceprints are per-contact and
      // are NOT dropped.
      deleteRecordingSpeakers(recordingId)
  ```

- [ ] **Step 5: Run the test, confirm it PASSES (and the full suite stays green).**

  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/two-stage-worker.test.ts
  ```

  Expected (the new case + all prior cases green):

  ```
  ✓ electron/main/services/__tests__/two-stage-worker.test.ts (14)
  Test Files  1 passed (1)
  ```

- [ ] **Step 6: Commit.**

  ```
  git add apps/electron/electron/main/services/database.ts apps/electron/electron/main/services/transcription.ts apps/electron/electron/main/services/__tests__/two-stage-worker.test.ts && git commit -m "feat(electron): D5 — re-transcribe drops prior speaker mappings (§6.8, AC3/AC6)

deleteRecordingSpeakers() runs at Stage-1 start so a new ASR pass clears stale
label->contact maps (no orphans); Stage-2-only resumes keep them.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D5-T5: Re-transcribe confirmation dialog in the renderer (§6.8 / AC6)

**Files:**
- Modify: `src/features/library/components/SourceReader.tsx` — add a "Re-transcribe" affordance for already-transcribed recordings that opens a `ConfirmDialog`; on confirm, call `onTranscribe` (which the parent routes to `recordings:transcribe`); on cancel, do nothing.
- Test: `src/features/library/components/__tests__/SourceReader.retranscribe.test.tsx` (new).

> §6.8: before invoking `recordings:transcribe` on an already-transcribed recording, show "Re-transcribe with speaker detection? This replaces the current transcript and its speaker mappings." Confirm → `onTranscribe()`; cancel → nothing. `SourceReader` already imports `ConfirmDialog` (`:25`) and owns `onTranscribe`. AC6's "cancel does nothing" is asserted directly.

- [ ] **Step 1: Write the failing renderer test.**

  Create `src/features/library/components/__tests__/SourceReader.retranscribe.test.tsx` (mirror the `ConfirmDialog` stub from `SourceReader.metadata.test.tsx`):

  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest'
  import { render, screen, fireEvent, waitFor } from '@testing-library/react'
  import { SourceReader } from '../SourceReader'
  import type { UnifiedRecording } from '@/types/unified-recording'
  import type { Transcript } from '@/types'

  vi.mock('@radix-ui/react-portal', () => ({
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }))
  vi.mock('@/components/ui/toaster', () => ({
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  }))
  vi.mock('@/components/AudioPlayer', () => ({ AudioPlayer: () => <div data-testid="audio-player" /> }))

  // Controllable ConfirmDialog stub: exposes Confirm / Cancel buttons when open.
  vi.mock('@/components/ConfirmDialog', () => ({
    ConfirmDialog: ({
      open, onConfirm, onOpenChange, title
    }: { open: boolean; onConfirm: () => void; onOpenChange: (o: boolean) => void; title: string }) => {
      if (!open) return null
      return (
        <div data-testid="confirm-dialog">
          <p>{title}</p>
          <button onClick={() => { onConfirm(); onOpenChange(false) }}>Confirm Action</button>
          <button onClick={() => onOpenChange(false)}>Cancel Action</button>
        </div>
      )
    },
  }))

  const isSummaryStale = vi.fn().mockResolvedValue(false)
  beforeEach(() => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      recordings: { isSummaryStale }
    }
  })

  const recording = {
    id: 'rec-1', filename: 'rec-1.hda', title: 'Standup', location: 'local-only',
    localPath: 'C:/recordings/rec-1.hda', transcriptionStatus: 'complete',
    dateRecorded: new Date('2026-06-17T09:00:00Z'), size: 1024, duration: 60
  } as unknown as UnifiedRecording

  const transcript = {
    id: 't1', recording_id: 'rec-1', full_text: 'hello world', language: 'en',
    summary: 'S', action_items: null, topics: null, key_points: null, sentiment: null,
    speakers: null, word_count: 2, transcription_provider: 'assemblyai',
    transcription_model: 'universal-3-pro', title_suggestion: 'Standup',
    question_suggestions: null, created_at: '2026-06-17T10:00:00Z'
  } as Transcript

  describe('SourceReader re-transcribe confirmation (spec §6.8 / AC6)', () => {
    it('shows the confirmation dialog and calls onTranscribe ONLY on confirm', async () => {
      const onTranscribe = vi.fn()
      render(<SourceReader recording={recording} transcript={transcript} onTranscribe={onTranscribe} onResummarize={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: /re-transcribe/i }))
      expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument()
      expect(screen.getByText(/replaces the current transcript and its speaker mappings/i)).toBeInTheDocument()
      expect(onTranscribe).not.toHaveBeenCalled() // not yet — just opened

      fireEvent.click(screen.getByRole('button', { name: /confirm action/i }))
      expect(onTranscribe).toHaveBeenCalledTimes(1)
    })

    it('cancel does nothing (onTranscribe not called)', async () => {
      const onTranscribe = vi.fn()
      render(<SourceReader recording={recording} transcript={transcript} onTranscribe={onTranscribe} onResummarize={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: /re-transcribe/i }))
      await screen.findByTestId('confirm-dialog')
      fireEvent.click(screen.getByRole('button', { name: /cancel action/i }))

      await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument())
      expect(onTranscribe).not.toHaveBeenCalled()
    })
  })
  ```

- [ ] **Step 2: Run the test, confirm it FAILS (no Re-transcribe button).**

  ```
  cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReader.retranscribe.test.tsx
  ```

  Expected:

  ```
  FAIL  src/features/library/components/__tests__/SourceReader.retranscribe.test.tsx
   × shows the confirmation dialog and calls onTranscribe ONLY on confirm
     → Unable to find an accessible element with the role "button" and name /re-transcribe/i
  ```

- [ ] **Step 3: Add re-transcribe confirm state + button + dialog to `SourceReader`.**

  Add state after `summaryStale` (D5-T3, ~`:97`):

  ```ts
    // D5 §6.8: re-transcribe confirmation for an already-transcribed recording.
    const [showRetranscribeConfirm, setShowRetranscribeConfirm] = useState(false)
  ```

  Add a "Re-transcribe" button in the action-button row, immediately AFTER the "Re-summarize" button block (~`:502`). It is shown only when the recording already has a transcript and `onTranscribe` is wired:

  ```tsx
        {/* D5 §6.8: Re-transcribe (re-runs ASR with speaker detection) — only for
            an already-transcribed recording; gated behind a confirm dialog. */}
        {transcript?.full_text && onTranscribe && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRetranscribeConfirm(true)}
            disabled={recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'}
            className="gap-2"
            title="Re-run transcription with speaker detection (replaces the current transcript)"
          >
            <Wand2 className="h-4 w-4" />
            Re-transcribe
          </Button>
        )}
  ```

  Add the dialog at the END of the component's returned JSX, just before the closing tag of the root element (place it alongside the existing `RecordingLinkDialog`/`ConfirmDialog` usages — search for the existing `<ConfirmDialog` for the transcription-overwrite warning and add this sibling after it):

  ```tsx
        {/* D5 §6.8 / AC6: confirm before re-transcribing — replaces transcript +
            drops speaker mappings (server-side, D5-T4). */}
        <ConfirmDialog
          open={showRetranscribeConfirm}
          onOpenChange={setShowRetranscribeConfirm}
          title="Re-transcribe with speaker detection?"
          description="This replaces the current transcript and its speaker mappings."
          actionLabel="Re-transcribe"
          variant="destructive"
          onConfirm={() => {
            setShowRetranscribeConfirm(false)
            onTranscribe?.()
          }}
        />
  ```

  > `useState`, `Button`, `Wand2`, and `ConfirmDialog` are all already imported. The parent (`Library.tsx`) already routes `onTranscribe` → `queueTranscription` → `recordings:transcribe`; D5-T4 makes that path drop prior mappings server-side. No parent change needed for the confirm itself.

- [ ] **Step 4: Run the test, confirm it PASSES.**

  ```
  cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReader.retranscribe.test.tsx
  ```

  Expected:

  ```
  ✓ src/features/library/components/__tests__/SourceReader.retranscribe.test.tsx (2)
  Test Files  1 passed (1)
  Tests  2 passed (2)
  ```

- [ ] **Step 5: Run the full D5 renderer + the SourceReader metadata regression to confirm no double-dialog clash.**

  ```
  cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReader.staleness.test.tsx src/features/library/components/__tests__/SourceReader.retranscribe.test.tsx src/features/library/components/__tests__/SourceReader.metadata.test.tsx
  ```

  Expected: all three suites green (the new buttons/dialogs do not collide with the existing transcription-overwrite warning).

  ```
  Test Files  3 passed (3)
  ```

- [ ] **Step 6: Commit.**

  ```
  git add apps/electron/src/features/library/components/SourceReader.tsx apps/electron/src/features/library/components/__tests__/SourceReader.retranscribe.test.tsx && git commit -m "feat(electron): D5 — re-transcribe confirmation dialog (§6.8, AC6)

Add a Re-transcribe action for already-transcribed recordings, gated by a
ConfirmDialog ('replaces the current transcript and its speaker mappings');
confirm -> onTranscribe (recordings:transcribe), cancel -> no-op.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task D5-T6: Update the drawer "Transcribed" label + relabel `created_at` semantics; full gate

**Files:**
- Modify: `src/features/library/components/SourceDetailDrawer.tsx` — relabel the "Transcribed" Details field (~`:439-442`) to "Last processed" (the `created_at` stamp now moves on resummarize). Minor copy-only change to avoid a misleading "Transcribed" date.
- Test: covered by the existing suite; run the full gate.

> This is a one-line copy correction that documents the new `created_at` semantics from D5-T2 (it now reflects the last summarize, not the original transcription). No behavior change.

- [ ] **Step 1: Relabel the Details field in `SourceDetailDrawer.tsx`.**

  Edit (~`:439-442`):

  ```tsx
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Last processed</dt>
                  <dd className="mt-1">{formatDateTime(transcript.created_at)}</dd>
                </div>
  ```

- [ ] **Step 2: Run typecheck + lint.**

  ```
  cd apps/electron && npm run typecheck && npm run lint
  ```

  Expected: both exit 0 with no errors.

- [ ] **Step 3: Run the full D5 test set + the touched regressions in one pass.**

  ```
  cd apps/electron && npx vitest run electron/main/services/__tests__/attributed-summary.test.ts electron/main/services/__tests__/summary-staleness.test.ts electron/main/services/__tests__/two-stage-worker.test.ts src/features/library/components/__tests__/SourceReader.staleness.test.tsx src/features/library/components/__tests__/SourceReader.retranscribe.test.tsx
  ```

  Expected:

  ```
  Test Files  5 passed (5)
  ```

- [ ] **Step 4: Run the complete Electron quality gate (CLAUDE.md).**

  ```
  cd apps/electron && npm run typecheck && npm run lint && npm run test:run
  ```

  Expected: typecheck 0, lint 0, and the full Vitest suite passes (no regressions in `two-stage-worker`, `SourceReader.metadata`, `Library`, `e2e-smoke`).

- [ ] **Step 5: Commit.**

  ```
  git add apps/electron/src/features/library/components/SourceDetailDrawer.tsx && git commit -m "chore(electron): D5 — relabel transcript 'Transcribed' -> 'Last processed' (§6.6)

created_at now re-stamps on each (re)summarize (D5-T2), so the drawer label
reflects last processing, not original transcription.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Phase D5 verification checklist (maps to ACs)

- **AC5 (attributed input + badge + resummarize doesn't re-ASR):** D5-T1 proves the Stage-2 LLM receives the attributed transcript (`Dana: …` / `Speaker B: …`) on a Stage-2-only resume (`audioCalls === 0`, reusing the existing resummarize regression at `two-stage-worker.test.ts:596` which already asserts `audioCalls === 0` for resummarize). D5-T2/T3 prove the badge appears once a mapping post-dates the summary and clears after resummarize.
- **AC6 (re-transcribe confirm + replace + drop mappings; cancel no-op):** D5-T5 proves the dialog gates `onTranscribe`; cancel calls nothing. D5-T4 proves the Stage-1 ASR pass drops prior `recording_speakers` (and resummarize keeps them).
- **AC3 (no orphaned `recording_speakers`):** D5-T4's re-transcribe-drops case asserts zero rows after a new ASR pass.
- **§10(c) regression (resummarize reuses persisted full_text/turns, does NOT call AssemblyAI):** satisfied structurally — `buildAttributedTranscript` reads persisted `turns`; the Stage-2-only resume never calls `getAsrProvider` (existing worker control flow), so AssemblyAI is never hit on resummarize.