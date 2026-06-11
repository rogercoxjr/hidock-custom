# Auto-Pipeline with Model of Choice — Design Spec

**Date:** 2026-06-11
**App:** `apps/electron` (universal knowledge hub)
**Goal:** Plug in a HiDock P1 → the app automatically downloads new recordings, transcribes them with **OpenAI Whisper**, and summarizes them with an **Ollama Cloud** model of the user's choice — silently, with results appearing in the Knowledge Library.

## 1. User decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Transcription (ASR) engine | **OpenAI Whisper API** (user's OpenAI key); engine selectable — Gemini remains available |
| Summarization LLM | **Ollama Cloud** via direct `ollama.com` API key; model selectable |
| Auto-trigger scope | **Only NEW since last sync.** First-ever auto-sync sets a baseline and processes nothing |
| Result UX | **Silent** — recordings appear in the Library with transcript + summary as they complete; small progress indicator (existing badges) |
| Approach | **A — two-stage provider split inside the existing queue** (vs. porting meeting-recorder's factory, or adopting `packages/*`) |

## 2. Hard constraints (verified)

- **Ollama cannot ingest audio.** Local or cloud, its API accepts text/images only. Therefore ASR and summarization are separate stages with separate providers.
- **OpenAI Whisper upload limit is 25 MB.** A ~1-hour P1 recording (~48–64 kbps) hovers at that limit; longer recordings exceed it. The Whisper path requires transcode-then-chunk handling (§5.1).
- **Audio-capable engines in this codebase are Google-only today** (Gemini multimodal; Chirp 3 in meeting-recorder). Whisper is a new, third option added by this design.
- **USB safety (CLAUDE.md):** no exploratory USB code, no real-device testing. Both jensen implementations use the WebUSB single-pending `transferIn(2, 51200)` loop — **do not touch any USB/transfer code in this work.** Final verification = ONE clean plug-in by the user.
- **The pipeline runs while the Electron app is open.** The connect→download leg lives in renderer hooks (`OperationController` mounts them). Headless/tray operation is explicitly **out of scope** (unchanged existing architecture; SPEC-004's main-process PipelineManager remains unbuilt).

## 3. Current state (verified, with anchors)

The end-to-end chain **already exists and is on by default** — it is Gemini-locked and unbaselined:

- Hotplug + auto-connect: `src/services/jensen.ts:625-635` (`navigator.usb.onconnect` → `tryConnect`), gated by `device.autoConnect` (default true, `config.ts:103`); main auto-approves the USB picker (`electron/main/index.ts:206-237`).
- Auto-sync on ready: `src/hooks/useDeviceSubscriptions.ts:73-150` (+ pre-connected path 189-267), gated by `src/utils/autoSyncGuard.ts:16-58` (`device.autoDownload`, default true).
- Reconciliation: `download-service.ts:245-314` (`isFileAlreadySynced` 4-layer + `getFilesToSync`).
- Download execution: renderer `useDownloadOrchestrator.ts:178-380` does USB transfer, ships bytes to main `processDownload` (`download-service.ts:415`).
- Auto-transcribe hook: `download-service.ts:489-503` — on download completion, if `transcription.autoTranscribe` (default true, `config.ts:86`) → `addToQueue` + `processQueueManually`. Duplicate disk-level trigger: `recording-watcher.ts:206-214`.
- Queue worker: `transcription.ts` — persistent `transcription_queue` (schema `database.ts:278-290`), 10s poller (`:42-60`), cross-process mutex (`database.ts:3302`), retry ×3 with exponential backoff (`:88,156`), progress stages (`:199-211`).
- **The fused Gemini worker:** `transcribeRecording` (`transcription.ts:364-678`) = 3 sequential Gemini calls — (1) audio inline-base64 → transcript (`:389-443`), (2) analysis → summary/action_items/topics/key_points/title/questions + AI meeting selection (`:476-533`, selection `:537-564`, MIN_LINK_CONFIDENCE 0.4), (3) `detectActionables` (`:288-362`). Provider hardcoded `new GoogleGenerativeAI(...)` (`:405`); `AppConfig.transcription.provider` is the literal type `'gemini'` (`config.ts:37`). Writes one `transcripts` row at the end (`insertTranscript`, `:570-588`), then status complete, auto-rename, actionables rows, Ollama-local RAG indexing (`:599-674`).
- Settings UI: Gemini-only model dropdown `src/pages/Settings.tsx:45-63`; auto toggles live on `src/pages/Device.tsx:1015-1047`.
- Key handling precedent: `safeStorage` encryption exists for `calendar.icsUrl` only (`config.ts:163-170`); `geminiApiKey` is plaintext (pre-existing; migration out of scope, §10).
- Missing-key behavior: with no `geminiApiKey`, the processor fails every queue item with a Settings hint (`transcription.ts:108-131`).

## 4. What this design adds

1. **ASR provider layer** (selectable: `gemini` | `openai-whisper`), with transcode-then-chunk for Whisper.
2. **LLM provider layer** for the text stages (selectable: `gemini` | `ollama-cloud`).
3. **Two-stage worker** with stage-aware persistence → re-summarize without re-transcribing.
4. **First-sync baseline guard** so a fresh device doesn't trigger a backlog avalanche.
5. **Settings UI** for both pickers + encrypted key storage.

No changes to: USB/jensen code, download orchestration, reconciliation layers 1-4, queue/mutex/retry machinery, RAG embeddings (stays local Ollama `nomic-embed-text`), calendar correlation logic.

## 5. Component design

### 5.1 ASR provider layer — `electron/main/services/asr/`

- `asr-provider.ts` — interface + factory:
  ```ts
  interface AsrResult { text: string; language?: string }
  interface AsrProvider { transcribe(filePath: string, opts: { meetingContext?: string }): Promise<AsrResult> }
  function getAsrProvider(config: AppConfig): AsrProvider  // switches on config.transcription.provider
  ```
- `gemini-asr.ts` — the existing transcription call (`transcription.ts:389-443`) extracted verbatim: inline base64, `.hda` sent as `audio/mp3`, model `config.transcription.geminiModel`, meeting-context prompt preserved. **Behavior identical to today.**
- `whisper-asr.ts` — `POST https://api.openai.com/v1/audio/transcriptions` (multipart/form-data: `file`, `model`; optional `language`). Model from `config.transcription.whisperModel` (default `whisper-1`; plain string so `gpt-4o-transcribe` etc. work). Key from `config.transcription.openaiApiKey` (encrypted, §5.4).
  - **Size handling:** if input > 24 MB → transcode with `ffmpeg-static` to 16 kHz mono 32 kbps MP3 (1 h ≈ 14 MB, 90 min ≈ 22 MB); if *still* > 24 MB → segment (`-f segment -segment_time 600`), transcribe chunks serially, concatenate with `\n`. Temp files in `os.tmpdir()`, always cleaned up.
  - `.hda` files are MP3-compatible (precedent: sent as `audio/mp3` today) — upload with an `.mp3` filename.
  - `whisper-asr` **ignores** `opts.meetingContext` (Whisper's `prompt` param is a vocabulary hint, not an instruction channel; deliberately unused in v1). `gemini-asr` keeps using it exactly as today.

### 5.2 LLM provider layer — `electron/main/services/llm/`

- `llm-provider.ts` — interface + factory:
  ```ts
  interface LlmProvider { generate(prompt: string, opts?: { json?: boolean }): Promise<string> }
  function getLlmProvider(config: AppConfig): LlmProvider  // switches on config.summarization.provider
  ```
- `gemini-llm.ts` — existing `generateContent` text path extracted; model = `config.transcription.geminiModel` (preserves today's fused behavior when selected).
- `ollama-cloud-llm.ts` — `POST https://ollama.com/api/chat`, headers `Authorization: Bearer <ollamaCloudApiKey>`, body `{ model, messages: [{role:'user', content: prompt}], stream: false, format: opts.json ? 'json' : undefined }` → `response.message.content`.
- **Both LLM call sites route through this layer:** (1) the analysis call — one prompt producing summary/action_items/topics/key_points/title/questions *and* the meeting-selection JSON (they are a single fused prompt today, `transcription.ts:476-533`), and (2) `detectActionables`. Nothing else. Prompts are reused **unchanged**. The existing markdown-fence/regex JSON extraction (`transcription.ts:525-533`) is reused for both providers.

### 5.3 Two-stage worker (refactor of `transcribeRecording`)

- **Stage 1 — ASR:** `getAsrProvider().transcribe()` → **insert the `transcripts` row immediately** with `full_text`, `language`, `word_count`, `transcription_provider` (`'gemini'` | `'openai-whisper'`), `transcription_model`; analysis fields NULL.
- **Stage 2 — Analysis:** `getLlmProvider().generate()` for analysis + meeting-selection → **UPDATE** the row: `summary`, `action_items`, `topics`, `key_points`, `title_suggestion`, `question_suggestions`, plus new columns `summarization_provider`, `summarization_model`. Then (unchanged order): status complete → auto-rename → actionables → RAG indexing → `transcription:completed`.
- **Stage-aware resume:** at worker start, if a transcript row already exists for the recording with `full_text` set and `summary` NULL → **skip Stage 1**, run Stage 2 only. To keep this rule unambiguous, Stage 2 **always writes a non-NULL summary** (falling back to the existing `'Analysis failed'` sentinel on parse failure) — `summary IS NULL` therefore always means "Stage 2 has not completed." This single rule gives:
  - Analysis-failure retries that never re-pay for ASR.
  - **`transcription:resummarize` IPC** (new): set `summary = NULL` on the transcript + `addToQueue(recordingId)` — the worker naturally re-runs Stage 2 with the *currently configured* summarization provider. No queue-schema change.
- Progress stages preserved: `reading_file 5 → transcribing 20 → analyzing 50 → detecting_actionables 75 → indexing 85 → complete 100`.
- Missing-key check (`transcription.ts:108-131`) generalizes: validate the key for the **selected** ASR provider and the **selected** LLM provider; failure message names the specific provider and points at Settings.

### 5.4 Config schema (`electron/main/services/config.ts`)

```ts
transcription: {
  provider: 'gemini' | 'openai-whisper'   // widened from literal 'gemini'; default 'gemini'
  geminiApiKey: string                     // unchanged (plaintext, pre-existing; see §10)
  geminiModel: string                      // unchanged
  openaiApiKey: string                     // NEW — safeStorage-encrypted at rest
  whisperModel: string                     // NEW — default 'whisper-1'
  autoTranscribe: boolean                  // unchanged
}
summarization: {                           // NEW section
  provider: 'gemini' | 'ollama-cloud'      // default 'gemini' (= today's fused behavior)
  ollamaCloudApiKey: string                // safeStorage-encrypted at rest
  ollamaCloudModel: string                 // e.g. 'gpt-oss:120b', 'deepseek-v3.1:671b'
}
```

- Encryption: the two new keys use the existing `safeStorage` encrypt-on-save / decrypt-on-load pattern (`config.ts:163-170`). Defaults guarantee **zero behavior change** for existing configs (provider `gemini` + summarization `gemini` ≡ today).
- Config migration: missing fields are filled with defaults by the existing deep-merge on load.

### 5.5 First-sync baseline guard

- **New table** (migration in `database.ts`):
  ```sql
  CREATE TABLE IF NOT EXISTS sync_baselines (
    device_serial TEXT PRIMARY KEY,
    baseline_time TEXT NOT NULL,   -- ISO datetime
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ```
- `getFilesToSync(files, opts)` gains `opts: { auto: boolean, deviceSerial?: string }`:
  - **auto + no baseline row:** create baseline = max(`createDate` of device files) (now() if none), queue **nothing** (each file tagged `skipReason: 'baseline-established'`).
  - **auto + baseline exists:** apply layers 1-4 as today, *additionally* skipping files with `createDate <= baseline_time` (`skipReason: 'before-baseline'`).
  - **manual (auto=false):** current behavior, no baseline filtering — the backlog stays reachable from the existing UI.
- **Baseline advance:** when an auto session completes, advance `baseline_time` to the max `createDate` among *successfully downloaded* files of that session (never backwards). Known accepted edge: a failed file older than the new baseline is not auto-retried on next connect — it remains visible as unsynced in the Library and downloadable manually (failures already surface in the existing download-error UI).
- Renderer: `useDeviceSubscriptions.ts` passes `{ auto: true, deviceSerial }` on its two auto paths (`:73-150`, `:189-267`); all other `getFilesToSync` callers default to manual semantics.

### 5.6 Settings UI (`src/pages/Settings.tsx`)

- **Transcription card:** provider select (Gemini | OpenAI Whisper). Gemini → existing model dropdown + key field (unchanged). Whisper → OpenAI API key field + model field (default `whisper-1`).
- **New Summarization card:** provider select (Gemini | Ollama Cloud). Ollama Cloud → API key field + model picker populated via `GET https://ollama.com/api/tags` (Bearer auth) with manual text-input fallback; small "Test" button validating the key (1-token chat round-trip).
- Auto toggles remain on the Device page (`Device.tsx:1015-1047`) — not moved (YAGNI).
- QA logging: any new logging obeys `qaLogsEnabled` via the established patterns (CLAUDE.md QA rules).

## 6. Data flow (end-to-end, after this design)

Plug in P1 → auto-connect → ready → auto-sync gate → **baseline filter** → new files queued → renderer downloads via USB (unchanged) → main saves + marks synced → auto-transcribe queues → worker: **Whisper ASR** (transcode/chunk if needed) → transcript row (`full_text`) → **Ollama Cloud analysis** (summary/actions/topics/key_points/title/questions + meeting selection) → row updated → actionables (Ollama Cloud) → RAG indexing (local, unchanged) → `transcription:completed` → Library updates silently with existing badges.

## 7. Error handling

| Failure | Behavior |
|---|---|
| ASR call fails | Existing queue retry ×3 with backoff (whole job — no transcript row yet) |
| Analysis call fails | Transcript row with `full_text` persists; retry runs **Stage 2 only** |
| Missing key for selected provider | Queue items fail with provider-specific message + Settings hint (generalizes `transcription.ts:108-131`) |
| File > 24 MB | Transcode → chunk; if ffmpeg fails → job fails with clear error (no silent skip) |
| Ollama JSON unparseable | Existing fence/regex extraction; on failure `summary='Analysis failed'`, retryable |
| Ollama Cloud 401/429 | Surfaced as retryable failures with the provider named |
| Existing Gemini-only configs | Defaults reproduce today's behavior exactly — no migration action needed |

## 8. Testing

- **Unit (Vitest, mocked `fetch`/`spawn`):** `whisper-asr` (multipart shape, 24 MB guard, transcode+chunk path, temp cleanup), `ollama-cloud-llm` (Bearer header, `format:json`, response parsing), config (defaults, key encryption round-trip), `getFilesToSync` baseline (first-auto-sets-baseline-queues-nothing, subsequent filters, manual bypass, advance-on-success), stage-aware resume (full_text present + summary NULL → Stage 2 only), `transcription:resummarize`.
- **Integration:** a second e2e-smoke variant (`e2e-smoke.test.ts` pattern: real in-memory sql.js + temp audio file) running provider = `openai-whisper` + summarization = `ollama-cloud` with both HTTP boundaries mocked; asserts transcript row fields incl. per-stage provider/model columns.
- **Must stay green:** `download-service.test.ts` (+ b007/c004), `transcription.test.ts` (+ b007), `e2e-smoke.test.ts`, `useDownloadOrchestrator`, `useUnifiedRecordings`, `Settings.test.tsx`, `usb-smoke.test.ts`; full gates `npm run typecheck && npm run lint && npm run test:run`.
- **USB:** zero real-device testing during development. Acceptance = user plugs in the P1 **once**, observes new recordings appear → transcribe (Whisper) → summarize (chosen Ollama Cloud model) silently.

## 9. Dependencies

- `ffmpeg-static` (+ existing monorepo precedent: meeting-recorder/audio-capture) added to `apps/electron` only — used by `whisper-asr` transcode/chunk. Must be listed in electron-builder `asarUnpack` (binary).
- No new packages elsewhere; `packages/*` intentionally not consumed (Approach C deferred).

## 10. Out of scope (explicit)

- Migrating the existing plaintext `geminiApiKey` to encrypted storage (pre-existing; separate fix).
- Local Whisper (whisper.cpp), Chirp 3, or any additional ASR engines — the provider interface leaves the seam.
- Headless / tray-only pipeline (main-process PipelineManager, SPEC-004).
- Adopting `packages/transcription` / `packages/ai-providers` (Approach C — future).
- Desktop notifications / digest views (user chose silent).
- Whisper chunk-boundary prompt continuity tuning; speaker diarization for Whisper output.
- Queue parallelism (stays strictly sequential — provider rate-limit-friendly).
- Fixing the `recordings:transcribe` queue-bypass (`recording-handlers.ts:241` skips queue/mutex/retry). It already funnels into the same `transcribeRecording` worker, so the refactor makes it provider-honoring automatically — its bypass behavior itself is a pre-existing issue left unchanged.

## 11. Acceptance criteria

1. With provider = `openai-whisper`, summarization = `ollama-cloud`, valid keys, app open: plugging in a P1 with N new recordings (newer than baseline) results — with no user interaction — in N library rows with status synced + transcribed, `transcription_provider='openai-whisper'`, `summarization_provider='ollama-cloud'`, non-empty `full_text` and `summary`.
2. First-ever auto-sync of a device queues nothing and records a baseline; the next connect processes only newer files.
3. Manual sync still reaches pre-baseline files.
4. A recording > 25 MB transcribes successfully via the transcode/chunk path (mocked in tests).
5. Killing the summarization key mid-queue fails items with a provider-named message; fixing the key + retry completes them **without re-running ASR**.
6. `transcription:resummarize` regenerates the summary with the currently selected LLM without touching `full_text`.
7. Existing Gemini-default configs behave byte-for-byte as before (all existing tests green, defaults unchanged).
