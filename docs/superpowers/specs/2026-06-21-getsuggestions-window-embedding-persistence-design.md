# Persist mixed-detection window embeddings — eliminate the repeat `getSuggestions` cost

**Status:** Design (approved approach; revised after adversarial review). Ready for implementation plan.
**Date:** 2026-06-21
**Area:** `apps/electron` — speaker matcher / voiceprint pipeline.

## Problem

`speakers:getSuggestions` calls `runMatcher(recordingId)`, whose mixed-detection step decodes
the entire (300–450 MB) recording WAV and runs ERes2Net inference per ~20 s window through a
single-child worker pool — **28–63 s per call** (measured live via CDP). This session shipped an
**in-memory** cache (`WINDOW_EMB_CACHE` in `speaker-matcher.ts`) that makes repeat calls ~0.2 s,
but it is lost on restart, so the **first call per recording per app session is still ~64 s**.

## Goal & requirement

Pay the window-embedding cost **once, ever** (not once per session). After the first computation
for a given recording state, every later open — same session **or after restart** — is a fast DB
read. The user has accepted a **one-time ~60 s wait** on the first-ever open of a recording; this
spec does **not** try to shrink that one-time cost (see Non-goals).

Success criteria:
- 2nd+ open of any recording (any session) → `getSuggestions` reads persisted embeddings, no
  decode/inference, < 1 s.
- First-ever open per recording → computes once (~60 s, acceptable), persists.
- After a **per-turn reassign / re-transcribe / merge / model change**, the affected labels'
  windows recompute (correctness preserved); suggestions never go permanently stale.
- Suggestions still reflect the **current** voiceprint set (scoring re-runs every call).

## Background — current pipeline (verified)

- `speakers:getSuggestions` (`speakers-handlers.ts:381-392`) → `embedRecordingLabels(id)` then
  `runMatcher(id)` then `getPendingSuggestions`.
- `embedRecordingLabels` (`voiceprint-service.ts:469`) is idempotent: decodes once, persists
  **per-label** embeddings to `recording_label_embeddings` under a fresh `drun_<uuid>` run id;
  returns early if non-stale rows already exist.
- `runMatcher` (`speaker-matcher.ts`) resolves the run id from the label-embedding rows, scores
  identity/merge, then **mixed detection** decodes the file *again* and embeds per-window via
  `embedLabelWindows`. The window embeddings are **not persisted** (only the in-memory cache).
- Window scoring (`perWindowIdentity`) is cheap cosine math and must re-run every call so results
  track the current voiceprints. Matching uses a centroid+best-print hybrid (`identity-matcher.ts`).
- DB is **sql.js** (SQLite/WASM): the whole DB image is serialized + written to disk on save;
  FK enforcement is **OFF** globally (`database.ts:1720`), so `ON DELETE CASCADE` is inert.

## Design (Approach A, revised)

### 1. New table + canonical schema (v31 → v32)

```sql
CREATE TABLE IF NOT EXISTS recording_window_embeddings (
  id                 TEXT PRIMARY KEY,         -- rwe_<recordingId>_<label>_<windowIndex>
  recording_id       TEXT NOT NULL,
  transcript_id      TEXT,
  diarization_run_id TEXT,                      -- stored for reference/debug, NOT the cache key
  file_label         TEXT NOT NULL,
  window_index       INTEGER NOT NULL,
  fingerprint        TEXT NOT NULL,             -- cache key; see §3
  model_id           TEXT NOT NULL,
  model_version      INTEGER NOT NULL DEFAULT 1,
  dim                INTEGER NOT NULL,
  embedding          BLOB NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rwe_recording_label
  ON recording_window_embeddings(recording_id, file_label);
```

