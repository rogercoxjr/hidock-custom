# Auto-Pipeline P3 — Ollama Cloud Summarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase P3 of `docs/superpowers/specs/2026-06-11-auto-pipeline-model-choice-design.md` (§12; sections §5.2, §5.6 → AC6): the `ollama-cloud` summarization provider (direct `ollama.com` API key, model of the user's choice), the `config.summarization` section, the meeting-selection validator, the Summarization Settings card with live model picker, and `transcription:resummarize` with its detail-panel button (healthy + failed states).

**Architecture:** All in `apps/electron`. **Depends on P2** (provider-errors.ts, validateConfig IPC, crypto both-sites pattern). New: `llm/ollama-cloud-llm.ts`, `summarization:listModels`/`summarization:testConnection` IPC, Re-summarize UI. Modified: `config.ts` (+`summarization` section), the two duplicated renderer `AppConfig` types, `llm-provider.ts` (**delete the structural cast** — P1 carry-note), `transcription.ts` (validator + derived summarization provider/model), `database.ts` (`clearTranscriptStage2Marker`; **delete orphaned `insertTranscript`** — P1 carry-note), `recording-handlers.ts`/`preload`, `SourceReader.tsx`/`Library.tsx`, `Settings.tsx`.

**Tech Stack:** Node 22 global `fetch`, Ollama Cloud REST (`https://ollama.com/api/chat`, `/api/tags`, Bearer auth), sql.js, Vitest.

---

## Environment / invariants

Same as P2's (work from `apps/electron`; explicit RCs; `@vitest-environment node` for main tests; house real-DB fixture; EOL parity; commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; spec is authoritative). ⛔ USB: untouched. Branch: `auto-pipeline-p3` off `main` (after P2 merges).

## File structure

