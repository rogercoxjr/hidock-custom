# Speaker Diarization ("Who Said What") — Design Spec

**Date:** 2026-06-17
**App:** `apps/electron` (universal knowledge hub)
**Goal:** Every new recording is transcribed with **speaker turns** ("Speaker A/B/C…") by a single cloud call; the user **maps each speaker to a Contact** (with inline quick-add, pre-filled from the meeting's calendar attendees); the transcript renders speaker-attributed and the summary attributes decisions/commitments to people. A **voiceprint is captured on every manual mapping** so a Phase-2 auto-ID layer launches pre-trained.

> **Relationship to the auto-pipeline spec (`2026-06-11-auto-pipeline-model-choice-design.md`):** this design **replaces the Whisper ASR path (that spec's §5.1) with AssemblyAI as the default ASR**, reusing the two-stage worker (§5.3), queue hardening (§5.7), per-stage key checks, failure taxonomy (§7), and config-encryption recipe (§5.4) **unchanged**. Whisper/Gemini remain selectable fallbacks behind the existing `AsrProvider` interface. Section references prefixed "AP-" point at that spec.

## 1. User decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Core interaction model | **Auto-split → user edits (merge/reassign) → names from Contacts** |
| Diarization source | **Dedicated cloud one-call API** (transcript + speaker turns + word timestamps in one request) |
| Provider | **AssemblyAI Universal-3 Pro** (async/batch), behind the existing `AsrProvider` interface |
| Trigger scope | **Always-on, replaces Whisper** for every new recording — one ASR path, no fork |
| Speaker naming | **Tie into the existing Contacts feature**, with **inline quick-add** in the assignment UI |
| Existing recordings | **New recordings only**; the existing "transcribe again" action re-runs diarization **after a confirmation warning** |
| v1 scope | **Core diarization + structured turns + render + attendee-prefilled mapping + attributed summaries + voiceprint *capture* hook** |
| Voiceprint *matcher* | **Phase 2** (v1 captures embeddings only; nothing reads them in v1) |
| Account tier | **Free tier** ($50 non-expiring credit ≈ ~1 yr at ~10 hr/mo) → pay-as-you-go (~$4/mo) when exhausted |
| Region | **`model_region: "global"`** (cheapest; no data-residency requirement) |
| Audio profile / language | **Varies a lot** (1:1 → larger/messy), **English only**, **batch** (background queue), **no GPU**, **managed cloud preferred** |

## 2. Hard constraints (verified)

- **AssemblyAI is async/batch**, not a single synchronous POST: **upload audio → `POST /v2/transcript` → poll `GET /v2/transcript/{id}` until `status:'completed'|'error'`.** The provider must encapsulate upload + bounded-backoff polling + terminal-state handling. This fits the existing background queue, which is already sequential and tolerant of multi-minute jobs.
- **Use `keyterms_prompt`, NOT legacy `word_boost`.** `word_boost` **silently downgrades the job to Universal-2**, losing the chosen model's accuracy. `keyterms_prompt` (up to 1000 phrases, ≤6 words each) is free and rides the same request; it is mutually exclusive with `prompt`, but `custom_spelling` can be combined.
- **AssemblyAI's own `summarization` and `auto_chapters` are deprecated** — summarization stays in the existing **Ollama-Cloud** stage (AP-§5.2). LeMUR is **not on the free tier** and is **not used** (redundant with Ollama).
- **Diarization is cross-recording-blind by design.** AssemblyAI returns per-file generic labels (Speaker A/B/C) and **no voiceprint** — cross-recording identity is a customer-side job. Voiceprint auto-ID is therefore an add-on layer, explicitly **Phase 2**.
- **Azure Speaker Recognition is RETIRED** (Speech SDK 1.47, Nov 2025) — not an option for voiceprint. The chosen embedding path is **`sherpa-onnx-node`** (Apache-2.0, prebuilt Windows x64 `.node` addon, on-device CPU, **no Python**).
- **No-GPU machine.** All v1/Phase-2 voiceprint compute runs on CPU; `sherpa-onnx` embedding extraction is a short per-recording batch step, acceptable off the critical path.
- **USB safety (CLAUDE.md):** diarization, mapping, and voiceprint all operate on **already-downloaded files**. **No USB/transfer/jensen code is touched**, and **no real-device testing** is needed for this feature — it is entirely post-download. This is the cleanest possible separation from the device-safety constraints.
- **`model_region: "global"`** is sent on every request: an in-region +10% price increase takes effect 2026-07-01; global routing keeps current pricing (the trade-off — no data-residency guarantee — is acceptable for this personal, US use case).

## 3. Current state (verified, with anchors)

The two-stage transcription pipeline this design extends already exists (see the auto-pipeline spec). Diarization-relevant anchors (file paths verified; line numbers from the 2026-06-17 codebase map, confirm during planning):

- **ASR provider interface** — `electron/main/services/asr/asr-provider.ts` (verified): `interface AsrResult { text: string; language?: string }`; `interface AsrProvider { transcribe(filePath, opts: { meetingContext?: string }): Promise<AsrResult> }`; `getAsrProvider(config)` switches on `config.transcription.provider` (`'gemini' | 'openai-whisper'`) and **throws on unknown**. Implementations: `whisper-asr.ts`, `gemini-asr.ts`.
- **Two-stage worker** — `transcription.ts` (`processQueue`, Stage 1 ASR via `getAsrProvider`, Stage 2 Ollama summary). `upsertTranscriptStage1` (~`database.ts:2279-2307`) writes ASR-only columns; `updateTranscriptStage2` (~`:2325-2362`) writes analysis columns. **Neither writes `speakers`.**
- **`transcripts` table** (~`database.ts:238-259`): `id, recording_id (UNIQUE), full_text, language (DEFAULT 'es'), summary, action_items, topics, key_points, sentiment, speakers, word_count, transcription_provider, transcription_model, title_suggestion, question_suggestions, summarization_provider, summarization_model, created_at`. **`speakers` and `sentiment` columns exist but are never populated today.**
- **Contacts** — table (~`database.ts:374-387`): `id, name NOT NULL, email, type CHECK(team|candidate|customer|external|unknown), role, company, notes, tags(JSON), first_seen_at, last_seen_at, meeting_count, created_at`. IPC (`ipc/contacts-handlers.ts`): `contacts:getAll/getById/update/delete/getForMeeting` — **there is NO `contacts:create` handler.** `upsertContact()` exists in `database.ts` (~`:2851`) but is unwired to IPC. `getContactsForMeeting(meetingId)` (~`:2920`).
- **Calendar correlation** — recordings carry `meeting_id`; meetings have attendees joined to contacts via the `meeting_contacts` junction (the `getContactsForMeeting` path) — this is the attendee-prefill source.
- **Transcript rendering** — `src/features/library/components/TranscriptViewer.tsx`: `parseTranscriptSegments` (~`:86-125`) parses `[MM:SS]`/`[HH:MM:SS]` time anchors and extracts a speaker from `"Name:"` / `"[Name]"` **text prefixes** (~`:34-48`); renders a speaker badge per segment (~`:257-261`); has playback auto-scroll + active-segment highlight (~`:146-165`) and `TimeAnchor` click-to-seek. Hosted by `SourceDetailDrawer.tsx` (Transcript interface ~`:21-38`, `speakers` field ~`:31`).
- **Re-transcribe** — `recordings:transcribe` IPC (`recording-handlers.ts` ~`:284-298`) → `addToQueue` + `processQueueManually` (re-enqueue; `upsertTranscriptStage1` overwrites Stage-1 columns). `transcription:resummarize` (~`:391-402`) clears the Stage-2 marker and re-enqueues Stage 2 only.
- **People UI** — `src/pages/People.tsx`: a **quick-add button (~`:183-191`) is currently disabled ("Coming soon")** — the natural home/source for the reusable inline quick-add.
- **Config** — `electron/main/services/config.ts`: `transcription: { provider, geminiApiKey, geminiModel, openaiApiKey (encrypted), whisperModel, autoTranscribe, language }` + `summarization: { provider, ollamaCloudApiKey (encrypted), ollamaCloudModel }`. Defaults: provider `'gemini'`, `language 'en'`. safeStorage encryption is **two hardcoded per-field sites** (encrypt in `saveConfig`, decrypt in `initializeConfig`) — both must be extended for any new key (AP-§5.4).
- **BLOB-embedding precedent** — text embeddings are stored as BLOBs in an `embeddings` table (`vector-store.ts`); voiceprint BLOBs follow the same pattern.

## 4. What this design adds / changes

1. **AssemblyAI provider** (`asr/assemblyai-asr.ts`) implementing the existing `AsrProvider`; `getAsrProvider` gains an `'assemblyai'` branch and it becomes the **default** (§6.1).
2. **`AsrResult` extended** with optional `turns: Turn[]` (structured utterances); Whisper/Gemini leave it undefined (§6.1).
3. **Config:** `transcription.provider` widened to include `'assemblyai'`; new encrypted `assemblyaiApiKey`; `assemblyaiModel` (default `'universal'`); `model_region: 'global'` (§6.2).
4. **Data model:** persist structured `turns`; fill the dormant `sentiment` column; new `recording_speakers` map table; new `voiceprints` table (§6.3).
5. **`contacts:create` IPC** wrapping `upsertContact` (gap fix) (§6.4).
6. **Speakers panel + mapping UI** with attendee pre-fill, inline quick-add, and turn edit (reassign/merge); **`TranscriptViewer` upgraded** to render from structured turns (§6.5).
7. **Speaker-attributed summaries** — feed labeled turns into the existing Ollama stage (§6.6).
8. **Voiceprint capture hook** (`voiceprint-service.ts` + `sherpa-onnx-node`) — capture-only in v1 (§6.7).
9. **Re-transcribe confirmation** for already-transcribed recordings (§6.8).

**Unchanged:** USB/jensen/download/reconciliation, the two-stage worker control flow, queue hardening, failure taxonomy & parking (AP-§5.7/§7), RAG embeddings, the Ollama summarization call itself (only its *input* changes).

## 5. AssemblyAI request shape (verified)

One async job per recording:

1. **Upload:** `POST https://api.assemblyai.com/v2/upload` (raw bytes, `Authorization: <key>`) → `{ upload_url }`. (A locally-decoded/transcoded copy may be uploaded; see §6.7 for the 16 kHz path reused by voiceprint.)
2. **Submit:** `POST /v2/transcript` with body:
   ```jsonc
   {
     "audio_url": "<upload_url>",
     "speech_model": "universal",        // Universal-3 Pro
     "model_region": "global",            // §2 — dodge the 2026-07-01 in-region bump
     "speaker_labels": true,              // +$0.02/hr — diarized utterances + per-word speaker
     "sentiment_analysis": true,          // +$0.02/hr — per-utterance sentiment → fills `sentiment`
     "keyterms_prompt": ["<contact/company/project names>"],  // FREE; NOT word_boost
     "language_code": "en"
   }
   ```
3. **Poll:** `GET /v2/transcript/{id}` until `status` is `completed` or `error`.
4. **Result fields used:** `text` (flat), `utterances: [{ speaker, start, end, text, words:[{text,start,end,speaker,confidence}], sentiment? }]`, `language_code`. Word timestamps are automatic/free.

**Speaker count:** auto-detected (default no max <2 min; 10 for 2–10 min; 30 for 10 min+). v1 does **not** send `speakers_expected`/`speaker_options` (a wrong hint causes bad splits; auto-detect suits the manual-mapping UX). Passing a `max` from the attendee count is a Phase-2 refinement.

## 6. Component design

### 6.1 AssemblyAI provider layer — `electron/main/services/asr/`

- **`asr-provider.ts`** — extend the result type, add the provider:
  ```ts
  interface Turn { speaker: string; startMs: number; endMs: number; text: string;
                   words?: Array<{ text: string; startMs: number; endMs: number }>;
                   sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' }
  interface AsrResult { text: string; language?: string; turns?: Turn[] }   // turns NEW, optional
  // getAsrProvider: add case 'assemblyai' → createAssemblyAiAsr(config); becomes the default provider
  ```
- **`assemblyai-asr.ts`** (new) — implements `transcribe(filePath, opts)`: upload → submit (§5) → poll with **bounded backoff** → map `utterances` into `Turn[]` (ms units), `text`, `language`. `keyterms_prompt` is built by the worker from contact/company/project names (capped at 1000 / ≤6 words each) and passed via `opts` (extend `opts` with `keyterms?: string[]`). AbortController timeout per HTTP call; poll cap (§8).
- **`whisper-asr.ts` / `gemini-asr.ts`** — unchanged; they simply never set `turns`. They remain selectable fallbacks.
- **Backward compatibility:** a provider that returns no `turns` flows exactly as today (flat `full_text`, no speaker UI). Only AssemblyAI lights up diarization.

### 6.2 Config schema (`config.ts`)

```ts
transcription: {
  provider: 'gemini' | 'openai-whisper' | 'assemblyai'   // widened; DEFAULT becomes 'assemblyai'
  assemblyaiApiKey: string      // NEW — safeStorage-encrypted at rest (both sites, AP-§5.4 recipe)
  assemblyaiModel: string       // NEW — default 'universal'
  // … existing gemini/openai/whisper fields retained as fallbacks
  language: string              // 'en'
}
```
- Encryption: add `transcription.assemblyaiApiKey` to **both** the encrypt list (`saveConfig`) and decrypt list (`initializeConfig`); reuse the `__enc__` idempotency guard (AP-§5.4). Unit test covers the cold-start decrypt path.
- `model_region` is a fixed `'global'` request constant (not user-configurable in v1); a one-line code comment documents the in-region swap for future data-residency needs.
- Extend the provider-aware preflight (`transcription:validateConfig`, AP-§5.6) to accept an AssemblyAI key so a diarization-only user needs no Gemini/OpenAI key.

### 6.3 Data model + migration (sql.js / SQLite)

Migration follows the AP-§5.8 recipe (SCHEMA edit **and** try/catch-guarded `ALTER`s for upgraded installs; `CREATE TABLE IF NOT EXISTS`; bump `SCHEMA_VERSION`; extend `e2e-smoke.test.ts` to assert the new columns/tables on fresh boot).

1. **Structured turns:** add **`transcripts.turns TEXT`** (JSON array of `Turn`, §6.1). The existing `speakers TEXT` holds the **distinct roster** (e.g. `["A","B","C"]` or resolved names); the existing `sentiment TEXT` is filled from per-utterance sentiment (aggregate or roster-level). Stage 1's `upsertTranscriptStage1` is extended to write `turns`, `speakers`, and (from the ASR result) `sentiment` when the provider supplies them — additively, never clobbering Stage-2 columns.
2. **Speaker→Contact map:**
   ```sql
   CREATE TABLE IF NOT EXISTS recording_speakers (
     recording_id TEXT NOT NULL,
     file_label   TEXT NOT NULL,          -- AssemblyAI's "A"/"B"/…
     contact_id   TEXT,                    -- NULL until mapped
     confidence   REAL,                    -- NULL for source='user'
     source       TEXT NOT NULL CHECK(source IN ('user','auto')) DEFAULT 'user',
     created_at   TEXT NOT NULL,
     PRIMARY KEY (recording_id, file_label)
   );
   ```
   v1 writes `source='user'` only. This table powers later "everything <person> said" queries and is the join key for attributed rendering.
3. **Voiceprints:**
   ```sql
   CREATE TABLE IF NOT EXISTS voiceprints (
     id          TEXT PRIMARY KEY,
     contact_id  TEXT NOT NULL,
     model_id    TEXT NOT NULL,            -- e.g. 'wespeaker_en_voxceleb_resnet34_LM'
     dim         INTEGER NOT NULL,
     embedding   BLOB NOT NULL,            -- Float32 little-endian, length = dim
     created_at  TEXT NOT NULL
   );
   ```
   Multiple rows per contact (robust across mics/rooms/dates). **Written by the v1 capture hook (§6.7); read by nothing in v1.** `model_id` lets a future model swap re-embed rather than mismatch across embedding spaces.

Editing (reassign/merge) = read-modify-write `transcripts.turns` JSON + update `recording_speakers`. Single user → no concurrency concern.

### 6.4 `contacts:create` IPC (gap fix)

Add a `contacts:create` channel (`contacts-handlers.ts` + preload) wrapping the existing `upsertContact()`: input `{ name, email?, role?, company?, type? }` (name required), returns the created `Person`. Reused by the inline quick-add (§6.5). Email is intentionally non-unique (existing schema), so duplicates are allowed.

### 6.5 UI — speakers panel, mapping, editing, rendering

- **Speakers panel** (in `SourceDetailDrawer.tsx`, above the transcript): lists each distinct `file_label` with turn-count / talk-time and a **Contact picker**:
  - **Pre-filled + boosted with the recording's meeting attendees** via `recording.meeting_id → getContactsForMeeting` (those contacts sorted to the top); searchable across all contacts as fallback; empty/no-meeting → plain search.
  - **Inline quick-add:** typing an unmatched name surfaces "Create contact '<name>'" → `contacts:create` → creates + assigns in one step. Built as a reusable component that also un-stubs the `People.tsx` quick-add button.
- **Rendering:** upgrade `TranscriptViewer` to consume `transcripts.turns` (structured) instead of parsing `"Name:"` text prefixes. Per turn: a **color-coded speaker badge** (mapped contact name if assigned via `recording_speakers`, else the `file_label`), the existing `TimeAnchor` (click-to-seek), and text. Preserve auto-scroll + active-segment highlight. Word timestamps additionally enable click-a-word-to-seek (cheap; may ride v1 or defer). Backward-compat: when `turns` is absent (Whisper/Gemini rows, or pre-migration rows), fall back to today's text-prefix parser.
- **Editing (v1):**
  - **Reassign a turn** — change one turn's `file_label`/contact.
  - **Merge speakers** — "Speaker C is Speaker A" → reassign all C turns to A and collapse the roster (handles diarizer over-split, common on "varies a lot" audio).
  - Naming is **only** via Contact mapping (no free-text rename).
  - **Splitting one turn into two speakers → non-goal v1.**
- Confirming a speaker→contact mapping writes `recording_speakers (source='user')` **and** fires the voiceprint capture hook (§6.7) via a new `speakers:assign` IPC.

### 6.6 Speaker-attributed summaries (existing Ollama stage)

Stage 2 builds its summarization input from `turns`, prefixing each turn with the **mapped contact name if available, else the generic `file_label`**, so summaries attribute ("Roger committed to X; Sarah flagged Y"). Because Stage 2 runs right after Stage 1 (speakers usually still unmapped), the **first** summary uses generic labels; after mapping, the user triggers the **existing `transcription:resummarize`** action to regenerate with names. **Re-summarize stays manual** (auto-on-every-mapping would repeatedly spend Ollama tokens). No new dependency — only the prompt input changes + reuse of resummarize.

### 6.7 Voiceprint capture hook — `voiceprint-service.ts` (v1 captures, never matches)

- **Dependency:** `sherpa-onnx-node` (Apache-2.0; prebuilt `sherpa-onnx-win-x64` `.node` addon via optionalDependencies — no Python, no native compile). Bundle `wespeaker_en_voxceleb_resnet34_LM.onnx` (~26.5 MB, ~0.72% EER; embedding dim ~256 — **confirm `extractor.dim` empirically** before sizing BLOBs) in app resources; lazy-init `SpeakerEmbeddingExtractor` on first use.
- **Trigger:** the new `speakers:assign` IPC (recording_id, file_label, contact_id).
- **Flow:** (1) gather that `file_label`'s turns from `transcripts.turns`; (2) locate the downloaded audio file; (3) **decode to 16 kHz mono PCM and slice the speaker's segments** — *the main implementation risk* (needs a decoder in main; reuse the ffmpeg path the auto-pipeline already bundles, AP-§5.1 / AP-§9, or `ffmpeg-static`); (4) pool the longest/cleanest **≥ ~8–10 s** of non-overlapped speech → one mean-pooled embedding; (5) if < ~8–10 s clean speech → **skip enrollment** (still save the mapping); (6) store the embedding in `voiceprints` with `model_id`/`dim`.
- **v1 = capture only.** No `SpeakerEmbeddingManager.search`/match/suggest (Phase 2). If the sherpa binary is unavailable (non-Windows / load failure) → **feature-detect and disable voiceprint gracefully**; mapping still works.

### 6.8 Re-transcribe (existing recordings)

`recordings:transcribe` is unchanged server-side (re-enqueue + overwrite). Add a **renderer confirmation dialog** before invoking it on an already-transcribed recording: "Re-transcribe with speaker detection? This replaces the current transcript." On confirm → runs the AssemblyAI path like any new recording. No bulk re-processing.

## 7. Data flow (end-to-end, after this design)

New recording downloaded (USB, unchanged) → auto-transcribe queues (deduped) → worker **Stage 1 = AssemblyAI** (upload → submit `speaker_labels`+`sentiment`+`keyterms`+`global` → poll → map `utterances`) → `upsertTranscriptStage1` writes `full_text` + `turns` + `speakers` + `sentiment` → **Stage 2 = Ollama** summary (fed labeled turns; generic labels first pass) → actionables/RAG (unchanged) → Library updates → user opens detail → **Speakers panel** (attendee-prefilled) → maps/edits speakers → each confirm writes `recording_speakers` **and** captures a voiceprint → (optional) **Re-summarize** to regenerate with names.

## 8. Error handling & edge cases

- **AssemblyAI async failures:** upload failure / job `status:'error'` / poll timeout / HTTP 429 → ride the existing queue retry with **bounded backoff** (cap retries + cap max delay; explicitly avoid the ~16401 s runaway backoff observed earlier) and the AP-§7.2 parking for 429. Distinguish transient (retry) vs terminal (mark failed + surface via the AP-§7.3 aggregate chip). Poll loop has a hard wall-clock cap.
- **Missing/invalid AssemblyAI key:** extend `validateTranscriptionConfig` (AP-§5.6) + a non-retryable "AssemblyAI API key not configured / rejected" message; key-fix re-pend (AP-§7.3) gains an `'AssemblyAI'` marker.
- **Audio file missing / not downloaded:** skip diarization + voiceprint gracefully with a clear status; don't crash the queue.
- **Voiceprint:** insufficient clean speech or decode failure → skip enrollment, keep the mapping; sherpa binary missing → disable feature (mapping still works); never block the UI on embedding compute (run it off the interaction path).
- **`contacts:create`:** name required; duplicate emails allowed (schema).
- **Edge cases:** single-speaker (1 speaker; spurious splits → user merges) · no meeting correlation (pre-fill empty → search-all) · many/variable speakers (auto-detected; UI handles N) · overlap/crosstalk (turns may mis-split → user edits; overlapped regions skipped for voiceprint).

## 9. Non-goals (v1, explicit)

- Voiceprint **matching / auto-ID / suggestions** (capture only; Phase 2).
- Mid-turn **split** of one utterance into two speakers (reassign + merge only).
- Real-time / streaming diarization.
- Accurate transcription of **simultaneous/overlapped** speech (no ASR does this well).
- Bulk re-processing of existing recordings (manual re-transcribe only).
- Free-text speaker names (names come from Contacts).
- Non-English; `speakers_expected` hinting; AssemblyAI summarization/auto_chapters/LeMUR/entity/PII/IAB (see catalog "later/skip").

## 10. Testing

TDD throughout; **mocks-first; zero real-hardware/USB tests** (feature is post-download, touches no USB code).
- **Unit (Vitest, mocked `fetch`/`spawn`):** AssemblyAI provider (upload→submit→poll(processing→completed)→`utterances`→`Turn[]` mapping; `error`/timeout/429/backoff-bound + poll-cap paths; `keyterms_prompt` build & cap; `model_region:'global'` + NOT `word_boost`); `turns`/`speakers`/`sentiment` persistence; reassign + merge mutation logic; attendee pre-fill query; `contacts:create` handler (name-required, duplicate email); voiceprint service (mock sherpa: segment pooling, ≥8–10 s gate skips weak enroll, BLOB store + `model_id`/`dim`, disable-on-missing-binary path); attributed-summary input builder (named vs generic labels); config (assemblyaiApiKey both-site encryption incl. cold-start decrypt).
- **Integration:** transcribe → store structured turns → attributed summarize, mocking AssemblyAI + Ollama; assert `turns`/`sentiment`/`recording_speakers` shape and fresh-boot migration.
- **Must stay green:** the auto-pipeline suite (`transcription.test.ts`, `e2e-smoke.test.ts`, `download-service.test.ts`, `Settings.test.tsx`, `useOperations`), plus a new `TranscriptViewer` structured-turns test. Gates: `npm run typecheck && npm run lint && npm run test:run`.

## 11. Dependencies

- **`sherpa-onnx-node`** in `apps/electron` only (prebuilt win-x64 binary via optionalDependencies; no Python). Bundle the WeSpeaker ONNX model in app resources; electron-builder `asarUnpack` for the addon + model (mirror the `ffmpeg-static` packaging precedent, AP-§9).
- **`ffmpeg-static`** — already bundled by the auto-pipeline (AP-§9); reused for the 16 kHz mono decode in §6.7.
- No new cloud SDK — AssemblyAI is plain `fetch`. No `packages/*` consumed.

## 12. Acceptance criteria

**AC0 — Validation spike (gate, §13):** a real ~30–60 min sample of the user's own recordings, run through AssemblyAI (`speaker_labels`+`sentiment`+`keyterms`, free tier), yields acceptable speaker attribution + word accuracy on the user's actual audio. If not, revisit the provider choice (e.g., the pyannoteAI two-stage ceiling) **before** building v1.

Test-harness criteria (mocked AssemblyAI/Ollama, in-memory sql.js):
- **AC1:** a new recording transcribed with provider `assemblyai` produces a `transcripts` row with non-empty `full_text`, a structured `turns` array (≥1 turn, ms timestamps, per-turn speaker), a populated `speakers` roster, and a populated `sentiment`; `transcription_provider='assemblyai'`.
- **AC2:** the Speakers panel pre-fills the Contact picker with the recording's correlated meeting attendees (top-sorted) and falls back to all-contacts search when there's no meeting; typing an unmatched name creates a contact via `contacts:create` and assigns it.
- **AC3:** reassigning a turn and merging two speakers update `transcripts.turns` + `recording_speakers` correctly; the roster collapses on merge; rendering reflects mapped contact names.
- **AC4:** confirming a mapping writes a `recording_speakers (source='user')` row **and** (given ≥ ~8–10 s clean speech) one `voiceprints` row for the contact with the correct `model_id`/`dim`; with < ~8–10 s clean speech the mapping is saved but **no** voiceprint is written; with the sherpa binary unavailable, mapping still succeeds and voiceprint is skipped.
- **AC5:** the summarization input is speaker-labeled (generic labels pre-mapping; contact names after `resummarize`), and `resummarize` regenerates without re-running AssemblyAI (`full_text`/`turns` preserved).
- **AC6:** "transcribe again" on an already-transcribed recording shows a confirmation; on confirm it re-runs the AssemblyAI path and replaces the transcript; cancel does nothing.
- **AC7:** a missing AssemblyAI key terminal-fails with a clear message and is re-pended when a valid key is saved; a 429 parks (AP-§7.2) and resumes; a poll-timeout becomes a normal retryable failure (no frozen pipeline).
- **AC8:** `word_boost` is never sent; `keyterms_prompt` and `model_region:'global'` are present on the request; a provider returning no `turns` (Whisper/Gemini) renders via the legacy path with no speaker UI (no regression).

## 13. Implementation phasing

**Task 0 — Validation spike (gate, AC0):** non-automated; uses the free tier; eyeball speaker quality + WER on the user's real recordings before committing to the build. If unacceptable → escalate to the pyannoteAI + ElevenLabs two-stage ceiling (researched alternative) and revise this spec.

**v1 (each phase independently shippable; non-AssemblyAI providers stay behavior-identical throughout):**

| Phase | Scope | Sections | ACs |
|---|---|---|---|
| **D1** | AssemblyAI provider + `AsrResult.turns` + config (`assemblyaiApiKey` crypto, default provider, `global`, `keyterms`) + preflight | §6.1, §6.2, §5 | AC1, AC7, AC8 |
| **D2** | DB migration: `turns`/`sentiment` write, `recording_speakers`, `voiceprints`; Stage-1 persistence | §6.3 | AC1 |
| **D3** | `contacts:create` IPC + Speakers panel (attendee pre-fill + inline quick-add) + turn edit (reassign/merge) + `TranscriptViewer` structured render | §6.4, §6.5 | AC2, AC3 |
| **D4** | Voiceprint capture hook (`sherpa-onnx-node`, 16 kHz decode, `speakers:assign`) — capture only | §6.7 | AC4 |
| **D5** | Attributed summaries (Ollama input) + re-transcribe confirmation | §6.6, §6.8 | AC5, AC6 |

**Phase 2 (post-v1 roadmap, not specified here):** voiceprint **auto-ID matcher** (`SpeakerEmbeddingManager.search`, two-threshold auto/suggest, calibrated on the user's confirmed mappings, attendee set as prior; small internal A/B of WeSpeaker vs TitaNet on real audio) → speaker-attributed **action-item owners** → **talk-time/participation analytics** + per-speaker sentiment display → optional `speaker_options` max hint from attendee count.
