# Auto-Pipeline with Model of Choice — Design Spec

**Date:** 2026-06-11 (rev 3 — post-antagonistic-review + verification pass)
**App:** `apps/electron` (universal knowledge hub)
**Goal:** Plug in a HiDock P1 → the app automatically downloads new recordings, transcribes them with **OpenAI Whisper**, and summarizes them with an **Ollama Cloud** model of the user's choice — silently, with results appearing in the Knowledge Library.

> **Rev 2/3:** an adversarial review (4 lenses, web-verified API facts) found 3 blockers and ~8 majors in rev 1; a 3-verifier pass on rev 2 surfaced 11 further findings (parking state design, per-stage key checks, fresh-device baseline gate), all resolved in rev 3. This revision replaces the timestamp baseline with a filename snapshot, replaces the `summary IS NULL` stage marker with `summarization_provider IS NULL`, makes the Whisper path always-transcode with `whisper-1` pinned, and adds the operational hardening listed in §7–§9. Every change traces to a verified failure scenario.

## 1. User decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Transcription (ASR) engine | **OpenAI Whisper API** (`whisper-1`, user's OpenAI key); engine selectable — Gemini remains available |
| Summarization LLM | **Ollama Cloud** via direct `ollama.com` API key; model selectable |
| Auto-trigger scope | **Only NEW since last sync.** First-ever auto-sync records a baseline snapshot and processes nothing |
| Result UX | **Silent** — recordings appear in the Library with transcript + summary as they complete; existing per-row badges + one aggregate failure chip (§7.3) |
| Approach | **A — two-stage provider split inside the existing queue** |

## 2. Hard constraints (verified)

- **Ollama cannot ingest audio.** Local or cloud, its API accepts text/images only. ASR and summarization are therefore separate stages with separate providers.
- **OpenAI Whisper upload limit is 25 MB**, and **`gpt-4o-transcribe`/`-mini-transcribe` additionally reject audio over 1500 s** and do not support `verbose_json`. v1 therefore pins the ASR model to **`whisper-1`** (§5.1); the 4o-transcribe family is explicitly deferred (§10).
- **P1 `.hda` container format is UNVERIFIED.** The "MP3-compatible" precedent (`transcription.ts:400`) is an H1E-specific comment; `apps/desktop/src/hta_converter.py:9-10` documents P1 format as unknown. The Whisper path therefore **always transcodes through ffmpeg** (§5.1) — raw `.hda` bytes are never uploaded to OpenAI. During implementation, inspect the header bytes of an already-downloaded P1 file on disk if one exists (zero USB risk) and record findings.
- **Audio-capable engines in this codebase are Google-only today** (Gemini multimodal; Chirp 3 in meeting-recorder). Whisper is a new, third option added by this design.
- **USB safety (CLAUDE.md):** no exploratory USB code, no real-device testing. Both jensen implementations use the WebUSB single-pending `transferIn(2, 51200)` loop — **do not touch any USB/transfer code in this work.** Final verification = ONE clean plug-in by the user (AC1 is the sole physical-device criterion).
- **The pipeline runs while the Electron app is open.** The connect→download leg lives in renderer hooks (`OperationController` mounts them). Headless/tray operation is out of scope (unchanged existing architecture).

## 3. Current state (verified, with anchors)

The end-to-end chain **already exists and is on by default** — it is Gemini-locked and unbaselined:

