# Speaker Diarization ("Who Said What") — Design Spec

**Date:** 2026-06-17 (rev 3 — post-adversarial-review + default-provider decision)
**App:** `apps/electron` (universal knowledge hub)
**Goal:** Every new recording is transcribed with **speaker turns** ("Speaker A/B/C…") by a single cloud call; the user **maps each speaker to a Contact** (with inline quick-add, pre-filled from the meeting's calendar attendees); the transcript renders speaker-attributed and the summary attributes decisions/commitments to people. A **voiceprint is captured on every manual mapping** so a Phase-2 auto-ID layer launches pre-trained.

> **Rev 2:** a 4-lens adversarial review (verifying against the live AssemblyAI/sherpa-onnx docs and the real `apps/electron` tree) confirmed 25 findings (5 false-positives dropped). It found **one blocker** — the rev-1 request used the singular `speech_model: "universal"`; the pre-recorded `/v2/transcript` endpoint requires the **plural `speech_models` array** with id **`universal-3-pro`** (`"universal"` is not a valid id; the singular form is streaming-only) — plus a cluster of ambiguities. Rev 2 fixes the API fact, documents the cost cap, defines the `sentiment` shape and merge/reassign/re-transcribe semantics, adds a privacy disclosure, quantifies AC0, specifies the PCM decode + concrete voiceprint gate, designs sherpa graceful-degradation, pins the migration to v26, and tightens the ACs. Every change traces to a verified finding.

> **Rev 3:** per user decision, the **default ASR provider is `assemblyai`** (not `gemini`). A missing AssemblyAI key must **fail loudly and visibly** — the preflight blocks queueing with a clear Settings prompt, and any job run without a key terminal-fails non-retryably and appears in the failure chip — and must **never silently fall back to Gemini/Whisper**. This reverses rev 2's "keep gemini default / explicit opt-in" and supersedes the AP-AC7 default-provider guarantee; Gemini/Whisper remain **manually** selectable only.

> **Relationship to the auto-pipeline spec (`2026-06-11-auto-pipeline-model-choice-design.md`):** this design **adds AssemblyAI as a selectable ASR provider** and makes it the user's chosen ASR, reusing the two-stage worker (AP-§5.3), queue hardening (AP-§5.7), per-stage key checks, failure taxonomy + parking (AP-§7), the **100-file auto-sync cap + large-manual-sync confirmation** (AP-§5.5 / AP-AC10), and the config-encryption recipe (AP-§5.4) **unchanged**. Whisper/Gemini remain selectable fallbacks behind the existing `AsrProvider` interface. Section references prefixed "AP-" point at that spec.

## 1. User decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Core interaction model | **Auto-split → user edits (merge/reassign) → names from Contacts** |
| Diarization source | **Dedicated cloud one-call API** (transcript + speaker turns + word timestamps in one request) |
| Provider | **AssemblyAI Universal-3 Pro** (async/batch), behind the existing `AsrProvider` interface |
| Trigger scope | **AssemblyAI is the default ASR; diarization is always-on for every new recording** — one ASR path, no fork. A missing key **fails loudly** (never falls back to Gemini); see §6.2/§8. |
| Speaker naming | **Tie into the existing Contacts feature**, with **inline quick-add** in the assignment UI |
| Existing recordings | **New recordings only**; the existing "transcribe again" action re-runs diarization **after a confirmation warning** |
| v1 scope | **Core diarization + structured turns + render + attendee-prefilled mapping + attributed summaries + voiceprint *capture* hook** |
| Voiceprint *matcher* | **Phase 2** (v1 captures embeddings only; nothing reads them in v1) |
| Account tier | **Free tier** ($50 non-expiring credit ≈ ~1 yr at ~10 hr/mo) → pay-as-you-go (~$4/mo) when exhausted |
| Region | **`model_region: "global"`** (cheapest; no data-residency requirement — disclosed in UI, §6.5) |
| Audio profile / language | **Varies a lot** (1:1 → larger/messy), **English only**, **batch** (background queue), **no GPU**, **managed cloud preferred** |

## 2. Hard constraints (verified against live docs)

- **AssemblyAI is async/batch:** **upload audio → `POST /v2/transcript` → poll `GET /v2/transcript/{id}` until `status:'completed'|'error'`.** The provider encapsulates upload + bounded-backoff polling (with a hard wall-clock cap) + terminal-state handling. The existing queue is sequential and multi-minute-tolerant; the cross-process mutex is held for the duration of one job — acceptable because the queue already serializes and AP-§7.4 timeouts bound a hung call.
- **Pre-recorded model selection uses `speech_models` (plural ARRAY)**, valid ids `universal-3-pro` / `universal-2`; priority-ordered with fallback. We send `["universal-3-pro","universal-2"]`. The singular `speech_model` is **streaming-only** and must never be sent here. `"universal"` is not a valid id. The response's `speech_model_used` is logged.
- **Use `keyterms_prompt`, NOT legacy `word_boost`.** `word_boost` **silently downgrades the job to Universal-2**, losing the chosen model. `keyterms_prompt` (≤1000 phrases, ≤6 words each) is free and same-request; mutually exclusive with `prompt`; `custom_spelling` may be combined.
- **AssemblyAI `auto_chapters` is deprecated; AssemblyAI `summarization` remains available but is intentionally NOT used** — summarization stays in the existing Ollama-Cloud stage (AP-§5.2). LeMUR is out of scope (redundant with Ollama; see §9).
- **Diarization is cross-recording-blind by design.** AssemblyAI returns per-file generic labels (Speaker A/B/C) and **no voiceprint** — cross-recording identity is a customer-side job, explicitly **Phase 2**.
- **Azure Speaker Recognition is RETIRED** (Speech SDK 1.47, Nov 2025). The embedding path is **`sherpa-onnx-node`** (Apache-2.0, prebuilt Windows x64 `.node` addon, on-device CPU, **no Python**).
- **Metered-cost is bounded.** Always-on diarization runs on each AUTO-synced new recording, but the **AP-§5.5 100-file auto-sync cap** gates auto-sync and the **AP-AC10 large-manual-sync confirmation** (file count + estimated size) gates manual backlogs. **Existing recordings are never auto-diarized** (re-transcribe is manual + confirmed, §6.8). No single action can trigger an unbounded AssemblyAI bill.
- **No-GPU machine.** All voiceprint compute is CPU and off the critical path.
- **USB safety (CLAUDE.md):** diarization/mapping/voiceprint all operate on **already-downloaded files**. **No USB/transfer/jensen code is touched, and no real-device testing is needed** for this feature.
- **`model_region: "global"`** is sent on every request (dodges the 2026-07-01 in-region +10%); the no-residency trade-off is **disclosed in Settings** (§6.5). A user wanting local/in-region transcription keeps Whisper/Gemini selected (no diarization).

## 3. Current state (verified, with anchors)

The two-stage transcription pipeline this design extends already exists (AP spec). Diarization-relevant anchors (verified against the tree during the rev-2 review; SCHEMA_VERSION currently **25**, no diarization tables):

- **ASR provider interface** — `electron/main/services/asr/asr-provider.ts` (verified): `interface AsrResult { text: string; language?: string }` (**no `turns`**); `interface AsrProvider { transcribe(filePath, opts: { meetingContext?: string }): Promise<AsrResult> }`; `getAsrProvider(config)` switches on `config.transcription.provider` (`'gemini' | 'openai-whisper'`, **no `'assemblyai'`**) and throws on unknown. Implementations: `whisper-asr.ts`, `gemini-asr.ts`.
- **Two-stage worker** — `transcription.ts` (Stage 1 ASR via `getAsrProvider`, Stage 2 Ollama summary). `upsertTranscriptStage1` (~`database.ts:2279-2307`) writes ASR-only columns; `updateTranscriptStage2` (~`:2325-2362`) writes analysis columns. **Neither writes `speakers`.**
- **`transcripts` table** (~`database.ts:238-259`): `id, recording_id (UNIQUE), full_text, language (DEFAULT 'es'), summary, action_items, topics, key_points, sentiment, speakers, word_count, transcription_provider, transcription_model, title_suggestion, question_suggestions, summarization_provider, summarization_model, created_at`. **`speakers` and `sentiment` exist but are never populated today.** No `turns` column.
- **Contacts** — table (~`database.ts:374-387`): `id, name NOT NULL, email, type CHECK(...), role, company, notes, tags(JSON), first_seen_at, last_seen_at, meeting_count, created_at`. IPC (`ipc/contacts-handlers.ts`): `contacts:getAll/getById/update/delete/getForMeeting` — **NO `contacts:create`** (verified: grep returns none). `upsertContact()` exists (~`database.ts:2851`) but is **unwired to IPC**. `getContactsForMeeting(meetingId)` (~`:2920`).
- **Calendar correlation** — recordings carry `meeting_id`; `meeting_contacts` junction joins meeting attendees to contacts (the `getContactsForMeeting` path) — the attendee-prefill source.
- **Transcript rendering** — `src/features/library/components/TranscriptViewer.tsx`: `parseTranscriptSegments` (~`:86-125`) parses `[MM:SS]`/`[HH:MM:SS]` anchors and a speaker from `"Name:"`/`"[Name]"` **text prefixes** (~`:34-48`); speaker badge (~`:257-261`); auto-scroll + active-segment highlight (~`:146-165`); `TimeAnchor` click-to-seek. **It does not consume structured turns today.** Hosted by `SourceDetailDrawer.tsx` (Transcript interface ~`:21-38`, `speakers` field ~`:31`).
- **Re-transcribe** — `recordings:transcribe` IPC (`recording-handlers.ts` ~`:284-298`) → `addToQueue` + `processQueueManually`; `transcription:resummarize` (~`:391-402`) clears the Stage-2 marker + re-enqueues Stage 2 only.
- **People UI** — `src/pages/People.tsx`: a **quick-add button (~`:183-191`) is disabled ("Coming soon")** — the source for the reusable inline quick-add.
- **Config** — `electron/main/services/config.ts`: `transcription: { provider, geminiApiKey, geminiModel, openaiApiKey (encrypted), whisperModel, autoTranscribe, language }` + `summarization: { provider, ollamaCloudApiKey (encrypted), ollamaCloudModel }`. Defaults (verified): provider **`'gemini'`** (rev 3 flips the default to `'assemblyai'`), `language 'en'`. `initializeConfig` does `deepMerge(DEFAULT_CONFIG, savedConfig)` — **new defaults reach existing installs**, so the flip makes a keyless install **fail loudly** rather than silently switch (see §6.2). safeStorage encryption is two hardcoded per-field sites (encrypt in `saveConfig`, decrypt in `initializeConfig`).
- **BLOB-embedding precedent** — text embeddings are BLOBs in an `embeddings` table (`vector-store.ts`); voiceprint BLOBs follow the same pattern.

## 4. What this design adds / changes

1. **AssemblyAI provider** (`asr/assemblyai-asr.ts`) implementing the existing `AsrProvider`; `getAsrProvider` gains an `'assemblyai'` branch (§6.1).
2. **`AsrResult` extended** with optional `turns: Turn[]`; Whisper/Gemini leave it undefined (§6.1).
3. **Config:** `transcription.provider` widened to include `'assemblyai'` and **defaults to `'assemblyai'`**; new encrypted `assemblyaiApiKey`; `assemblyaiModels: string[]` (default `['universal-3-pro','universal-2']`). A missing key **fails loudly with no silent fallback** (§6.2/§8).
4. **Data model (v26 migration):** `transcripts.turns`; fill `sentiment`; new `recording_speakers` + `voiceprints` tables (§6.3).
5. **`contacts:create` IPC** wrapping `upsertContact` (gap fix) (§6.4).
6. **Speakers panel + mapping UI** (attendee pre-fill, inline quick-add, reassign/merge); **`TranscriptViewer` upgraded** to render from structured turns with a legacy fallback (§6.5).
7. **Speaker-attributed summaries** + a generic-label staleness badge (§6.6).
8. **Voiceprint capture hook** (`voiceprint-service.ts` + `sherpa-onnx-node`) — capture-only in v1, with graceful degradation (§6.7).
9. **Re-transcribe confirmation** + stale-mapping handling (§6.8).
10. **Settings privacy disclosure** for cloud/global routing (§6.5).

**Unchanged:** USB/jensen/download/reconciliation, the two-stage worker control flow, queue hardening, failure taxonomy & parking, cost caps (AP-§5.5), RAG embeddings, the Ollama summarization call itself (only its *input* changes).

## 5. AssemblyAI request shape (verified)

One async job per recording:

1. **Upload:** `POST https://api.assemblyai.com/v2/upload` (bytes, `Authorization: <key>`) → `{ upload_url }`.
2. **Submit:** `POST /v2/transcript`:
   ```jsonc
   {
     "audio_url": "<upload_url>",
     "speech_models": ["universal-3-pro", "universal-2"],  // PLURAL ARRAY; never singular speech_model
     "model_region": "global",            // §2 — dodge the 2026-07-01 in-region bump
     "speaker_labels": true,              // +$0.02/hr — diarized utterances + per-word speaker
     "sentiment_analysis": true,          // +$0.02/hr — per-utterance sentiment
     "keyterms_prompt": ["<contact/company/project names, capped 1000 / ≤6 words>"],  // FREE; NOT word_boost
     "language_code": "en"
   }
   ```
3. **Poll:** `GET /v2/transcript/{id}` until `status` is `completed`/`error`; log `speech_model_used`.
4. **Result used:** `text`; `utterances: [{ speaker, start, end, text, words:[{text,start,end,speaker,confidence}], sentiment? }]` (**`start/end` are SECONDS → convert ×1000 to ms**); `sentiment_analysis_results`; `language_code`. Per-word speaker/confidence are **not preserved** in v1 (mid-turn split is a non-goal, §9).

**Speaker count:** auto-detected. v1 sends no `speakers_expected`/`speaker_options` (a wrong hint causes bad splits); passing a `max` from the attendee count is a Phase-2 refinement.

## 6. Component design

### 6.1 AssemblyAI provider layer — `electron/main/services/asr/`

- **`asr-provider.ts`** — extend the result type, add the provider:
  ```ts
  interface Turn { speaker: string; startMs: number; endMs: number; text: string;
                   words?: Array<{ text: string; startMs: number; endMs: number }>;
                   sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' }
  interface AsrResult { text: string; language?: string; turns?: Turn[] }   // turns NEW, optional
  // getAsrProvider: add case 'assemblyai' → createAssemblyAiAsr(config)
  ```
- **`assemblyai-asr.ts`** (new): upload → submit (§5) → poll (bounded backoff, hard cap) → map `utterances` into `Turn[]` (**seconds→ms ×1000**), `text`, `language`. `keyterms_prompt` built by the worker from contact/company/project names (capped 1000 / ≤6 words). AbortController per HTTP call (AP-§7.4). **`assemblyaiApiKey` is used main-side only as an `Authorization` header; never sent to the renderer; HTTP 401 logs only "AssemblyAI rejected key" (no key material).**
- **`whisper-asr.ts` / `gemini-asr.ts`** — unchanged; they never set `turns`.
- **Backward compatibility:** a provider returning no `turns` flows exactly as today (flat `full_text`, no speaker UI, §6.5 fallback). A **named regression test** asserts the worker handles `turns === undefined` without error.

### 6.2 Config schema (`config.ts`) — no silent migration

```ts
transcription: {
  provider: 'gemini' | 'openai-whisper' | 'assemblyai'   // widened; CODE DEFAULT = 'assemblyai'
  assemblyaiApiKey: string        // NEW — safeStorage-encrypted (both sites, AP-§5.4 recipe + __enc__ guard)
  assemblyaiModels: string[]      // NEW — default ['universal-3-pro','universal-2']
  // … existing gemini/openai/whisper fields retained as fallbacks
  language: string                // 'en'
}
```
- **Default provider is `'assemblyai'`** (per user decision — diarization is the intended default ASR). `deepMerge(DEFAULT_CONFIG, savedConfig)` pushes this default onto installs without an explicit `provider`; an install with no AssemblyAI key then **fails loudly** on the next transcription rather than silently using another provider — the desired behavior.
- **No silent fallback.** `getAsrProvider` selects exactly the configured provider and never substitutes another (it throws on unknown). When `provider='assemblyai'` and the key is missing/empty: (a) the `transcription:validateConfig` preflight (AP-§5.6) **blocks queueing and shows a clear "Add your AssemblyAI key in Settings → Transcription" prompt** before any files are enqueued; (b) any job that still runs without a key terminal-fails **non-retryably** (§8) and appears in the AP-§7.3 aggregate "N failed — Retry all" chip + per-row error. Gemini/Whisper remain **manually** selectable, never auto-used.
- This supersedes the AP-AC7 default-provider guarantee: transcripts already produced by Gemini/Whisper are untouched, but new transcription defaults to AssemblyAI.
- `model_region:'global'` is a fixed request constant (a code comment documents the in-region US swap for future residency needs).
- Encryption: add `transcription.assemblyaiApiKey` to **both** the encrypt (`saveConfig`) and decrypt (`initializeConfig`) lists; reuse the `__enc__` idempotency guard; unit-test the cold-start decrypt.
- Extend the `transcription:validateConfig` preflight (AP-§5.6) to accept an AssemblyAI key.

### 6.3 Data model + migration (v26)

Migration per AP-§5.8 (SCHEMA edit **and** try/catch-guarded `ALTER`s; `CREATE TABLE IF NOT EXISTS`; bump `SCHEMA_VERSION` **25 → 26**; extend `e2e-smoke.test.ts`). Downgrade is unsupported. (Coordinate the version bump with any outstanding AP `sync_baseline_meta` migration so numbers don't clash — verify which has landed at implementation time.)

1. **`transcripts.turns TEXT`** (JSON array of `Turn`, §6.1) — added via SCHEMA + guarded `ALTER` at v26. **Per-utterance sentiment lives inside `turns` (`Turn.sentiment`).** The existing **`speakers TEXT`** holds the distinct roster JSON (e.g. `["A","B","C"]`). The existing **`sentiment TEXT`** holds a **derived roster summary**: a JSON object `{ "<label>": "POSITIVE|NEUTRAL|NEGATIVE" }` of each speaker's dominant (majority) sentiment (empty `{}` when sentiment is absent). Stage 1's `upsertTranscriptStage1` is extended to write `turns`/`speakers`/`sentiment` additively when the provider supplies them — never clobbering Stage-2 columns.
2. **`recording_speakers`** (CREATE TABLE IF NOT EXISTS at v26):
   ```sql
   recording_id TEXT NOT NULL, file_label TEXT NOT NULL, contact_id TEXT,
   confidence REAL, source TEXT NOT NULL CHECK(source IN ('user','auto')) DEFAULT 'user',
   created_at TEXT NOT NULL, PRIMARY KEY (recording_id, file_label)
   ```
   v1 writes `source='user'` only. Powers later "everything <person> said" and attributed rendering.
3. **`voiceprints`** (CREATE TABLE IF NOT EXISTS at v26):
   ```sql
   id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, model_id TEXT NOT NULL,
   dim INTEGER NOT NULL, embedding BLOB NOT NULL, created_at TEXT NOT NULL
   ```
   Multiple rows per contact. Written by the v1 capture hook (§6.7); **read by nothing in v1.** `model_id` lets a future model swap re-embed.

**Edit semantics (the algorithm, not just the gesture):**
- **Reassign a turn:** set that turn's `speaker` in `transcripts.turns`; ensure a `recording_speakers` row exists for the target label.
- **Merge speaker C → A:** rewrite all `turns` with `speaker='C'` to `'A'`; **delete the `recording_speakers` row for C**; the roster drops C. Voiceprints are per-**contact**, not per-label, so none are orphaned (a contact simply accrues another embedding when A is later confirmed).
- **Re-transcribe (§6.8):** because AssemblyAI may assign different labels, **prior `recording_speakers` rows for the recording are dropped** and the user re-maps; previously-captured `voiceprints` persist on their contacts (not recording-scoped). AC3 asserts no orphaned `recording_speakers` rows and a roster consistent with `turns`.

### 6.4 `contacts:create` IPC (gap fix — sequence first in D3)

Add `contacts:create` (`contacts-handlers.ts` + preload bridge) wrapping `upsertContact()`: input `{ name, email?, role?, company?, type? }` (**name required**), returns the created `Person`; duplicate emails allowed (existing schema). Unit tests: name-required validation, duplicate-email allowance, return shape. AC2 depends on it, so it lands **before** the Speakers-panel work within D3.

### 6.5 UI — speakers panel, mapping, editing, rendering, disclosure

- **Speakers panel** (in `SourceDetailDrawer.tsx`): one row per distinct `file_label` with **turn-count** (= number of `Turn` entries for the label) and **talk-time** (= Σ`(endMs−startMs)` for the label's turns, overlaps not double-counted, shown `HH:MM:SS`), and a **Contact picker**:
  - **Pre-filled + boosted with the recording's meeting attendees** via `recording.meeting_id → getContactsForMeeting` (those sorted to top); searchable across all contacts; empty/no-meeting → plain search.
  - **Inline quick-add:** an unmatched name surfaces "Create contact '<name>'" → `contacts:create` → create + assign in one step (reusable component that also un-stubs the `People.tsx` button).
  - **Single-speaker recording:** panel renders **read-only** (no merge). **Zero-speaker (silence/music):** panel **hidden**; `turns` is `[]`, Stage 2 proceeds on `full_text`.
- **Rendering:** `TranscriptViewer` gains a **`turns?: Turn[]` prop** alongside the existing `transcript: string`. When `turns` is present → render structured: per turn a **color-coded speaker badge** (mapped contact name via `recording_speakers`, else `file_label`), `TimeAnchor` (click-to-seek), text; preserve auto-scroll + highlight; word timestamps enable click-a-word-to-seek (may ride v1 or defer). **When `turns` is absent → fall back to today's text-prefix parser** (Whisper/Gemini rows, pre-migration rows). A named regression test asserts the absent-`turns` path renders with no speaker UI.
- **Editing (v1):** **reassign a turn**; **merge speakers** (§6.3 algorithm). Naming is **only** via Contact mapping (no free-text rename). **Splitting one turn into two speakers → non-goal v1.**
- Confirming a mapping writes `recording_speakers (source='user')` **and** fires the voiceprint capture hook (§6.7) via a new `speakers:assign` IPC.
- **Privacy disclosure:** above the AssemblyAI key field in Settings (and once near the Speakers panel when AssemblyAI is active): *"Speaker detection uses AssemblyAI (cloud, global routing); recordings are uploaded for processing."* with a ToS link. An AC asserts it renders when AssemblyAI is selected.

### 6.6 Speaker-attributed summaries (existing Ollama stage) + staleness badge

Stage 2 builds its input from `turns`, prefixing each with the **mapped contact name if available, else the `file_label`**. Stage 2 runs right after Stage 1, so the **first** summary uses generic labels; after mapping, the user triggers the existing **`transcription:resummarize`** to regenerate with names — **kept manual** (auto-on-every-mapping would repeatedly spend Ollama tokens). To prevent stale generic summaries lingering: once speakers are mapped but the summary predates the mapping, show a **"Summary uses generic speaker labels — re-summarize to attribute names"** badge that **clears on successful resummarize**. No new dependency. AC5 asserts the badge appears post-mapping and clears after resummarize.

### 6.7 Voiceprint capture hook — `voiceprint-service.ts` (v1 captures, never matches)

- **Dependency:** `sherpa-onnx-node` (Apache-2.0; **version-pinned** in **`optionalDependencies`**; prebuilt `sherpa-onnx-win-x64` addon — no Python). Bundle `wespeaker_en_voxceleb_resnet34_LM.onnx` (~26.5 MB; confirm `extractor.dim` empirically — ~256 — before sizing BLOBs) in app resources (electron-builder `asarUnpack` for addon + model, mirroring `ffmpeg-static`). Lazy-init the extractor on first use.
- **Graceful degradation:** a module-level try/catch load sets `isVoiceprintAvailable()`. If the addon is missing (e.g. non-Windows, optionalDependencies no-op) → voiceprint is **silently disabled** (no error toast; one operator log line); mapping still works. AC4 asserts **both** load-success and load-failure paths.
- **Trigger:** `speakers:assign` IPC (recording_id, file_label, contact_id).
- **Flow:** (1) gather the label's turns from `transcripts.turns`; (2) locate the downloaded audio file; (3) **decode to 16 kHz mono PCM** with ffmpeg-static (`-ar 16000 -ac 1 -f pcm_s16le pipe:1`) — **note the AP Whisper path emits MP3, not PCM, so this is a distinct invocation** — slicing the label's segments; intermediates streamed/temp-cleaned after use; (4) pool **≥ 10 s** of **clean speech**, defined as Σ non-overlapped turn duration for the label, where *overlap* = the label's utterance time-ranges intersecting another label's; (5) if < 10 s clean speech → **skip enrollment** (still save the mapping); (6) store the mean-pooled embedding in `voiceprints` with `model_id`/`dim`.
- **v1 = capture only.** No `SpeakerEmbeddingManager.search`/match/suggest (Phase 2).

### 6.8 Re-transcribe (existing recordings)

`recordings:transcribe` server-side is unchanged (re-enqueue + overwrite). Add a **renderer confirmation dialog** before invoking it on an already-transcribed recording: *"Re-transcribe with speaker detection? This replaces the current transcript and its speaker mappings."* On confirm → runs the AssemblyAI path; **prior `recording_speakers` rows for the recording are dropped** (§6.3) and the user re-maps. No bulk re-processing.

## 7. Data flow (end-to-end)

New recording downloaded (USB, unchanged; ≤100 auto / confirmed manual) → auto-transcribe queues (deduped) → worker **Stage 1 = AssemblyAI** (upload → submit `speech_models`+`speaker_labels`+`sentiment`+`keyterms`+`global` → poll → map `utterances`→`Turn[]`) → `upsertTranscriptStage1` writes `full_text`+`turns`+`speakers`+`sentiment` → **Stage 2 = Ollama** summary (labeled turns; generic first pass) → actionables/RAG (unchanged) → Library → user opens detail → **Speakers panel** (attendee-prefilled) → maps/edits → each confirm writes `recording_speakers` **and** captures a voiceprint → (optional) **Re-summarize** to attribute names (staleness badge clears).

## 8. Error handling & edge cases

- **AssemblyAI async:** upload fail / `status:'error'` / poll timeout / 429 → existing queue retry with **bounded backoff** (cap retries + max delay; avoid the ~16401 s runaway) and AP-§7.2 parking for 429; hard poll wall-clock cap. Transient → retry; terminal → fail + AP-§7.3 aggregate chip.
- **Missing/invalid AssemblyAI key (loud, never silent):** the `validateTranscriptionConfig` preflight (AP-§5.6) **blocks queueing with a visible "AssemblyAI API key not configured — add it in Settings → Transcription" prompt** (never a silent Gemini fallback); a job that runs without a key terminal-fails **non-retryably** with that message via the AP-§7.3 aggregate chip + per-row error; key-fix re-pend gains an `'AssemblyAI'` marker.
- **Audio file missing / not downloaded:** skip diarization + voiceprint gracefully with a clear status; don't crash the queue.
- **Voiceprint:** insufficient clean speech (<10 s) or **ffmpeg-decode failure** → skip enrollment, keep the mapping; sherpa binary missing → feature disabled (§6.7). AC4 covers sherpa-missing **and** ffmpeg-decode-failure.
- **Zero-speaker** (silence/music): empty `turns`, Stage 2 proceeds on `full_text`, panel hidden. **Single-speaker:** panel read-only, no merge. **Non-English:** v1 sends `language_code:'en'` (English-only assumption); non-English audio degrades — accepted, no v1 validation gate; documented limitation.
- **`contacts:create`:** name required; duplicate emails allowed.

## 9. Non-goals (v1, explicit)

- Voiceprint **matching / auto-ID / suggestions** (capture only; Phase 2).
- Mid-turn **split** of one utterance into two speakers (reassign + merge only).
- Real-time / streaming diarization; non-English; `speakers_expected` hinting.
- Accurate transcription of **overlapped** speech (no ASR does this well).
- Bulk re-processing of existing recordings (manual re-transcribe only).
- Free-text speaker names (names come from Contacts).
- AssemblyAI summarization / auto_chapters / LeMUR / entity / PII / IAB (catalog "later/skip").

## 10. Testing

TDD throughout; **mocks-first; zero real-hardware/USB tests** (post-download feature, no USB code).
- **Unit (Vitest, mocked `fetch`/`spawn`):** AssemblyAI provider (upload→submit→poll→`utterances`→`Turn[]`; **asserts `speech_models` array incl. `universal-3-pro`, never singular `speech_model`, never `word_boost`**, `model_region:'global'`, `keyterms_prompt` build/cap, **seconds→ms conversion**; `error`/timeout/429/backoff-cap paths); `turns`/`speakers`/`sentiment` (roster-summary shape) persistence; reassign + **merge** mutation (roster collapse, no orphan `recording_speakers`); re-transcribe drops prior mappings; attendee pre-fill query; `contacts:create` (name-required, dup-email, shape); voiceprint (mock sherpa: ≥10 s clean-speech gate, overlap exclusion, BLOB store + `model_id`/`dim`, **load-success AND load-failure**, ffmpeg-decode-failure skip); attributed-summary input + staleness badge; config (assemblyaiApiKey both-site encryption incl. cold-start decrypt).
- **Named regression tests:** (a) worker handles `turns===undefined` (Whisper/Gemini) without error; (b) `TranscriptViewer` renders legacy text-prefix format when `turns` absent, no speaker UI; (c) `resummarize` reuses persisted `full_text`/`turns`, does **not** call AssemblyAI.
- **Integration:** transcribe → store turns → attributed summarize (mock AssemblyAI + Ollama); assert `turns`/`sentiment`/`recording_speakers` shape + fresh-boot v26 migration (e2e-smoke asserts `turns` column + `recording_speakers`/`voiceprints` tables).
- **Loud-fail / no-fallback AC:** with `provider='assemblyai'` and no key, the preflight blocks queueing with a visible Settings prompt and any forced job fails non-retryably + visibly — never substituting Gemini/Whisper (AC9).
- Gates: `npm run typecheck && npm run lint && npm run test:run`.

## 11. Dependencies

- **`sherpa-onnx-node`** (version-pinned, `optionalDependencies`) in `apps/electron` only; bundle the WeSpeaker ONNX model; `asarUnpack` the addon + model (mirror `ffmpeg-static`, AP-§9).
- **`ffmpeg-static`** — already bundled (verified `package.json`); reused for the §6.7 PCM decode (distinct `-f pcm_s16le` invocation from the Whisper MP3 path).
- No new cloud SDK — AssemblyAI is plain `fetch`. No `packages/*` consumed.

## 12. Acceptance criteria

**AC0 — Validation spike (gate, §13):** run a held-out set of **≥ 5 of the user's own recordings (≥ 30 min total, spanning 1:1 and multi-speaker)** through AssemblyAI (`speech_models:["universal-3-pro","universal-2"]` + `speaker_labels` + `sentiment` + `keyterms`, free tier). **PASS** = (a) word accuracy **≥ the current Whisper/`whisper-1` baseline on the same audio** (spot-WER on ≥2 samples), AND (b) speaker attribution coheres with the actual conversation — no phantom or merged speakers — on **≥ 4 of 5** samples, AND (c) a 16 kHz mono PCM decode of one sample succeeds (voiceprint feasibility). **Owner: the user.** A dated PASS is recorded **before D1 coding begins.** On **FAIL** → escalate to the pyannoteAI + ElevenLabs two-stage alternative and revise this spec; do **not** start D1.

Test-harness criteria (mocked AssemblyAI/Ollama, in-memory sql.js):
- **AC1:** a new recording transcribed with provider `assemblyai` yields a `transcripts` row with non-empty `full_text`, a structured `turns` array (≥1 turn, ms timestamps, per-turn speaker, optional sentiment), a `speakers` roster JSON, and a `sentiment` roster-summary JSON `{label:sentiment}`; `transcription_provider='assemblyai'`.
- **AC2:** the Speakers panel pre-fills the Contact picker with the recording's meeting attendees (top-sorted), falls back to all-contacts search with no meeting; an unmatched name creates a contact via `contacts:create` and assigns it.
- **AC3:** reassigning a turn and merging two speakers update `transcripts.turns` + `recording_speakers` per §6.3 — roster collapses on merge, **no orphaned `recording_speakers` rows**, rendering reflects mapped names; re-transcribe drops prior mappings.
- **AC4:** confirming a mapping writes `recording_speakers (source='user')` **and** (given ≥10 s clean speech) one `voiceprints` row with correct `model_id`/`dim`; <10 s clean speech → mapping saved, **no** voiceprint; ffmpeg-decode failure → mapping saved, no voiceprint; sherpa binary unavailable → mapping succeeds, voiceprint silently disabled.
- **AC5:** summary input is speaker-labeled (generic pre-map, names post-`resummarize`); the staleness badge appears once speakers are mapped over a pre-mapping summary and clears after `resummarize`; `resummarize` does not re-call AssemblyAI.
- **AC6:** "transcribe again" on an already-transcribed recording shows the confirmation; confirm re-runs AssemblyAI + replaces transcript + drops prior `recording_speakers`; cancel does nothing.
- **AC7:** a missing AssemblyAI key terminal-fails with a clear message + re-pends on key save; a 429 parks (AP-§7.2) and resumes; a poll-timeout becomes a normal retryable failure.
- **AC8:** the request body contains `speech_models` as an array including `universal-3-pro`, **never** the singular `speech_model`, **never** `word_boost`, with `model_region:'global'`; a provider returning no `turns` (Whisper/Gemini) renders via the legacy path with no speaker UI (no regression).
- **AC9 (loud-fail, no silent fallback):** with `provider='assemblyai'` and no key, the preflight blocks queueing with a visible Settings prompt, and a job forced to run terminal-fails non-retryably with the missing-key message and appears in the failure chip — it **never** falls back to Gemini/Whisper. Default provider is `'assemblyai'`; Gemini/Whisper remain manually selectable.
- **AC10 (privacy):** the cloud/global-routing disclosure renders when AssemblyAI is the selected provider.

## 13. Implementation phasing

**Task 0 — Validation spike (gate, AC0):** non-automated; free tier; the user records a dated PASS/FAIL **before D1**. On FAIL → escalate to pyannoteAI + ElevenLabs and revise.

**v1 (each phase independently shippable; default ASR is AssemblyAI; Gemini/Whisper remain manually selectable, never auto-substituted):**

| Phase | Scope | Sections | ACs |
|---|---|---|---|
| **D1** | AssemblyAI provider + `AsrResult.turns` + config (default provider `assemblyai`, `assemblyaiApiKey` crypto, `assemblyaiModels`, `global`, `keyterms`) + **loud no-key preflight (no silent fallback)** | §6.1, §6.2, §5 | AC1, AC7, AC8, AC9 |
| **D2** | v26 migration: `turns`/`sentiment` write + `recording_speakers` + `voiceprints`; Stage-1 persistence | §6.3 | AC1 |
| **D3** | `contacts:create` IPC (first) → Speakers panel (attendee pre-fill + inline quick-add) + reassign/merge + `TranscriptViewer` structured render + privacy disclosure | §6.4, §6.5 | AC2, AC3, AC10 |
| **D4** | Voiceprint capture hook (`sherpa-onnx-node`, PCM decode, `speakers:assign`, graceful degrade) — capture only | §6.7 | AC4 |
| **D5** | Attributed summaries + staleness badge + re-transcribe confirmation | §6.6, §6.8 | AC5, AC6 |

**Phase 2 (post-v1 roadmap):** voiceprint **auto-ID matcher** (`SpeakerEmbeddingManager.search`, two-threshold auto/suggest calibrated on the user's confirmed mappings, attendee set as prior; internal A/B of WeSpeaker vs TitaNet on real audio) → speaker-attributed **action-item owners** → **talk-time/participation analytics** + per-speaker sentiment display → optional `speaker_options` max hint.