The `CREATE TABLE`/`CREATE INDEX` go in **both** the canonical schema definition (Phase-1/Phase-4
schema, so fresh and structurally-repaired DBs have them) **and** the v32 migration (so existing
DBs gain them). Migration is additive only — no FK rebuild, no CHECK changes.
*(Adversarial findings #6, #8, #11. v32 confirmed as the correct next version — finding #12.)*

### 2. DB accessors (`database.ts`)

- `insertWindowEmbeddingsBatch(rows)` — binds a prepared statement across all rows inside **one**
  `BEGIN/COMMIT` and saves the sql.js image **once** (use the existing `runInTransaction`/`runMany`
  helpers, `database.ts:2118-2139`). Never per-row `run()`. *(Findings #4, #6, #9 — avoid the
  per-window full-DB write storm; #5, #7 — atomic all-or-nothing.)*
- `getWindowEmbeddingsForRecording(recordingId)` — returns rows for the recording grouped by
  `file_label`, ordered by `window_index`, with each label's `fingerprint`; stale `model_id`/
  `model_version` rows filtered out.
- `deleteWindowEmbeddingsForRecording(recordingId)` and
  `deleteWindowEmbeddingsForLabel(recordingId, fileLabel)`.
- Reuse `embeddingToBlob`/`blobToFloat32` (BLOB round-trip verified safe — `blobToFloat32` copies;
  finding refuted). Do **not** propagate `embeddingToBlob`'s zero-copy view assumptions.

### 3. Cache key = per-label content fingerprint (the core correctness fix)

The cache key is **not** `diarization_run_id` (the adversarial review proved that's insufficient:
a per-turn reassign via `transcripts:updateTurns` changes a label's turn membership *without*
minting a new run id — finding #1). Instead, for each label compute:

```
fingerprint(label) = sha1(JSON([
  sorted [speaker===label turns as (startMs,endMs)],
  { windowMs, hopMs, MAX_EMBED_SPEECH_MS },   // slicing params (finding #10)
  modelId, modelVersion
]))
```

This changes exactly when the label's windows would differ: turn membership edits, slicing-param
changes, or model changes. It is computed from the same `turns` + params `sliceLabelWindows` uses,
so persisted windows can never silently describe stale audio.

### 4. Compute / read flow (`speaker-matcher.ts` `getWindowEmbeddings`)

Replace the in-memory `WINDOW_EMB_CACHE` with DB-backed read-or-recompute:

1. For the recording's long labels (`clean_speech_ms ≥ 2·MIN_CLEAN_SPEECH_MS`), compute each
   label's current `fingerprint`.
2. Read persisted rows (`getWindowEmbeddingsForRecording`). A label is a **hit** iff rows exist
   for it **and** the stored fingerprint equals the current fingerprint. Otherwise it's a **miss**.
3. If every long label hits → return them (no decode, no inference).
4. If any miss → decode the file **once**, `embedLabelWindows` for the missing labels only, then in
   **one transaction**: `deleteWindowEmbeddingsForLabel` for each recomputed label + insert the new
   rows with the new fingerprint. Return the full set.
5. Always re-run `perWindowIdentity` scoring against current contacts (unchanged).

The in-memory cache is removed; the DB read (BLOB + `blobToFloat32`) is sub-millisecond.

### 5. Single-flight (whole sequence, per recording)

`getSuggestions` fires on recording-change **and** every `onChanged` edit, and two IPC calls can
overlap; the renderer token guard doesn't abort in-flight calls. A per-recording in-flight promise
map must wrap the **entire `embedRecordingLabels + runMatcher` sequence** (at the handler or via a
shared map) — not just the window embed — so two first-opens can't both decode/embed or both mint
distinct `drun_` run ids. *(Finding #2.)*

### 6. Invalidation & lifecycle

- **Per-turn reassign:** the fingerprint mismatch (§3) makes the changed labels miss → recompute.
  Belt-and-suspenders: also call `deleteWindowEmbeddingsForRecording` in the
  `transcripts:updateTurns` handler. *(Finding #1.)*
- **Re-transcribe / merge / stale-model cleanup:** wherever `deleteLabelEmbeddingsForRecording` is
  already called, add a paired `deleteWindowEmbeddingsForRecording`.
- **Recording hard-delete:** add `deleteWindowEmbeddingsForRecording` (and the currently-missing
  `deleteLabelEmbeddingsForRecording`) to the recording deletion path so window rows don't orphan
  forever — FK cascade is inert here. *(Finding #3.)*
- Voiceprint add/disable correctly does **not** invalidate windows (windows are voiceprint-invariant;
  only scoring depends on voiceprints). Stated explicitly so no spurious pairing is added.

## Components / files

- `electron/main/services/database.ts` — schema + v32 migration + 4 accessors.
- `electron/main/services/voiceprint/speaker-matcher.ts` — DB-backed `getWindowEmbeddings`,
  fingerprint helper, single-flight; remove `WINDOW_EMB_CACHE`.
- `electron/main/services/voiceprint-service.ts` — export a `labelTurnsFingerprint` helper (or
  colocate in matcher); ensure `embedLabelWindows` can report `window_index`.
- `electron/main/ipc/speakers-handlers.ts` — single-flight wrapper; paired delete in
  `transcripts:updateTurns`.
- Recording-delete path (`database.ts` `deleteRecording` / `recording-handlers.ts`) — paired deletes.

## Error handling

- Compute failure (decode/worker) → nothing committed (atomic §4.4); next call retries. Never
  persist a partial label set as a hit. *(Findings #5, #7.)*
- Worker per-window timeout (`EMBED_TIMEOUT_MS`) on a pathologically long label → that label
  yields no windows; it is simply not persisted and mixed detection skips it (existing behavior).
- `getSuggestions` already returns `[]` on any error and the panel shows speakers/turns regardless;
  the "Analyzing voices…" indicator (`SourceReader.tsx:770`) already covers the one-time wait.

## Testing

- **Matcher unit** (`speaker-matcher.test.ts`): first `runMatcher` with a long label → decode +
  `embedLabelWindows` + `insertWindowEmbeddingsBatch` each called once; second call → reads from DB,
  **no** decode/embed; a fingerprint change (edited turns / params) → recomputes only that label;
  re-score still runs each call. Update the two in-memory-cache tests added this session.
- **DB layer**: insert/get/delete round-trip; batch insert saves once; v32 migration creates the
  table+index; fresh-schema path also has them.
- **Invalidation**: editing a label's turns (`transcripts:updateTurns`) makes that label miss and
  recompute (fingerprint change); recording-delete removes window rows (no orphans).
- **Concurrency**: two overlapping `getSuggestions` for the same recording → single decode/embed.

## Non-goals (YAGNI / accepted one-time wait)

- Eager precompute during transcription; backfill sweep for existing recordings.
- Parallelizing the single-child worker pool (the real lever to cut the *one-time* cost — noted as
  a separate future option).
- Unifying the two full-file decodes (`embedRecordingLabels` + window pass). Logged as a minor wart
  (finding #14); decode is a small fraction of the inference-dominated one-time cost.

## Adversarial review → design mapping

| Finding (sev) | Addressed by |
|---|---|
| #1 stale after per-turn reassign (HIGH) | §3 fingerprint key + §6 paired delete in `updateTurns` |
| #2 single-flight too narrow (HIGH) | §5 single-flight wraps whole `embedRecordingLabels+runMatcher` |
| #3 orphans on recording delete (HIGH) | §6 paired deletes in recording-delete path |
| #4/#6/#9 per-row sql.js write storm (MED) | §2 `insertWindowEmbeddingsBatch`, one transaction, save once |
| #5/#7 partial-persist poisoning (MED) | §4.4 atomic all-or-nothing + fingerprint completeness |
| #8/#11 table/index must be canonical (MED/LOW) | §1 schema **and** migration |
| #10 slicing params not in key (LOW) | §3 params folded into fingerprint |
| #13 single-flight key vs persisted key (LOW) | §3 fingerprint is the key; single-flight keyed by recordingId |
| #14/#15/#16 scope (LOW) | Non-goals; fingerprint replaces run-id key (answers #15/#16) |