- Hotplug + auto-connect: `src/services/jensen.ts:625-635` (`navigator.usb.onconnect` → `tryConnect`), gated by `device.autoConnect` (default true, `config.ts:103`); main auto-approves the USB picker (`electron/main/index.ts:206-237`).
- Auto-sync on ready: `src/hooks/useDeviceSubscriptions.ts:73-150` (+ pre-connected path 189-267), gated by `src/utils/autoSyncGuard.ts:16-58` (`device.autoDownload`, default true). Errors in this hook are swallowed at `:144` — new code must not rely on exceptions surfacing.
- Reconciliation: `download-service.ts:245-314` (`isFileAlreadySynced` 4-layer + `getFilesToSync(deviceFiles: Array<{filename; size; duration; dateCreated}>)` — note `dateCreated`, which crosses IPC as an ISO **string** despite the `Date` type in `preload/index.ts:343`; see `Device.tsx:490`).
- Download execution: renderer `useDownloadOrchestrator.ts:178-380` does the USB transfer, ships bytes to main `processDownload` (`download-service.ts:415`). `SyncSession.status` is only ever set to `'active'` (`:401`) or `'cancelled'` (`:879`) — **there is no session-completion event today** (why rev 1's baseline-advance was unimplementable).
- Auto-transcribe hook: `download-service.ts:489-503`; duplicate disk-level trigger `recording-watcher.ts:206-214`. `addToQueue` is a blind INSERT with no dedupe (`database.ts:2286-2290`).
- Queue worker: `transcription.ts` — persistent `transcription_queue` (`database.ts:278-290`), 10 s poller (`:42-60`), cross-process mutex (`database.ts:3302`), retry ×3 w/ backoff 30 s·2ⁿ capped 120 s (`:88,156`), `NON_RETRYABLE_ERRORS` hardcoded substring list (`:135-140`), progress stages (`:199-211`).
- **The fused Gemini worker:** `transcribeRecording` (`transcription.ts:364-678`) — file-existence check at entry (`:368-375`, error string is in `NON_RETRYABLE_ERRORS`); 3 sequential Gemini calls: audio→text (`:389-443`), analysis incl. meeting-selection (`:476-533` — note the regex no-match path leaves `analysis = {}` **without** throwing, so NULL summaries on complete transcripts exist today), `detectActionables` (`:288-362`, plain INSERTs, no dedupe `:615-640`). `insertTranscript` is INSERT OR REPLACE on UNIQUE `recording_id` (`database.ts:2200-2205`).
- Renderer queueing paths **hard-gate on the Gemini key**: `useOperations.ts:34-43` (single) and `:78-87` (bulk) abort with a "configure your Gemini API key" toast — these are the only UI retry affordances.
- `recordings:transcribe` IPC (`recording-handlers.ts:241`) calls `transcribeManually` directly — bypasses queue, mutex, retry.
- Settings UI: Gemini-only model dropdown `src/pages/Settings.tsx:45-63`; auto toggles on `src/pages/Device.tsx:1015-1047`.
- safeStorage precedent is **two hardcoded per-field sites**: encrypt in `saveConfig` (`config.ts:163-170`) AND decrypt in `initializeConfig` (`config.ts:133-136`) — both must be extended for any new key. `encryptSensitive` has no double-encryption guard. `config:get` ships the decrypted config to the renderer (`config-handlers.ts:8-19`).
- Migrations: fresh DBs run ALL migrations against just-created SCHEMA tables (`database.ts:1484-1493`), so ALTERs must be try/catch-guarded (v16 pattern, `database.ts:957-963`); SCHEMA-only edits never reach upgraded installs. Commit 7a7c2b18 stabilized exactly this path; `e2e-smoke.test.ts` is its guard.

## 4. What this design adds / changes

1. **ASR provider layer** (selectable: `gemini` | `openai-whisper`), Whisper path always-transcode + chunk (§5.1).
2. **LLM provider layer** for the text stages (selectable: `gemini` | `ollama-cloud`) (§5.2).
3. **Two-stage worker** with an explicit stage marker → re-summarize without re-transcribing (§5.3).
4. **First-sync baseline snapshot** (filename set-difference — no timestamps) (§5.5).
5. **Settings UI** for both pickers + encrypted key storage + provider-aware preflight (§5.6).
6. **Queue hardening:** `addToQueue` dedupe, worker short-circuit, `recordings:transcribe` re-routed through the queue (§5.7).
7. **Failure taxonomy + recovery:** quota parking, non-retryable classification, key-fix re-pend, one aggregate failure chip, HTTP timeouts (§7).

**Changed (scoped):** the retry machinery gains 429-parking, new non-retryable strings, and key-fix re-pend (§7.1–7.2) — rev 1's "queue machinery unchanged" claim is amended.
**Unchanged:** USB/jensen code, download orchestration, reconciliation layers 1-4, RAG embeddings (local Ollama `nomic-embed-text`), calendar correlation logic.

## 5. Component design

### 5.1 ASR provider layer — `electron/main/services/asr/`

- `asr-provider.ts` — interface + factory:
  ```ts
  interface AsrResult { text: string; language?: string }   // language: whisper-1 verbose_json or Gemini; nullable
  interface AsrProvider { transcribe(filePath: string, opts: { meetingContext?: string }): Promise<AsrResult> }
  function getAsrProvider(config: AppConfig): AsrProvider   // switches on config.transcription.provider
  ```
- `gemini-asr.ts` — the existing transcription call (`transcription.ts:389-443`) extracted verbatim: inline base64, `.hda` as `audio/mp3`, model `config.transcription.geminiModel`, meeting-context prompt preserved. **Behavior identical to today.**
- `whisper-asr.ts` — model **pinned to `whisper-1`** in v1 (config stores `whisperModel: 'whisper-1'`; the Settings select offers only that value; the 4o-transcribe family is deferred — 1500 s duration cap + no `verbose_json`, §10).
  - **Always-transcode:** every input is normalized via ffmpeg to 16 kHz mono 32 kbps MP3 (1 h ≈ 14 MB, 90 min ≈ 22 MB) **before** upload — one code path, deterministic size/format, no unverified-container upload. If the result still exceeds 24 MB → segment (`-f segment -segment_time 600`), transcribe chunks serially, concatenate with `\n`.
  - Request: `POST https://api.openai.com/v1/audio/transcriptions`, multipart (`file`, `model`, `response_format: 'verbose_json'`); `language` taken from the response of the **first** chunk; nullable. AbortController timeout **10 min per call** (§7.4).
  - **ffmpeg resolution:** `require('ffmpeg-static')` then, when `app.isPackaged`, `.replace('app.asar', 'app.asar.unpacked')`. electron-builder config adds `asarUnpack: ['node_modules/ffmpeg-static/**']`. One unit test asserts the rewrite.
  - **Temp hygiene:** all intermediates in `join(os.tmpdir(), 'hidock-asr')`, named by recording id; the directory is wiped at app startup and after each job. Before spawning ffmpeg, check free disk ≥ 2× the expected transcode size; on failure raise a specific, non-retryable `insufficient disk space` error.
  - `whisper-asr` **ignores** `opts.meetingContext` (Whisper's `prompt` param is a vocab hint, not an instruction channel; deliberately unused in v1). `gemini-asr` keeps using it exactly as today.
  - **Accepted v1 limitation:** chunk results are held in memory per attempt — a retry re-pays all chunks. Mitigated by classifying quota/auth failures non-retryable (§7.1) so retries only occur on transient errors. Cross-retry chunk checkpointing is deferred (§10).

### 5.2 LLM provider layer — `electron/main/services/llm/`

- `llm-provider.ts` — interface + factory:
  ```ts
  interface LlmProvider { generate(prompt: string, opts?: { json?: boolean }): Promise<string> }
  function getLlmProvider(config: AppConfig): LlmProvider   // switches on config.summarization.provider
  ```
- `gemini-llm.ts` — existing `generateContent` text path extracted; model = `config.transcription.geminiModel` (preserves today's fused behavior when selected).
- `ollama-cloud-llm.ts` — `POST https://ollama.com/api/chat`, headers `Authorization: Bearer <ollamaCloudApiKey>`, body `{ model, messages: [{role:'user', content: prompt}], stream: false, format: opts.json ? 'json' : undefined }` → `response.message.content`. AbortController timeout **5 min per call** (§7.4). HTTP 404 model-not-found → non-retryable with the exact message in §7.1.
- **Both LLM call sites route through this layer:** (1) the analysis call — one fused prompt producing summary/action_items/topics/key_points/title/questions *and* the meeting-selection JSON (`transcription.ts:476-533`), and (2) `detectActionables`. Prompts reused **unchanged**; fence/regex JSON extraction reused.
- **Meeting-selection validator** (new, provider-agnostic, in the worker): `selected_meeting_id` must be a member of the candidate-ID set, with the literal `'none'` mapped to `undefined`, else `undefined`; `meeting_confidence` coerced via `Number()` and clamped to 0..1 — applied **before** the `analysis.selected_meeting_id || recording.meeting_id` fallback (`transcription.ts:656`) and before `addRecordingMeetingCandidate`. Hardens the existing Gemini path too (smaller Ollama models violate the shape more often).

### 5.3 Two-stage worker (refactor of `transcribeRecording`)

- **Stage marker:** the new `transcripts.summarization_provider` column. `summarization_provider IS NULL` ⇔ Stage 2 has not completed. The marker is written **only** by Stage 2's single success UPDATE, atomically with the content fields. The summary **content** is never used for control flow (rev 1's `summary IS NULL` rule is dead — NULL summaries on complete transcripts already exist via the no-match path `transcription.ts:525-534`).
- **Stage 1 — ASR:** file-existence check (today's `:368-375`) becomes **Stage-1-only**. `getAsrProvider().transcribe()` → a new `upsertTranscriptStage1` write: `INSERT ... ON CONFLICT(recording_id) DO UPDATE SET full_text/language/word_count/transcription_provider/transcription_model = excluded.*` with the existing id rule `trans_${recordingId}` — it **never touches Stage-2 columns** (replaces today's blind INSERT OR REPLACE for this path, which would clobber an existing summary).
  - **`language` ownership (per provider per stage):** Stage 1 writes `language` only when the ASR supplies it (whisper-1 `verbose_json`); `gemini-asr` returns no language (the existing call yields text only — today's `language` actually comes from the Stage-2 analysis JSON, `transcription.ts:574`). Stage 2's UPDATE therefore includes `language = COALESCE(language, <analysis.language>)` — Gemini-default configs keep producing language exactly as today; Whisper rows get it from ASR.
- **Stage 2 — Analysis:** key check at **stage entry** (see per-stage checks below). `getLlmProvider().generate()` (analysis + meeting-selection, then validator §5.2) → one UPDATE: `summary`, `action_items`, `topics`, `key_points`, `title_suggestion`, `question_suggestions`, `language` (COALESCE, above), `summarization_provider`, `summarization_model`. **JSON-extraction failure THROWS — both the parse-error path (`:531-534`) and the regex no-match path (`jsonMatch === null`, `:526-529`) are treated as extraction failure** (this intentionally changes today's swallow-and-complete behavior): the queue retries Stage 2; after `MAX_RETRY_ATTEMPTS` the item is terminal-failed, the marker stays NULL, and any pre-existing summary is untouched. No sentinel strings are ever written. `sentiment`/`speakers` remain unpopulated (today's behavior; they belong to Stage 2 if ever implemented).
- **Per-stage key checks (replaces the queue-level pre-check at `transcription.ts:108-131`):** Stage 1 entry requires the selected **ASR** provider's key; Stage 2 entry requires the selected **LLM** provider's key. An item with a valid ASR key but missing/invalid LLM key **completes Stage 1 and persists `full_text` before failing at Stage 2** — so every key-failure item is Stage-2-resumable and AC5's "without re-running ASR" holds for the whole batch, not just the in-flight item. (Deliberate trade-off: ASR spend happens even when summarization is known-broken; the work is preserved, not wasted.)
- **`transcription_status` timing (unchanged from today):** set to `'complete'` immediately after the Stage-2 UPDATE, before actionables/indexing (`transcription.ts:590` today); failures in the tail are logged without reverting status.
- **Resume rule:** worker entry — if a transcript row has `full_text` set and `summarization_provider IS NULL` → skip Stage 1, run Stage 2 only (no audio file required). If **both** are set → short-circuit to success (duplicate queue items become harmless no-ops); explicit re-runs happen only via the IPCs below.
- **Stage-2 re-run tail semantics:** actionables are **delete-and-replace** for the recording (today's append duplicates them, `:615-640`); meeting re-selection may re-link (documented behavior). RAG re-indexing is already idempotent by recordingId (`vector-store.ts:192-201`).
- **Auto-rename predicate (concrete):** before the Stage-2 UPDATE, read the row's current `title_suggestion`; auto-rename runs **iff it was NULL** (i.e., this is the first time a title suggestion is being written). Persistent, needs no queue flag, survives retries (a failed first run left it NULL → the retry still renames), and resummarize on a completed row (non-NULL `title_suggestion`) never renames.
- **Progress stages for Stage-2-only runs** (resume/resummarize): start at `analyzing 50` (skip `reading_file`/`transcribing`).
- **`transcription:resummarize` IPC (new):** sets `summarization_provider = NULL` (the **summary is kept** until the new one lands — failure leaves the old summary intact) + `addToQueue(recordingId)`. Works on recordings whose local audio was deleted (supported flow, `database.ts:2082-2093`) because Stage 2 needs only `full_text`. UI affordance: §5.6.
- Progress stages preserved for full runs: `reading_file 5 → transcribing 20 → analyzing 50 → detecting_actionables 75 → indexing 85 → complete 100`. `transcription_status` stays `'processing'` through Stage 2 (§5.6 defines the failure-state UI). Failure messages use the exact §7.1 strings.

### 5.4 Config schema (`electron/main/services/config.ts`)

```ts
transcription: {
  provider: 'gemini' | 'openai-whisper'   // widened from literal 'gemini'; default 'gemini'
  geminiApiKey: string                     // unchanged (plaintext, pre-existing; see §10)
  geminiModel: string                      // unchanged
  openaiApiKey: string                     // NEW — safeStorage-encrypted at rest
  whisperModel: string                     // NEW — fixed 'whisper-1' in v1 (Settings offers no other value)
  autoTranscribe: boolean                  // unchanged
}
summarization: {                           // NEW section
  provider: 'gemini' | 'ollama-cloud'      // default 'gemini' (= today's fused behavior)
  ollamaCloudApiKey: string                // safeStorage-encrypted at rest
  ollamaCloudModel: string                 // e.g. 'gpt-oss:120b', 'deepseek-v3.1:671b'
}
```

- **Encryption recipe (both sites, explicitly):** add `transcription.openaiApiKey` and `summarization.ollamaCloudApiKey` to (a) the encrypt list in `saveConfig` (`config.ts:163-170`) **and** (b) the decrypt list in `initializeConfig` (`config.ts:133-136`). Add an idempotency guard to `encryptSensitive`: `if (value.startsWith('__enc__')) return value` (prevents double-encryption corruption during keyring hiccups). Unit test must cover the **cold-start** decrypt path (save → reload from disk → plaintext in memory), not just encrypt.
- **Security framing:** keys are *encrypted at rest only*. `config:get` returns decrypted values to the renderer (parity with the existing `geminiApiKey` UX — Eye/EyeOff toggle, `Settings.tsx:38`); this is not a secrets boundary.
- Defaults guarantee **behavior-identical** operation for existing configs (provider `gemini` + summarization `gemini` ≡ today). Missing fields are filled by the existing deep-merge on load (`config.ts:138`); the on-disk file gains the new sections on next save — that is expected and acceptable (AC7 is behavioral, not byte-for-byte).

### 5.5 First-sync baseline (filename snapshot — no timestamps)

> Rev 1 used `max(createDate)` timestamps with advance-on-session-complete. Killed by review: no session-completion event exists (`SyncSession` is never set `'completed'`), `dateCreated` crosses IPC as an ISO string while typed `Date`, device clocks drift/reset (fabricated `new Date()` fallback at `hidock-device.ts:1630`), and a battery-drained P1 would stamp a whole trip "before baseline." The snapshot design has none of these failure modes.

- **New table** (migration recipe §5.8):
  ```sql
  CREATE TABLE IF NOT EXISTS sync_baseline_files (
    device_serial TEXT NOT NULL,
    filename      TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (device_serial, filename)
  );
  ```
- **Semantics:** "new" = a device file whose filename is **neither** in `sync_baseline_files` for this serial **nor** already synced (existing 4-layer check). No timestamps anywhere. Failed downloads are retried naturally on the next connect (they are in neither set) — rev 1's "stranded failed file" edge is gone.
- **New IPC `download-service:ensure-baseline`** `(deviceSerial: string, filenames: string[]) → { created: boolean }`: snapshot all current filenames and return `created: true` **only for a fresh device** — defined as: no `sync_baseline_files` rows for the serial **AND** none of the device's filenames already appear in `synced_files`/`recordings` (no prior sync history). A device the user has synced before gets **no baseline** — auto-sync keeps downloading its unsynced files exactly as today (this is what keeps AC7 true for existing users; without it, upgrading would silently baseline-away files they expected to download). Explicit call — `getFilesToSync` stays a pure read (no side-effecting getter). The table's `created_at` is bookkeeping only — never consulted by the new-file semantics.
- **`getFilesToSync(files, opts?)`** gains `opts: { auto?: boolean; deviceSerial?: string }` **defaulting to `{ auto: false }`** — the existing display caller (`Device.tsx:467`) and all current call sites are untouched. When `auto && deviceSerial`: additionally skip files present in the baseline snapshot (`skipReason: 'baseline'`).
- **Auto-sync flow change** (`useDeviceSubscriptions.ts:73-150` and `:189-267`): read the serial from the device service state (`hidock-device.ts:38` — `serialNumber: string | null`); call `ensure-baseline` first; if it returns `created: true`, skip this sync cycle (log via QA pattern); else call `getFilesToSync` with `{ auto: true, deviceSerial }`. **`serialNumber === null` → skip auto-sync entirely for that cycle (QA log)** — never key a baseline on null, and never let a serial-less device bypass baseline/cap protections into an unbounded auto-download (manual sync remains available and unaffected).
- **Defense-in-depth cap:** auto-triggered sessions queue at most **100 files**; overflow files get `skipReason: 'auto-cap'` and a QA log. (Manual sync has no cap.) No single bug can trigger an unbounded metered-ASR bill.
- **IPC/preload changes (exact):** extend the `'download-service:get-files-to-sync'` handler payload (`download-service.ts:1030-1031`) and its preload typing (`preload/index.ts:343`, `:704`) with the optional opts; add the `ensure-baseline` channel + preload method. Fix the preload `dateCreated: Date` lie opportunistically (type as `string | Date`) but do **not** otherwise touch reconciliation.

### 5.6 Settings + Library UI

- **Transcription card** (`Settings.tsx`): provider select (Gemini | OpenAI Whisper). Gemini → existing model dropdown + key field (unchanged). Whisper → OpenAI API key field (Eye toggle, §5.4) + model select fixed to `whisper-1`.
- **New Summarization card:** provider select (Gemini | Ollama Cloud). Ollama Cloud → API key field + model picker populated via `GET https://ollama.com/api/tags` (Bearer auth) with manual text-input fallback; "Test" button = 1-token chat round-trip reporting key-valid / model-found / quota state.
- **Provider-aware preflight (new IPC `transcription:validateConfig`)** `→ { ok: boolean; problems: Array<{stage:'asr'|'summarization', provider, problem:'missing-key'|'rejected-key'}> }`. **Replaces the hardcoded Gemini-key gates in `useOperations.ts:34-43` and `:78-87`** — the Whisper+Ollama user must be able to queue/retry without a Gemini key (rev 1 blocker). Settings Test buttons reuse it.
- **Re-summarize affordance (two states):** the recording detail panel shows a "Re-summarize" action whenever a transcript row with `full_text` exists — (a) on terminal Stage-2 failure (`transcription_status='error'`) it renders as an inline notice "Summary failed — Re-summarize" alongside the visible `full_text`; (b) on a **healthy** recording it renders as a small action in the transcript section, enabling the headline model-switch scenario (AC6: "regenerate with the currently selected LLM") and giving legacy NULL-summary rows (§5.8) their recovery path. Both call `transcription:resummarize`. During Stage 2 the badge remains `processing` (unchanged mapping).
- **Aggregate failure chip (§7.3):** the Library header shows "N transcriptions failed — Retry all" when N > 0, where **N = count of `transcription_queue` rows with `status='failed'`** (not recording statuses — `processQueue` also marks recordings `'error'`, a different set). The single non-silent surface; silent ≠ invisible failures.
- Auto toggles remain on the Device page (`Device.tsx:1015-1047`). QA logging obeys `qaLogsEnabled` patterns.

### 5.7 Queue hardening

- **`addToQueue` dedupe:** skip insert when a `pending`/`processing` item exists for the `recording_id` (guards the dual-trigger races: `download-service.ts:489-503` + `recording-watcher.ts:206-214`, and resummarize-while-queued). **Return contract:** on dedupe-skip, return the **existing** item's id (callers always receive a truthy id on success — `useOperations.ts:52-56` treats falsy as failure and would otherwise toast a spurious error). The renderer queue store must register ids idempotently (upsert by id); `useOperations` tests updated accordingly (§8). Parked items (§7.2) keep `status='pending'`, so the dedupe covers them automatically.
- **Worker short-circuit:** `full_text` AND `summarization_provider` both set → complete no-op (§5.3).
- **`recordings:transcribe` re-routed:** the handler (`recording-handlers.ts:241-254`) now enqueues (`addToQueue` + `processQueueManually`) instead of calling `transcribeManually` directly — a ~3-line change that removes the mutex-bypass double-billing/row-clobbering race. `transcribeManually` remains only for tests (e2e-smoke drives it directly).

### 5.8 DB migration recipe (explicit — protects the first-launch path stabilized by commit 7a7c2b18)

1. Add `summarization_provider TEXT`, `summarization_model TEXT` to the `transcripts` CREATE TABLE in SCHEMA **and** `parked_until TEXT`, `first_parked_at TEXT` to the `transcription_queue` CREATE TABLE (for §7.2 parking) — plus a new `MIGRATIONS[v]` entry with try/catch-guarded `ALTER TABLE ADD COLUMN`s for all four (v16 pattern, `database.ts:957-963`); bump `SCHEMA_VERSION`.
2. Same migration creates `sync_baseline_files` (CREATE TABLE IF NOT EXISTS — safe both paths).
3. **Backfill** (same migration): `UPDATE transcripts SET summarization_provider='gemini', summarization_model=transcription_model WHERE full_text IS NOT NULL AND summary IS NOT NULL AND summarization_provider IS NULL`. The `summary IS NOT NULL` clause is deliberate: legacy rows where the fused analysis silently failed (the no-match path, `transcription.ts:525-534`) keep a NULL marker — they are Stage-2-resumable and recoverable via the always-available Re-summarize action (§5.6); they are NOT auto-queued. Rows with real summaries are marked complete so they don't look resumable.
4. Extend `e2e-smoke.test.ts` (the 7a7c2b18 guard) to assert all new columns exist on a fresh boot.

## 6. Data flow (end-to-end, after this design)

Plug in P1 → auto-connect → ready → ensure-baseline (first time: snapshot, stop) → `getFilesToSync(auto)` (snapshot + 4-layer filters, ≤100 files) → renderer downloads via USB (unchanged) → main saves + marks synced → auto-transcribe queues (deduped) → worker: **Whisper ASR** (always-transcode → maybe chunk) → transcript row (`full_text`) → **Ollama Cloud analysis** (+ validator) → one UPDATE (summary + stage marker) → actionables (delete-and-replace) → RAG indexing (local, unchanged) → `transcription:completed` → Library updates silently.

## 7. Failure taxonomy & recovery

### 7.1 Classification (exact strings; all added to `NON_RETRYABLE_ERRORS` where marked)

| Failure | Class | Message (verbatim) |
|---|---|---|
| Selected ASR provider key absent | non-retryable | `OpenAI API key not configured — add it in Settings → Transcription` (resp. existing Gemini string) |
| Selected LLM provider key absent | non-retryable | `Ollama Cloud API key not configured — add it in Settings → Summarization` |
| Key rejected (HTTP 401) | non-retryable | `<Provider> API key was rejected — re-enter it in Settings` (distinguishes corrupt/expired key from missing) |
| OpenAI `insufficient_quota` | non-retryable | `OpenAI quota exhausted — check billing, then Retry all` |
| Ollama model 404 | non-retryable | `Ollama Cloud model '<model>' not found — choose a new model in Settings → Summarization` |
| HTTP 429 (either provider) | **parked** (§7.2) | — |
| 429 still failing after 24 h parked | non-retryable | `<Provider> quota still exhausted after 24h — check your plan, then Retry all` |
| ASR transient failure | retryable | whole job retries (no transcript row yet) |
| Stage-2 transient / JSON-extraction failure | retryable | Stage 2 only re-runs (`full_text` preserved); throws, never writes sentinels |
| ffmpeg failure / unsupported input | non-retryable | clear error incl. ffmpeg stderr tail |
| Insufficient disk space for transcode | non-retryable | `Not enough disk space to process <file>` |
| Hung HTTP call | retryable | AbortController timeout fires (§7.4) → normal transient failure |

### 7.2 Quota parking (changes the retry machinery — scoped; state design explicit)

**State:** two new persisted `transcription_queue` columns (migration §5.8): `parked_until TEXT` (ISO) and `first_parked_at TEXT` (ISO). A parked item keeps **`status='pending'`** — no new status value, so every existing consumer behaves correctly by construction: dedupe (§5.7) covers it, startup recovery (resets `processing` only, `database.ts:3112-3120`) ignores it, and §7.3's re-pend (targets `failed`) correctly doesn't touch it.

**Transitions:** on HTTP 429 the worker calls a new `parkQueueItem(id, parkedUntil)` write that sets `status='pending'`, `parked_until = now + (Retry-After ?? 30 min)`, `first_parked_at = COALESCE(first_parked_at, now)` and **does not touch `retry_count`** (it deliberately bypasses the requeue path at `database.ts:2318-2320`, which increments). The poller's item selection adds `AND (parked_until IS NULL OR parked_until <= now)`. When a 429 arrives and `first_parked_at` is older than **24 h**, the item terminal-fails with the §7.1 quota message. `first_parked_at`/`parked_until` are cleared on any successful stage completion. Both survive app restart (the queue is persistent); the 24 h clock originates at `first_parked_at`.

(Rationale: Ollama Cloud quota windows reset on 5-hour/weekly cycles; the existing 30/60/120 s backoff burns all retries in ~4 minutes against an hours-long window.)

### 7.3 Recovery loop

- **Key-fix re-pend:** detected in the main config save path (the `config:update-section` handler) by diffing the three key fields; on change, run `UPDATE transcription_queue SET status='pending', retry_count=0, parked_until=NULL, first_parked_at=NULL WHERE status='failed' AND error_message LIKE '%<marker>%'` with the marker bound per field: `openaiApiKey → 'OpenAI'`, `ollamaCloudApiKey → 'Ollama Cloud'`, `geminiApiKey → 'Gemini API key'` (LIKE-matches both the legacy string `Gemini API key not configured. Please add your API key in Settings.` at `transcription.ts:120` and the §7.1 forms). Saving an OpenAI key therefore also re-pends `OpenAI quota exhausted` items — harmless: if quota is still exhausted they re-fail with the same message.
- **Aggregate chip + Retry-all:** chip N = failed queue rows (§5.6). **Retry-all re-pends only provider-related failures** — items whose `error_message` matches any §7.1 provider marker (`'OpenAI'`, `'Ollama Cloud'`, `'Gemini API key'`) — and deliberately excludes deterministic non-provider failures (`Recording file not found`, disk-space, ffmpeg), which would re-fail instantly and re-inflate the chip.
- AC5 names this exact mechanism.

### 7.4 Timeouts

Every new HTTP call uses AbortController: Whisper upload **10 min**, Ollama chat **5 min**. A hung call becomes a normal retryable failure instead of freezing the serial pipeline at a fake 90% (the mutex would otherwise be held until app restart; stale-lock recovery only runs at processor start, `transcription.ts:48-49`).

### 7.5 Unchanged-behavior guarantee

Existing Gemini-default configs: provider `gemini` + summarization `gemini` reproduce today's two-call flow, same prompts, same models. All existing tests must stay green.

## 8. Testing

- **Unit (Vitest, mocked `fetch`/`spawn`):** whisper-asr (always-transcode invocation, multipart shape with `verbose_json`, chunk path, ffmpeg asar path rewrite, temp-dir cleanup, disk-space guard); ollama-cloud-llm (Bearer header, `format:json`, 404/401/429 classification, timeout abort); meeting-selection validator (`'none'`, hallucinated id, string confidence); config (defaults, both-site encryption round-trip incl. cold-start decrypt, `__enc__` idempotency guard); baseline (`ensure-baseline` first-run snapshot, set-difference filtering, `auto:false` default leaves display callers untouched, null-serial skips auto-sync, 100-file cap); queue (addToQueue dedupe, worker short-circuit, stage-resume on `summarization_provider IS NULL`, resummarize keeps old summary on failure, actionables delete-and-replace, `recordings:transcribe` enqueues); failure taxonomy (429 parking doesn't touch retry_count, key-save re-pend).
- **Integration:** a second e2e-smoke variant (real in-memory sql.js + temp audio file) with provider = `openai-whisper` + summarization = `ollama-cloud`, both HTTP boundaries mocked; asserts per-stage provider/model columns, the backfill, and fresh-boot column existence.
- **Must stay green:** `download-service.test.ts` (+ b007/c004), `transcription.test.ts` (+ b007), `e2e-smoke.test.ts`, `useDownloadOrchestrator`, `useUnifiedRecordings`, `Settings.test.tsx`, `usb-smoke.test.ts`, **`useOperations` tests (updated for the preflight)**; gates `npm run typecheck && npm run lint && npm run test:run`.
- **USB:** zero real-device testing during development. AC1 is the sole physical-device criterion.

## 9. Dependencies

- `ffmpeg-static` in `apps/electron` only; electron-builder `asarUnpack: ['node_modules/ffmpeg-static/**']`; runtime path rewrite per §5.1. (Monorepo precedent: meeting-recorder, audio-capture.)
- No new packages elsewhere; `packages/*` intentionally not consumed (Approach C deferred).

## 10. Out of scope (explicit)

- Migrating the existing plaintext `geminiApiKey` to encrypted storage (pre-existing; separate fix).
- `gpt-4o-transcribe` / `-mini-transcribe` (1500 s cap + no `verbose_json` need duration-aware chunking — deferred), local Whisper (whisper.cpp), Chirp 3.
- Cross-retry chunk checkpointing (accepted v1 limitation, §5.1).
- Headless / tray-only pipeline (SPEC-004 PipelineManager).
- Adopting `packages/transcription` / `packages/ai-providers` (Approach C — future).
- Desktop notifications / digest views (user chose silent; the §7.3 chip is the only non-silent surface).
- Whisper chunk-boundary prompt continuity; speaker diarization for Whisper output.
- Queue parallelism (stays strictly sequential — provider rate-limit-friendly).

## 11. Acceptance criteria

**AC1 (the sole physical-device criterion):** with provider = `openai-whisper`, summarization = `ollama-cloud`, valid keys, app open, baseline previously established: plugging in the P1 with N new recordings results — with no user interaction — in N Library rows with status synced + transcribed, `transcription_provider='openai-whisper'`, `summarization_provider='ollama-cloud'`, non-empty `full_text` and `summary`.

Test-harness criteria (mocked device file lists / mocked HTTP):
- **AC2:** first-ever auto-sync snapshots the baseline and queues nothing; a subsequent auto-sync with added files processes only the additions; a file that failed download is retried on the next connect.
- **AC3:** manual sync reaches pre-baseline files (no baseline filtering when `auto:false`).
- **AC4:** an input transcoding to > 24 MB transcribes via the chunk path; ffmpeg path rewrite verified for the packaged layout.
- **AC5:** with the Ollama key removed mid-queue, every item still **completes Stage 1 and persists `full_text`** (per-stage checks, §5.3) before terminal-failing at Stage 2 with the §7.1 message; saving a valid key re-pends them automatically (§7.3) and they all complete **without re-running ASR**; the Library chip shows the count until then.
- **AC6:** `transcription:resummarize` — reachable from the detail panel on **both** failed and healthy recordings (§5.6) — regenerates the summary with the currently selected LLM without touching `full_text`, works when local audio is deleted, keeps the old summary if the re-run fails, does not duplicate actionables, and does not re-rename (title predicate, §5.3).
- **AC7:** existing Gemini-default configs are **behavior-identical**, with two explicit, deliberate exceptions: (a) Stage-2 JSON-extraction failure now retries/errors instead of silently completing with empty analysis (§5.3 — a bug fix); (b) nothing else. In particular, devices with prior sync history get **no baseline** (§5.5 fresh-device rule) so their auto-download behavior is unchanged; defaults resolve to gemini/gemini; all existing tests green; the config file gaining new sections on next save is expected.
- **AC8:** queueing the same recording twice produces one transcription (dedupe + short-circuit, with the truthy-id return contract §5.7); `recordings:transcribe` goes through the queue.
- **AC9:** a 429 from Ollama Cloud parks the item (`status='pending'`, `parked_until` set, `retry_count` untouched); the poller skips it until `parked_until`; parking state survives an app restart; a 429 after 24 h of parking terminal-fails with the §7.1 message.

## 12. Implementation phasing (each phase independently shippable — gemini/gemini defaults preserve behavior throughout)

| Phase | Scope | Spec sections | ACs |
|---|---|---|---|
| **P1** | DB migration + backfill; two-stage worker with Gemini-only providers; queue hardening (dedupe, short-circuit, `recordings:transcribe` re-route) | §5.3, §5.7, §5.8 | AC7, AC8 |
| **P2** | Whisper ASR (always-transcode, chunking, ffmpeg packaging) + `openaiApiKey` crypto + Transcription card + `transcription:validateConfig` preflight + `useOperations` rework | §5.1, §5.4, §5.6 | AC4 |
| **P3** | Ollama Cloud LLM + meeting-selection validator + Summarization card + resummarize IPC/panel | §5.2, §5.6 | AC6 |
| **P4** | Failure taxonomy, 429 parking, key-fix re-pend, aggregate chip | §7 | AC5, AC9 |
| **P5** | Baseline snapshot + auto-sync flow + 100-file cap | §5.5 | AC2, AC3 |
| **P6** | Integration e2e variant + the single physical AC1 check | §8 | AC1 |