| File | Responsibility |
|---|---|
| `electron/main/services/llm/ollama-cloud-llm.ts` (create) | Ollama Cloud chat provider (Bearer, `format:'json'`, 5-min timeout, 404/429/401 typed) |
| `electron/main/services/config.ts` (modify) | `summarization` section + `ollamaCloudApiKey` crypto both-sites |
| `src/types/index.ts` + `src/types/stores.ts` (modify) | mirror the new section (both, byte-identical) |
| `electron/main/services/llm/llm-provider.ts` (modify) | `'ollama-cloud'` case; **delete the `(config as {...})` cast** (AppConfig now has the field) |
| `electron/main/services/transcription.ts` (modify) | meeting-selection validator; `summarization_provider/_model` derived from config; +2 NON_RETRYABLE strings |
| `electron/main/services/database.ts` (modify) | `clearTranscriptStage2Marker`; **remove `insertTranscript`** (orphan) |
| `electron/main/ipc/recording-handlers.ts` (modify) | `transcription:resummarize`; extend `transcription:validateConfig` for ollama-cloud |
| `electron/main/ipc/summarization-handlers.ts` (create) | `summarization:listModels` + `summarization:testConnection` (main-process fetch — renderer can't call cross-origin) |
| `electron/preload/index.ts` (modify) | new bindings |
| `src/features/library/components/SourceReader.tsx` + `src/pages/Library.tsx` (modify) | Re-summarize button (healthy + error states) |
| `src/pages/Settings.tsx` (modify) | Summarization card |
| Tests | `__tests__/ollama-cloud-llm.test.ts`, `__tests__/meeting-selection-validator.test.ts` (or inside two-stage-worker), extend `two-stage-worker.test.ts` (resummarize), handler/Settings/SourceReader test updates |

---

### Task 1: Config `summarization` section + crypto + renderer mirrors + cast deletion

**Files:** `config.ts`, `src/types/index.ts`, `src/types/stores.ts`, `llm/llm-provider.ts`; extend `__tests__/config-crypto.test.ts`

- [ ] **Step 0: Branch.** `git checkout main && git checkout -b auto-pipeline-p3 && cd apps/electron`
- [ ] **Step 1: Failing tests** (extend `config-crypto.test.ts`): (a) defaults — fresh init → `getConfig().summarization` equals `{ provider: 'gemini', ollamaCloudApiKey: '', ollamaCloudModel: '' }`; (b) cold-start round-trip for `summarization.ollamaCloudApiKey` (same pattern as P2's openaiApiKey test: stored value starts `'__enc__'`, decrypts back after re-init).
- [ ] **Step 2: Implement in `config.ts`.**
  (a) AppConfig — after the `transcription` section add:
```ts
  summarization: {
    provider: 'gemini' | 'ollama-cloud'   // default 'gemini' = today's fused behavior (spec §5.4)
    ollamaCloudApiKey: string             // safeStorage-encrypted at rest
    ollamaCloudModel: string              // e.g. 'gpt-oss:120b', 'deepseek-v3.1:671b'
  }
```
  (b) DEFAULT_CONFIG — matching defaults (`'gemini'`, `''`, `''`).
  (c) Encrypt site (`saveConfig` `toWrite`): add
```ts
    summarization: {
      ...config.summarization,
      ollamaCloudApiKey: encryptSensitive(config.summarization.ollamaCloudApiKey)
    }
```
  (d) Decrypt site (`initializeConfig`): add
```ts
      if (savedConfig.summarization?.ollamaCloudApiKey) {
        savedConfig.summarization.ollamaCloudApiKey = decryptSensitive(savedConfig.summarization.ollamaCloudApiKey)
      }
```
- [ ] **Step 3: Renderer mirrors.** Add the identical `summarization` block to BOTH `src/types/index.ts` and `src/types/stores.ts` AppConfig types (they must stay byte-identical to each other).
- [ ] **Step 4: Delete the structural cast (P1 carry-note #1).** In `llm-provider.ts` the line is verbatim:
```ts
  const provider = (config as { summarization?: { provider?: string } }).summarization?.provider ?? 'gemini'
```
  Replace with:
```ts
  const provider = config.summarization?.provider ?? 'gemini'
```
  Also update its JSDoc ("config.summarization does not exist until P3" sentence → past tense). Sweep for the OTHER copy of the cast: `transcription:validateConfig` in `recording-handlers.ts` carries the same structural read (P2 left a comment marking it) — replace it identically there.
- [ ] **Step 5: Tests PASS, both typechecks RC 0, commit.** `feat(electron): config.summarization section + ollamaCloudApiKey crypto; delete the P1 structural casts (auto-pipeline P3)`

---

### Task 2: `ollama-cloud-llm.ts` provider + factory case

**Files:** create `llm/ollama-cloud-llm.ts`; modify `llm/llm-provider.ts`, `transcription.ts` (NON_RETRYABLE); create `__tests__/ollama-cloud-llm.test.ts`

- [ ] **Step 1: Failing tests** (`vi.stubGlobal('fetch', ...)`):
  1. Factory key check: provider `'ollama-cloud'` + empty key → throws EXACTLY `Ollama Cloud API key not configured — add it in Settings → Summarization` (spec §7.1 verbatim).
  2. Happy path: `generate('PROMPT', { json: true })` → POST `https://ollama.com/api/chat` with headers `Authorization: Bearer ok-x` + `Content-Type: application/json`, body `{ model: 'gpt-oss:120b', messages: [{ role: 'user', content: 'PROMPT' }], stream: false, format: 'json' }` → returns `message.content` from `{ message: { content: '{"summary":"s"}' } }`.
  3. `opts.json` falsy → body has NO `format` key.
  4. 404 → throws message EXACTLY `Ollama Cloud model 'gpt-oss:120b' not found — choose a new model in Settings → Summarization` (spec §7.1).
  5. 429 with `Retry-After: 300` → `ProviderRateLimitError('Ollama Cloud', 300000)`.
  6. 401 → `ProviderAuthError('Ollama Cloud')`.
  7. Timeout: never-resolving fetch + fake timers → aborts at 5 min (spec §7.4).
- [ ] **Step 2: Implement** (complete shape — mirror whisper-asr's structure):
```ts
import type { AppConfig } from '../config'
import type { LlmProvider } from './llm-provider'
import { ProviderRateLimitError, ProviderAuthError } from '../provider-errors'

const OLLAMA_TIMEOUT_MS = 5 * 60 * 1000 // spec §7.4
const OLLAMA_CLOUD_URL = 'https://ollama.com/api/chat'

export function createOllamaCloudLlm(config: AppConfig): LlmProvider {
  if (!config.summarization.ollamaCloudApiKey) {
    throw new Error('Ollama Cloud API key not configured — add it in Settings → Summarization') // §7.1 verbatim
  }
  const apiKey = config.summarization.ollamaCloudApiKey
  const model = config.summarization.ollamaCloudModel

  return {
    async generate(prompt: string, opts?: { json?: boolean }): Promise<string> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)
      try {
        const res = await fetch(OLLAMA_CLOUD_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            ...(opts?.json ? { format: 'json' } : {})
          }),
          signal: controller.signal
        })
        if (res.status === 404) {
          throw new Error(`Ollama Cloud model '${model}' not found — choose a new model in Settings → Summarization`)
        }
        if (res.status === 429) {
          const retryAfter = res.headers.get('Retry-After')
          throw new ProviderRateLimitError('Ollama Cloud', retryAfter ? Number(retryAfter) * 1000 : undefined)
        }
        if (res.status === 401) throw new ProviderAuthError('Ollama Cloud')
        if (!res.ok) throw new Error(`Ollama Cloud chat failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
        const json = (await res.json()) as { message?: { content?: string } }
        return json.message?.content ?? ''
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
```
- [ ] **Step 3: Factory case** in `llm-provider.ts` (between `case 'gemini'` and `default`):
```ts
    case 'ollama-cloud':
      return createOllamaCloudLlm(config)
```
  (+ import). NOTE the gemini case stays on `config.transcription.geminiModel` — that is spec §5.2's deliberate "preserves today's fused behavior" semantics (P1 carry-note #2 resolved: documented, not changed).
- [ ] **Step 4: NON_RETRYABLE strings** in `transcription.ts`: add `'Ollama Cloud API key not configured',` and `'not found — choose a new model',` to the array. (`'API key was rejected'` was added in P2 and covers ProviderAuthError for both providers.)
- [ ] **Step 5: Tests + neighbors PASS, RCs 0, commit.** `feat(electron): ollama-cloud LLM provider — Bearer chat, format:json, typed 404/429/401, 5-min timeout (auto-pipeline P3)`

---

### Task 3: Worker — meeting-selection validator + derived summarization provider/model

**Files:** `transcription.ts`; extend `two-stage-worker.test.ts`

- [ ] **Step 1a: Fix the config mocks FIRST (load-bearing).** Every existing main-process fixture mocks `'../config'` directly (bypassing config.ts's deep-merge defaults), so the moment the worker reads `config.summarization.provider` they all TypeError. Add a `summarization: { provider: 'gemini', ollamaCloudApiKey: '', ollamaCloudModel: '' }` section to the config mocks in `two-stage-worker.test.ts` (~:68-80), `transcription.test.ts`, and `e2e-smoke.test.ts` BEFORE touching the worker. Run those three suites to confirm still-green with the enriched mocks.
- [ ] **Step 1: Failing tests** (extend `two-stage-worker.test.ts`, reusing its array→audio/string→text mock routing):
  1. Analysis returns `selected_meeting_id: 'none'` with one candidate → NO `linkRecordingToMeeting`, and the vector-store indexing metadata receives the recording's ORIGINAL `meeting_id` fallback, NOT the literal `'none'` (assert via the vector-store stub's call arg).
  2. Analysis returns a hallucinated id not in the candidate set → treated as undefined (no link; candidates written with `isSelected=false`).
  3. Analysis returns `meeting_confidence: '0.9'` (string) → coerced via Number() and clamped; link proceeds (≥0.4).
  4. With `config.summarization.provider='ollama-cloud'` (+ key/model in the config mock): the transcript row gets `summarization_provider='ollama-cloud'` and `summarization_model=<ollamaCloudModel>`. **The Gemini mock cannot intercept this path** — Stage 2 now goes through `createOllamaCloudLlm` → global `fetch`. `vi.stubGlobal('fetch', ...)` returning ollama-shaped responses (`{ ok: true, json: async () => ({ message: { content: <analysis JSON string> } }) }`) for BOTH Stage-2 calls (analysis, then actionables — route on call order or prompt content). Without the stub this test hits the real network.
  5. **AC5 seam (Stage 1 persists before Stage-2 key failure):** config = gemini ASR + `summarization.provider='ollama-cloud'` with EMPTY `ollamaCloudApiKey` → run the worker → it rejects with the `Ollama Cloud API key not configured` message, AND the transcript row has `full_text` persisted with `summarization_provider` NULL (Stage-2-resumable). This is the test P4's AC5 evidence cites for "completes Stage 1 and persists full_text before terminal-failing at Stage 2".
- [ ] **Step 2: Implement the validator.** In `transcribeRecording`, immediately after the JSON extraction succeeds (after the parse at ~:515-527) and BEFORE the candidates block (:529), insert:
```ts
  // Meeting-selection validator (spec §5.2): provider-agnostic guard — smaller
  // models return 'none', hallucinated ids, or string confidences far more often
  // than Gemini. Applied BEFORE the candidates loop AND the indexing fallback.
  const candidateIds = new Set(candidateMeetings.map((m) => m.id))
  if (analysis.selected_meeting_id === 'none' || (analysis.selected_meeting_id && !candidateIds.has(analysis.selected_meeting_id))) {
    analysis.selected_meeting_id = undefined
  }
  if (analysis.meeting_confidence !== undefined) {
    const n = Number(analysis.meeting_confidence)
    analysis.meeting_confidence = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
  }
```
  This also fixes the raw-value indexing fallback (the fact: `:660-661` uses `analysis.selected_meeting_id || recording.meeting_id` unvalidated — after the validator, `'none'`/hallucinated can no longer leak into chunk metadata). The existing `!== 'none'` check inside the link block (:542) becomes redundant but harmless — leave it.
- [ ] **Step 3: Derive Stage-2 provider/model.** The Stage-2 write block is verbatim (:566-582) ending:
```ts
    summarization_provider: 'gemini', // P3 will derive this from config.summarization
    summarization_model: config.transcription.geminiModel
```
  Replace with:
```ts
    summarization_provider: config.summarization.provider,
    summarization_model:
      config.summarization.provider === 'ollama-cloud'
        ? config.summarization.ollamaCloudModel
        : config.transcription.geminiModel // gemini summarization reuses the transcription model (spec §5.2)
```
- [ ] **Step 4: Tests PASS** (new + all existing two-stage/worker/e2e suites), RCs 0. Commit: `feat(electron): meeting-selection validator + summarization provider/model derived from config (auto-pipeline P3)`

---

### Task 4: `transcription:resummarize` + `clearTranscriptStage2Marker` + orphan removal

**Files:** `database.ts`, `recording-handlers.ts`, `preload/index.ts`; extend `database-v25.test.ts`, `two-stage-worker.test.ts`, `recording-handlers.test.ts`

- [ ] **Step 1: Failing DB test** (`database-v25.test.ts`): `clearTranscriptStage2Marker(recordingId)` sets `summarization_provider`/`summarization_model` to NULL while **`summary` (and all other analysis columns) remain untouched**; throws (or no-ops — pick THROWS, consistent with `updateTranscriptStage2`'s guard) when no transcript row exists.
- [ ] **Step 2: Implement** in `database.ts` below `updateTranscriptStage2`:
```ts
/** Resummarize support (spec §5.3): clears ONLY the stage marker so the worker's
 *  resume rule re-runs Stage 2 with the currently configured LLM. The old summary
 *  is deliberately KEPT until the new one lands — a failed re-run must not lose data. */
export function clearTranscriptStage2Marker(recordingId: string): void {
  const existing = queryOne<{ id: string }>('SELECT id FROM transcripts WHERE recording_id = ?', [recordingId])
  if (!existing) {
    throw new Error(`clearTranscriptStage2Marker: no transcript row for recording ${recordingId}`)
  }
  run('UPDATE transcripts SET summarization_provider = NULL, summarization_model = NULL WHERE recording_id = ?', [recordingId])
}
```
- [ ] **Step 3: Failing worker test** (`two-stage-worker.test.ts`): full run on a recording → clear marker via the new fn → delete the audio file → run worker again with the text mock returning a NEW summary AND a NEW title_suggestion → assert: `full_text` unchanged, `summary` replaced, no duplicate pending actionables, **the knowledge-capture title was NOT re-renamed** (the auto-rename predicate: `title_suggestion` was non-NULL pre-update — AC6's "does not re-rename" clause), **and the old summary survived an intermediate failed re-run** (clear marker → make the text mock throw → worker rejects → `summary` still the OLD value, marker still NULL).
- [ ] **Step 4: IPC handler** in `recording-handlers.ts` (after `transcription:validateConfig`):
```ts
  // Re-summarize (spec §5.3/§5.6): clear the stage marker (keeping the old summary)
  // and enqueue — the worker's resume rule runs Stage 2 only, no audio file needed.
  ipcMain.handle('transcription:resummarize', async (_, recordingId: unknown): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = TranscribeRecordingSchema.safeParse({ recordingId })
      if (!result.success) throw new Error(result.error.issues[0]?.message || 'Invalid request')
      clearTranscriptStage2Marker(result.data.recordingId)
      addToQueue(result.data.recordingId)
      void processQueueManually()
      return { success: true }
    } catch (error) {
      console.error('transcription:resummarize error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })
```
  Preload: type `resummarize: (recordingId: string) => Promise<{ success: boolean; error?: string }>` in the recordings type block; impl `resummarize: (recordingId) => callIPC('transcription:resummarize', recordingId),`. Add the channel to the registry assertion in `recording-handlers.test.ts` (~:190) + a behavior test (clears marker via mock + enqueues).
- [ ] **Step 5: Orphan removal (P1 carry-note #4).** Delete `insertTranscript` from `database.ts` (it's INSERT OR REPLACE — any future caller would silently wipe the stage marker; the stage-write pair is the only sanctioned writer). Sweep callers first: `git grep -n "insertTranscript" apps/electron` — expected hits: database.ts (def), database.test.ts (tests), possibly the `Transcript` type import in transcription.ts (type-only, keep the type). Realign `database.test.ts` (replace its insertTranscript-based arrange code with `upsertTranscriptStage1` + `updateTranscriptStage2`, or raw SQL inserts — cite the carry-note in a comment). If e2e-smoke or any other test seeds transcripts via insertTranscript, realign the same way.
- [ ] **Step 6: All suites green, RCs 0, commit.** `feat(electron): transcription:resummarize + clearTranscriptStage2Marker; remove marker-wiping insertTranscript orphan (auto-pipeline P3)`

---

### Task 5: Re-summarize UI (SourceReader + Library wiring)

**Files:** `src/features/library/components/SourceReader.tsx`, `src/pages/Library.tsx`; component test (extend SourceReader's test file if present, else add one following the dir's idiom)

- [ ] **Step 1: Failing tests:** (a) recording with `transcriptionStatus='complete'` + transcript prop → a "Re-summarize" button renders and fires `onResummarize`; (b) `transcriptionStatus='error'` + transcript WITH `full_text` → the transcript content renders along with an inline "Summary failed — Re-summarize" notice whose button fires `onResummarize`; (c) no transcript → no re-summarize affordance.
- [ ] **Step 2: SourceReader changes.**
  - Props (interface at :37-59): add `onResummarize?: () => void` next to `onTranscribe`.
  - Action-buttons row (the Transcribe block ends at :485; insert after it, before the Delete block at :487):
```tsx
        {/* Re-summarize - any recording with a transcript (spec §5.6: healthy + failed) */}
        {transcript?.full_text && onResummarize && (
          <Button
            variant="outline"
            size="sm"
            onClick={onResummarize}
            disabled={recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'}
            className="gap-2"
            title="Regenerate the summary with the currently selected summarization model"
          >
            <RefreshCw className="h-4 w-4" />
            Re-summarize
          </Button>
        )}
```
  - Failure state — **read the real control flow first**: the render chain at :519-547 is `{transcript ? <TranscriptViewer/> : status==='complete' ? ... : pending/processing ? ... : <generic else>}`. There is NO `'error'` branch in the fallback chain, and the fallbacks are unreachable whenever `transcript` is truthy — so error-with-transcript ALREADY renders the TranscriptViewer with no notice. The change goes **inside the truthy `transcript ?` branch**: when `recording.transcriptionStatus === 'error'`, render this inline notice ABOVE the TranscriptViewer:
```tsx
            <div className="mb-3 flex items-center gap-2 rounded-md border border-orange-300 bg-orange-50 dark:bg-orange-950/30 px-3 py-2 text-sm">
              <AlertCircle className="h-4 w-4 text-orange-600" />
              <span>Summary failed — the transcript is intact.</span>
              {onResummarize && (
                <Button variant="link" size="sm" className="h-auto p-0" onClick={onResummarize}>
                  Re-summarize
                </Button>
              )}
            </div>
```
  (Check lucide imports at :17 — `RefreshCw` exists; add `AlertCircle` if missing.)
- [ ] **Step 3: Library wiring** (mount at :1062-1085, next to `onTranscribe`):
```tsx
              onResummarize={() => {
                if (selectedRecording) {
                  window.electronAPI.recordings.resummarize(selectedRecording.id).then((r) => {
                    if (!r.success) toast({ title: 'Re-summarize failed', description: r.error, variant: 'error' })
                  })
                }
              }}
```
  (Match Library.tsx's existing toast import/idiom — read its head first.)
- [ ] **Step 4: Tests PASS, typecheck RC 0, commit.** `feat(electron): Re-summarize action in SourceReader (healthy + failed states) wired to transcription:resummarize (auto-pipeline P3)`

---

### Task 6: Summarization Settings card + model picker IPC

**Files:** create `electron/main/ipc/summarization-handlers.ts` (+ register in **`electron/main/ipc/handlers.ts`** — `registerIpcHandlers()` is where the per-domain `register*Handlers` calls live, imports at :1-20, calls at :24+; `electron/main/index.ts` only calls `registerIpcHandlers()` once at :164); modify `preload/index.ts`, `src/pages/Settings.tsx`, `recording-handlers.ts` (extend validateConfig); tests: new handler test + `Settings.test.tsx`

- [ ] **Step 1: Failing handler tests** (`summarization-handlers.test.ts`): `summarization:listModels` GETs `https://ollama.com/api/tags` with `Authorization: Bearer <key from config>` and maps `{ models: [{ name }] }` → `{ success: true, models: ['gpt-oss:120b', ...] }`; non-OK → `{ success: false, error }`. `summarization:testConnection` POSTs a 1-token chat (`messages:[{role:'user',content:'ping'}]`, the configured model) and classifies: ok → `{ success: true }`; 401 → key-rejected message; 404 → model-not-found message (§7.1 wording); 429 → quota message.
- [ ] **Step 2: Implement `summarization-handlers.ts`** (complete file: `registerSummarizationHandlers()` with the two `ipcMain.handle` calls, fetch with 30 s AbortController each, reading `getConfig().summarization`). Register inside `registerIpcHandlers()` in `electron/main/ipc/handlers.ts` (import at the top with the other per-domain imports, call beside the other `register*Handlers()` calls at :24+). Do NOT touch `electron/main/index.ts` — it calls `registerIpcHandlers()` once at :164.
- [ ] **Step 3: Preload bindings** — new `summarization` block in both the type decl (near the `config` block at :92-98) and impl (near :519-524):
```ts
  summarization: {
    listModels: () => Promise<{ success: boolean; models?: string[]; error?: string }>
    testConnection: () => Promise<{ success: boolean; error?: string }>
  }
```
- [ ] **Step 4: Extend `transcription:validateConfig`** (P2 handler): the summarization branch now reads `config.summarization.provider`; when `'ollama-cloud'` and `!config.summarization.ollamaCloudApiKey.trim()` → push `{ stage: 'summarization', provider: 'ollama-cloud', problem: 'missing-key' }`. Update its handler tests.
- [ ] **Step 5: Failing Settings tests:** Summarization card renders with provider toggle (Gemini | Ollama Cloud); choosing Ollama Cloud reveals key field (Eye idiom) + model input + "Fetch models" button that populates a select from `listModels`; Save calls `updateConfig('summarization', { provider: 'ollama-cloud', ollamaCloudApiKey: 'ok-1234567890', ollamaCloudModel: 'gpt-oss:120b' })`; a "Test" button surfaces `testConnection` results via toast.
- [ ] **Step 6: Implement the card** in `Settings.tsx` as a new `<Card>` directly after the Transcription card (`</Card>` at ~:536, before `{/* Chat Settings */}` at :538), reusing the established idioms verbatim (Button-group toggle :545-568; Eye/EyeOff field :465-489; select :504-525; dirty-memo/hydration/save/rollback patterns :119-271). State: `sumProvider`, `ollamaCloudApiKey`, `showOllamaKey`, `ollamaCloudModel`, `ollamaModels: string[]`, `fetchingModels`. Model field: a text Input plus "Fetch models" Button; when `ollamaModels.length > 0` render the select populated from it (manual text input remains the fallback — spec §5.6). Validation rule in `validateConfig`: when provider is ollama-cloud on save, require non-empty model and key length ≥ 10.
- [ ] **Step 7: All green (handler + Settings + full typecheck), commit.** `feat(electron): Summarization settings card — Ollama Cloud key, live model picker, test connection (auto-pipeline P3)`

---

### Task 7: Full gates + AC6 evidence

- [ ] **Step 1:** typecheck / lint / `npm run test:run` — RCs 0 (re-run once on the known WASM flake).
- [ ] **Step 2: AC6 evidence** — name the tests proving: resummarize regenerates with the CURRENT provider without touching full_text; works with audio deleted; keeps old summary on failure; no duplicate actionables; **does not re-rename the title** (Task 4 Step 3's no-re-rename assertion); reachable from BOTH healthy and failed UI states.
- [ ] **Step 3: Report** with realignment citations (insertTranscript removal → P1 carry-note/spec §5.3 single-writer rule).

## Done criteria (spec §12 P3 → AC6)
- [ ] `ollama-cloud` selectable end-to-end (config → factory → worker columns → Settings card with live model picker).
- [ ] Meeting-selection validator guards links AND indexing metadata ('none'/hallucinated/string-confidence).
- [ ] Resummarize: marker-clear (summary kept), queue-driven Stage-2-only, UI affordance in both states.
- [ ] `insertTranscript` orphan removed; structural casts deleted; all P2 behavior intact; gates green.

## Explicitly NOT in P3
- 429 parking behavior / key-fix re-pend / failure chip (P4 — the typed errors are already thrown, the worker still treats them as generic retryables until P4).
- Baseline/auto-sync (P5); integration e2e + physical test (P6); local Ollama for summarization (only Cloud; the existing local-Ollama chat/RAG config is untouched).
