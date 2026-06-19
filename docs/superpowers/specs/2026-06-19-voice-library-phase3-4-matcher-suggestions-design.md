# Voice Library — Phase 3-4: The Matcher + Read-only→Confirmed Suggestion UX (Sub-project B)

**Date:** 2026-06-19
**App:** `apps/electron` (universal knowledge hub)
**Status:** Implementation-level design (derived from the approved rev-2 design spec)
**Derives from:** `docs/superpowers/specs/2026-06-19-voice-library-speaker-identity-design.md` (authoritative — honor its §15 conflict hierarchy, §16 conceptual model, §17 non-goals)
**Builds on (shipped):** `docs/superpowers/plans/2026-06-19-voice-library-foundation.md` (Phase 1 — ERes2Net swap, v27 schema, DB primitives, off-thread embedding, privacy config)

> **What this sub-project is.** The auto-ID **engine** (Phases 3-4 of rev-2): given a recording's per-label ERes2Net embeddings, match each label against the contact voice library, detect over-split (merge) and within-label-mixed conditions, and surface them as **read-only, confidence-ranked suggestion chips** in the existing `SpeakersPanel`. A suggestion becomes an assignment **only on explicit user confirm** (→ existing `speakers:assign` / `speakers:merge`); dismissals persist for the **diarization run** (`diarization_run_id`, §2) that produced them — a re-transcribe mints a new run id and a stale dismissal never suppresses a fresh suggestion. **No auto-apply.** The producer for `speaker_suggestions` does not exist yet — this spec designs it.

---

## 1. Problem & scope

The P1 is a standalone recorder with no attendee list, and AssemblyAI under-counts speakers. Phase 1 shipped the foundation (ERes2Net embeddings, `recording_label_embeddings`, `voiceprints` with provenance, `speaker_suggestions` table + `insertSuggestion`/`dismissSuggestion`/`getPendingSuggestions`, `embedRecordingLabels`). Today **nothing produces suggestions** and **nothing reads `voiceprints` for matching** (`voiceprint-service.ts` is capture-only, per its header).

**In scope (this sub-project):**
1. A **matcher service** — cosine match of each label embedding against contact voiceprints/centroids, gated by a calibrated threshold **and** a margin-over-second-best → `kind='identity'` suggestions (AC5).
2. **Cluster-aware merge** suggestions — connected components of same-recording labels above a merge threshold, capped → `kind='merge'` (AC7).
3. **Mixed-label detection** — within-label window-embedding variance / two-strong-contact match → `kind='mixed'` (AC8, **not** a Q&A heuristic).
4. **Print-vs-centroid hybrid scoring** (§10) — match against a robust centroid of high-quality confirmed prints *and* top individual prints, requiring margin.
5. The **SpeakersPanel suggestion UX** — read-only chips first; user-confirmed accept (→ `speakers:assign`/`speakers:merge`) / dismiss (persists). New IPC `speakers:getSuggestions` / `speakers:dismissSuggestion`, plus a **lazy trigger** that runs `embedRecordingLabels` + the matcher when the panel opens.
6. **Conflict resolution hierarchy** (§15) applied at suggestion-generation and accept time.
7. **Re-transcribe AND merge invalidation** — a new run (re-transcribe, or a confirmed merge whose label set changed) invalidates stale embeddings + suggestions; prior **confirmed** identities are restored by **re-match**, not wiped; the user is warned (AC11). A confirmed merge explicitly drops the affected embeddings and expires stale suggestions; that drop leaves the embeddings table empty, so the next embed pass mints a fresh `diarization_run_id` on its own (read-existing-first → mint-when-empty, §5/§7.1, AC7) — it is not left to coincidence.
8. **Calibration gate** (§11/AC14) — thresholds live as **model-versioned config**; a calibration harness validates self-FAR=0 + precision/suggestion-count budgets before the constants are accepted. The Phase-0 separating threshold (~0.42-0.45 EER) is the **starting point**.

**Explicitly out of scope (deferred to sibling sub-projects / research-gated):** auto-apply of any kind (including self auto-apply); recording-type inference / adaptive probe / type→floor; the static `speaker_options` range (Phase 5); the auto re-transcribe **backstop** producer/UX (Phase 6 — this spec only produces `kind='mixed'`, which is the *evidence input* the backstop later consumes, and wires re-transcribe **invalidation**); cross-device/cloud voiceprint sharing; post-hoc splitting from labels alone. See §11.

---

## 2. Conceptual model (rev-2 §16 — held throughout)

**Label** (diarizer output for one transcript run; `recording_label_embeddings.file_label`) ≠ **speaker assignment** (label→contact for one recording; `recording_speakers`) ≠ **contact/person** (`contacts`) ≠ **voiceprint** (one embedding sample; `voiceprints`) ≠ **centroid/profile** (aggregate of a contact's prints, computed at match time, never persisted in Phase 3-4). One contact → many prints; one label → possibly many people (the mixed case); one person → many labels.

A **diarization run** (≈ "transcript version") is identified by a **`diarization_run_id`** — a fresh opaque id minted on each ASR/diarization pass. This is **not** `transcripts.id`: the shipped code keys the transcript row on `recording_id` (`id = \`trans_${recording_id}\``, `ON CONFLICT(recording_id) DO UPDATE`, `clearTranscriptForRetranscribe` updates `WHERE recording_id`), so `transcripts.id` is **constant across re-transcribes** and is useless as a version key — old and new rows would share it (rev-2 §8 specifies the version key as `diarization_run_id`, exactly for this reason). Suggestions and label embeddings are tagged with `diarization_run_id` so a re-transcribe's stale rows are detectable and so a dismissal from an *old* run never suppresses a suggestion from a *new* run (§9).

**Schema reality (verified against `database.ts`, v27).** Only **`recording_label_embeddings`** carries the `diarization_run_id` column today (schema line 297; v27 migration line 1553). **`speaker_suggestions` does NOT** — the `SCHEMA` constant (lines 312-326), the v27 migration (lines 1557-1562), and the v27 test insert (`database-v27.test.ts:109`, columns `id, recording_id, transcript_id, kind, target_label, contact_id, score, rank, status, created_at`) all define `speaker_suggestions` **without** a run-id column. `insertLabelEmbedding` already *accepts* `diarization_run_id` (but its caller `embedRecordingLabels` omits it → NULL; voiceprint-service.ts:292-297), while `insertSuggestion`'s INSERT and the `SpeakerSuggestion` interface have **neither the field nor the column behind it**. So **no producer populates a run id today, and on the suggestions side there is no column to populate.** Phase 3 therefore (a) **adds the `diarization_run_id` column to `speaker_suggestions` as a real schema change** (§5 — a SCHEMA_VERSION bump to v28 with an idempotent `ALTER TABLE`, mirrored by a Phase-2 structural-repair fallback), (b) makes `embedRecordingLabels` populate the run id on the embeddings, and (c) widens `insertSuggestion`/`SpeakerSuggestion` to carry it (§5). The entire AC11 run-scoped suppression mechanism (the `WHERE diarization_run_id=?` filter, the run-scoped suppression key, the run-id-bearing deterministic suggestion `id`, and cross-run NON-suppression) reads/writes this newly-added column — none of it works without the schema change.

---

## 3. Architecture & components

All new/changed code is **main-process + one renderer component**. Five new units, all isolated and unit-testable; the renderer reuses the existing `SpeakersPanel`. The native sherpa addon and embedding compute are untouched (Phase 1's `embedRecordingLabels` + `voiceprint-worker-pool` already run off-thread).

```
SpeakersPanel opens (renderer)
        │  speakers:getSuggestions(recordingId)   ← new IPC (lazy trigger)
        ▼
speakers-handlers.ts (main)
        │  1. ensure embeddings  → embedRecordingLabels(recordingId)  [Phase-1, made idempotent in Phase 3 — §9]
        │  2. run matcher        → runMatcher(recordingId)            [NEW unit (5)]
        │  3. return pending     → getPendingSuggestions(recordingId) [Phase-1 helper] + contact names
        ▼
speaker-matcher.ts (NEW orchestrator, unit 5)
   ├─ vector-math.ts        (1)  cosine, L2, centroid, variance — pure
   ├─ identity-matcher.ts   (2)  label→contact identity scoring (print+centroid hybrid, margin)  → kind='identity'
   ├─ merge-detector.ts     (3)  cluster-aware over-split detection                               → kind='merge'
   ├─ mixed-detector.ts     (4)  within-label variance / two-contact match                        → kind='mixed'
   └─ conflict-policy.ts    (6)  §15 hierarchy: filter/annotate before persisting suggestions
        ▼
   insertSuggestion(...)  [Phase-1 helper]  — only NEW (non-dismissed, non-conflicting) suggestions
```

### Unit (1) — `vector-math.ts` (pure helpers)

**Path:** `electron/main/services/voiceprint/vector-math.ts`
**What it does:** Pure numeric helpers shared by every matcher unit. No DB, no Electron, no I/O.
**Interface:**
```ts
export function blobToFloat32(blob: Uint8Array): Float32Array      // mirror of voiceprint-service embeddingToBlob (LE, 4B/elt)
export function l2Normalize(v: Float32Array): Float32Array          // returns a copy; zero-vector → unchanged
export function cosine(a: Float32Array, b: Float32Array): number    // assumes/forces normalized; dim-mismatch → throws (caller guards via model_id)
export function centroid(vectors: Float32Array[]): Float32Array     // mean then L2-normalize; [] → throws (callers guard on .length)
export function meanPairwiseCosine(vectors: Float32Array[]): number // intra-set cohesion (1 vector → 1.0)
export function dispersion(vectors: Float32Array[]): number         // 1 - meanPairwiseCosine; the mixed-label variance signal
```
**Dependencies:** none. **Tests:** trivially unit-testable with hand-built vectors (orthogonal → cos 0; identical → 1; opposite → -1).
**Decision:** embeddings in `recording_label_embeddings`/`voiceprints` are stored normalized by Phase-1 (`compute(stream,false)` then sliced), but the matcher **re-normalizes defensively** — cheap, and removes a hidden coupling to producer behavior.

### Unit (2) — `identity-matcher.ts`

**Path:** `electron/main/services/voiceprint/identity-matcher.ts`
**What it does:** For one label embedding, score it against every contact that has ≥1 active voiceprint, using the **print-vs-centroid hybrid** (§10), and decide identity-suggestion candidacy with **threshold + margin** (§9, AC5).
**Interface:**
```ts
export interface ContactPrints { contactId: string; isSelf: boolean; prints: Float32Array[]; qualities: number[] }
export interface IdentityScore { contactId: string; score: number; viaCentroid: boolean }
export interface IdentityResult {
  candidates: IdentityScore[]          // sorted desc by score
  best?: IdentityScore
  secondBest?: IdentityScore
  margin: number                       // best.score - (secondBest?.score ?? 0)
  decision: 'strong' | 'suggest' | 'none'
}
export function scoreLabelAgainstContacts(
  labelEmb: Float32Array,
  contacts: ContactPrints[],
  thresholds: MatchThresholds          // injected config (§10/§11), not read from disk here
): IdentityResult
```
**Hybrid scoring (§10), per contact:**
- `centroidScore = cosine(labelEmb, centroid(prints))` (skip if 0 prints).
- `bestPrintScore = max(cosine(labelEmb, p))` over individual prints, **down-weighting** low-quality/old prints by a quality factor (`q = clamp(quality_score ?? DEFAULT_Q, MIN_Q, 1)`; `effectivePrintScore = printScore * (0.7 + 0.3*q)` — a soft penalty, never a hard drop).
- `contactScore = max(centroidScore, bestEffectivePrintScore)` — centroid is robust to outliers, single-best-print rescues a contact whose centroid is dragged by a stale print (§10 "match against centroid *and* top individual prints").
- **Outlier quarantine:** a print whose cosine to the contact's centroid is `< CENTROID_OUTLIER` (default 0.25) is excluded from that contact's centroid for this match (kept in DB; the un-bank UX is Phase 4 accept-side, the persistent fix is `disableVoiceprint`).
**Decision rule (AC5):**
- `best.score ≥ MATCH_AUTO` (default 0.55) → `decision='strong'`.
- `MATCH_SUGGEST ≤ best.score < MATCH_AUTO` (default ≥0.42) → `decision='suggest'`.
- otherwise → `decision='none'`.
- **Margin gate (both strong & suggest):** require `margin ≥ MATCH_MARGIN` (default 0.06). If two contacts are within the margin (the Robyn/Tiffany case, AC10), **demote to `none`** — never emit an identity suggestion that can't disambiguate. (This is the AC10 guarantee at the matcher level; the merge guard at unit 3 is the second line.)
**`strong` vs `suggest`:** both produce a `kind='identity'` suggestion in Phase 3-4 (read-only chip; user confirms). The distinction is carried in `score`/`rank` and a `rationale` tag (`"strong"`/`"likely"`) for the chip's wording and for the future research-gated self auto-apply. **No auto-apply here.**
**Dependencies:** unit (1). **No DB** — caller passes resolved `ContactPrints`. Fully unit-testable.

### Unit (3) — `merge-detector.ts`

**Path:** `electron/main/services/voiceprint/merge-detector.ts`
**What it does:** Detect **over-split** — two+ labels in the *same* recording that are actually one voice — via cluster-aware connected components (rev-2 §7, AC7).
**Interface:**
```ts
export interface LabelVec { fileLabel: string; emb: Float32Array }
export interface MergeCluster { labels: string[]; minPairCosine: number; representative: string }
export function detectMergeClusters(
  labels: LabelVec[],
  thresholds: MatchThresholds,
  identityByLabel: Map<string, IdentityResult>  // to apply the §7 "two different confirmed contacts" guard
): MergeCluster[]
```
**Algorithm:** union-find over all label pairs with `cosine ≥ MERGE_THRESHOLD` (default 0.62 — deliberately **above** `MATCH_SUGGEST`: merging two labels is higher-confidence than identifying a person, and Phase-0 showed same-person over-split fragments ~0.9). Each connected component of size ≥2 is one `MergeCluster`. `representative` = the label with the most clean-speech ms (resolved by the caller from `clean_speech_ms`; passed in via `LabelVec` order = clean-speech-desc). Solo over-split (rev-2 §9/AC9) is naturally caught here — two fragments of one voice cluster and collapse.
**Guard (§7 / §15.3):** never emit a cluster that would merge two labels whose `IdentityResult.decision==='strong'` point at **different** contacts. Such a cluster is **split**: drop the cross-contact edges, re-run union-find on the survivors. This is the AC10 second line (two similar but distinct voices are not merge-suggested).
**Cap (§9 budget):** sort clusters by `minPairCosine` desc; emit at most `MAX_MERGE_SUGGESTIONS` (default 5). Overflow is dropped silently (the panel's "N other speakers" handling is renderer-side, §7).
**Dependencies:** unit (1). Pure given inputs. Unit-testable with synthetic label vectors.

### Unit (4) — `mixed-detector.ts`

**Path:** `electron/main/services/voiceprint/mixed-detector.ts`
**What it does:** Flag a label that contains **two people** (the under-split bug that re-transcribe later fixes), via **within-label window-embedding variance** OR **two-different-contact match across time-slices** (rev-2 §7, AC8 — explicitly **not** the dropped Q&A heuristic).
**Interface:**
```ts
export interface WindowedLabel { fileLabel: string; windowEmbs: Float32Array[] }  // per-time-window embeddings of ONE label
export interface MixedFlag { fileLabel: string; reason: 'variance' | 'two-contact'; dispersion: number; contactA?: string; contactB?: string }
export function detectMixedLabels(
  windowed: WindowedLabel[],
  perWindowIdentity: Map<string, IdentityScore[][]>,  // fileLabel → per-window scored candidates (Signal B input)
  thresholds: MatchThresholds
): MixedFlag[]
```
`perWindowIdentity` maps a `fileLabel` to an array (one entry **per window**, parallel to that label's `WindowedLabel.windowEmbs`) of that window's scored identity candidates (`IdentityScore[]`, sorted desc — the per-window analogue of `IdentityResult.candidates`). **The producer is the orchestrator (unit 5), not unit 4** — unit 4 stays pure and only reads this map. If a label has no entry (no contacts with prints, or windowing was skipped), Signal B is simply unavailable for it and detection falls back to Signal A. See unit 5 step 6 for exactly how the orchestrator builds it.
**Signal A — variance:** `dispersion(windowEmbs) ≥ MIXED_DISPERSION` (default 0.35). One speaker's windows cohere (~low dispersion); two speakers in one label spread.
**Signal B — two-contact:** for a label whose `perWindowIdentity` entry exists, take each window's **top** candidate; if two windows' top candidates name **different** contacts and **each** window's top score `≥ MATCH_SUGGEST`, flag `reason='two-contact'` and record the two contact ids (`contactA`/`contactB`) in the flag + rationale. (A label whose every window's top contact agrees — or whose windows don't clear `MATCH_SUGGEST` — is NOT two-contact-flagged; Signal A may still flag it on variance alone.)
**Window embeddings:** Phase 1's `embedRecordingLabels` produces **one** embedding per label via `pcmToFloat32(pcm, turns, label)`, which **concatenates the label's turn samples into a single Float32Array** (verified `voiceprint-service.ts:174-188` — it iterates `turns`, keeps only `t.speaker === label`, and emits one flat sample array; it slices by the label's **turns**, NOT by fixed time windows). Unit (4) needs **windowed** embeddings: several Float32 chunks per label, each covering a fixed wall-clock span of that label's clean speech, so dispersion across chunks can reveal a label that contains two voices. `pcmToFloat32` cannot produce these — its output is a single contiguous chunk with the turn boundaries already dissolved. So the spec does **NOT** reuse `pcmToFloat32`'s turn slicing.

**Decision — add a NEW, concrete, unit-testable window-slicing helper.** Two cooperating functions in `voiceprint-service.ts`:

```ts
/**
 * Pure window slicer (NO ffmpeg, NO sherpa — unit-testable with a synthetic Buffer).
 * Takes the recording's full 16 kHz s16le mono PCM (the same Buffer decodeRecordingPcm16k
 * returns) and the label's turns, and emits fixed-duration Float32 windows over ONLY this
 * label's turn time-ranges. It walks the label's turns in time order, accumulates the
 * label's clean PCM samples into a running buffer (reusing the exact BYTES_PER_MS=32,
 * readInt16LE/32768, and MAX_EMBED_SPEECH_MS cap conventions pcmToFloat32 already uses for
 * a single chunk — sharing the constants, NOT the single-chunk concat behavior), and cuts a
 * new Float32Array every `windowSamples` with `hopSamples` advance. A trailing partial
 * window shorter than `minWindowSamples` (default = windowSamples/2) is dropped (too little
 * audio to embed reliably). Returns [] when the label has < minWindowSamples total.
 *
 * Inputs are fully concrete and synthesizable in a test: build a Buffer of known Int16LE
 * values and a turns[] array; assert the returned chunk count, each chunk length, and that
 * sample N maps to the expected PCM offset (offset = floor(turnStartMs*32) + intra-turn index).
 */
export function sliceLabelWindows(
  pcm: Buffer,
  turns: Turn[],
  label: string,
  windowMs = 20_000,
  hopMs = 10_000
): Float32Array[]
//   windowSamples = (windowMs/1000)*16000 ; hopSamples = (hopMs/1000)*16000
//   Output: one Float32Array per window, each of length windowSamples (except a kept tail
//   ≥ minWindowSamples). Total samples considered is capped at MAX_EMBED_SPEECH_MS (60 s)
//   exactly as pcmToFloat32, so a long label yields a bounded window count.

/**
 * Off-thread embedder wrapping sliceLabelWindows. decodes ONCE via decodeRecordingPcm16k
 * (or accepts a pre-decoded Buffer the matcher already has in hand to avoid a second spawn),
 * slices windows, and embeds EACH window through embedSamples (the same worker-pool primitive
 * captureVoiceprint/embedRecordingLabels use). Returns one Float32 EMBEDDING per window.
 * Never throws (decode/embed failure → returns [] so mixed-detection is simply skipped).
 * Windows are NOT persisted (transient, mixed-detection only — no schema row).
 */
export async function embedLabelWindows(
  recordingId: string,
  label: string,
  opts?: { pcm?: Buffer; windowMs?: number; hopMs?: number }
): Promise<Float32Array[]>
//   1. pcm = opts.pcm ?? await decodeRecordingPcm16k(recording.file_path)   (reuse if matcher passes it)
//   2. windows = sliceLabelWindows(pcm, turns, label, windowMs, hopMs)
//   3. for each window: emb = await embedSamples(modelPath(), 16000, window); push if non-null
//   4. return Float32Array[]  (the WindowedLabel.windowEmbs unit (4) consumes)
```

Only invoked for labels with `clean_speech_ms ≥ 2*MIN_CLEAN_SPEECH_MS` (a single short label can't be mixed-flagged reliably — it would yield ≤1 window; YAGNI). See §9 cost note.

**Why two functions:** `sliceLabelWindows` is **pure** (Buffer + turns → Float32Array[]) and unit-testable with hand-built PCM — no ffmpeg, no sherpa, no DB. `embedLabelWindows` is the thin off-thread wrapper that decodes + embeds. This mirrors the existing `pcmToFloat32` (pure, exported for tests) / `captureVoiceprint` (orchestrator) split already in the module, and makes Fix-1's claim concrete instead of borrowing `pcmToFloat32`'s incompatible single-chunk turn slicing.
**Dependencies:** unit (1); both helpers live in `voiceprint-service.ts` (so all sherpa/ffmpeg stays in one module). `sliceLabelWindows` is unit-testable directly on a synthetic `Buffer`; unit (4) is testable by injecting synthetic `windowEmbs`.

### Unit (5) — `speaker-matcher.ts` (orchestrator)

**Path:** `electron/main/services/voiceprint/speaker-matcher.ts`
**What it does:** The only unit that touches the DB. Loads label embeddings + contact prints, calls units (2)/(3)/(4), applies conflict policy (6), and writes `speaker_suggestions`. Idempotent and re-runnable.
**Interface:**
```ts
export interface MatchSummary { identity: number; merge: number; mixed: number; skippedModelMismatch: number }
export async function runMatcher(recordingId: string): Promise<MatchSummary>
```
**Flow:**
1. `if (!getConfig().privacy.enableVoiceprintCapture) return zero-summary` (the master gate, §14 — recognition disabled means no matching).
2. Load `getLabelEmbeddingsForRecording(recordingId)`; the active model is `VOICEPRINT_MODEL_ID`. **Drop** any row whose `model_id !== VOICEPRINT_MODEL_ID` (AC4) — counted in `skippedModelMismatch`, never compared. **Resolve the current `diarization_run_id`** from the surviving rows (the handler's just-completed `embedRecordingLabels` stamped them all with the same fresh run id, §5). If the rows somehow carry no run id (legacy/empty), the matcher treats it as a single anonymous run for this pass and logs — staleness suppression then degrades to recording-scoped, which is safe (it can only over-suppress within one recording, never across re-transcribes, because there are no run-id-bearing prior rows to confuse it with).
3. Load contacts-with-prints: new DB helper `getContactsWithActiveVoiceprints()` (§5). For each, build `ContactPrints` (active prints only, via `getActiveVoiceprintsByContactId`, qualities from each print's `quality_score` — see §5 / §13 for the widened `Voiceprint` interface that surfaces this column). Mark `isSelf` from `getSelfContactId()`.
4. For each label: `scoreLabelAgainstContacts(labelEmb, contacts, thresholds)` → `IdentityResult`. Build `identityByLabel: Map<fileLabel, IdentityResult>`.
5. `detectMergeClusters(labelVecs, thresholds, identityByLabel)`.
6. **Mixed detection — the orchestrator BUILDS both inputs (this is the Signal-B wiring; unit 4 has no DB/embed access and cannot produce `perWindowIdentity` itself):**
   - Select only labels with `clean_speech_ms ≥ 2*MIN_CLEAN_SPEECH_MS` (from each `LabelEmbedding.clean_speech_ms`); short labels are skipped entirely (no window, no mixed flag).
   - Decode the recording's PCM **once** (`decodeRecordingPcm16k`) and reuse it across labels by passing it into `embedLabelWindows(recordingId, label, { pcm })`, avoiding one ffmpeg spawn per label.
   - For each selected `label`: `windowEmbs = await embedLabelWindows(recordingId, label, { pcm })` → push `{ fileLabel: label, windowEmbs }` into `windowed: WindowedLabel[]`.
   - **Build `perWindowIdentity`:** for that same label, score **each** window embedding against the already-loaded `contacts: ContactPrints[]` — reuse unit (2): `scoreLabelAgainstContacts(windowEmb, contacts, thresholds).candidates` gives that window's `IdentityScore[]`. Collect them in window order into `IdentityScore[][]` and set `perWindowIdentity.set(label, perWindowScores)`. (Same contact set, same hybrid scoring as step 4 — only the input vector changes from the whole-label embedding to each window's embedding. This is the data Signal B consumes; without this loop Signal B has no producer and silently never fires.)
   - `detectMixedLabels(windowed, perWindowIdentity, thresholds)` → `MixedFlag[]`. (If `contacts` is empty, `perWindowIdentity` entries are all-empty candidate lists → Signal B is inert and only Signal A (variance) can flag — correct for an empty library.)
7. `applyConflictPolicy(...)` (unit 6) filters/annotates.
8. **Reconcile with existing state** (idempotency, §9): the matcher is called with the **current** `diarization_run_id` (resolved by the handler from the freshly-embedded labels — every `recording_label_embeddings` row for this run carries it). Delete the recording's prior **pending** suggestions **for this same `diarization_run_id`** (`status='pending' AND diarization_run_id = ?`), but **never** resurrect ones already `dismissed`/`accepted` *for this run* — re-checking against `getPendingSuggestions` is insufficient; the query must also see dismissed rows. **Decision:** add `getSuggestionsForRecording(recordingId, diarizationRunId)` (all statuses, scoped to the run) so the matcher can suppress regenerating a *same-run* dismissed suggestion (AC7 "dismissals persist for the diarization run"). Suppression key = `(kind, target_label, target_label_2, contact_id)`, **scoped to the run** — a dismissal from a *prior* run (which was already hard-`expired` by `expireSuggestionsForRecording` at re-transcribe, §5) carries a different `diarization_run_id` and so can never suppress a new run's suggestion. This closes the AC11 hole: an old dismissal does not silently swallow the same-key suggestion after a re-transcribe.
9. Insert surviving NEW suggestions via `insertSuggestion`, passing the resolved `diarization_run_id` so each row is tagged with the run that produced it, with deterministic `id` (incorporating the run id — see §9 collision note), `rank` (identity-strong < identity-likely < merge < mixed, then score desc), and a human `rationale`.
**Dependencies:** units (1)(2)(3)(4)(6); `database.ts` helpers; `voiceprint-service.ts` (`embedRecordingLabels` ensure-step is done by the *handler* before calling `runMatcher`, so `runMatcher` stays embed-agnostic and unit-testable with mocked DB).
**Never throws** (wraps body in try/catch → logs + returns the partial summary) so a panel-open never errors the UI.

### Unit (6) — `conflict-policy.ts`

**Path:** `electron/main/services/voiceprint/conflict-policy.ts`
**What it does:** Apply rev-2 §15 deterministically *before* suggestions are persisted, and tag the high-friction ones.
**Interface:**
```ts
export interface PolicyInput {
  recordingId: string; diarizationRunId: string | null   // the current run; stamped onto every NewSuggestion
  identities: Array<{ fileLabel: string; result: IdentityResult }>
  merges: MergeCluster[]
  mixed: MixedFlag[]
  existingAssignments: Map<string, { contactId: string; source: string }>  // recording_speakers, by label
  dismissedKeys: Set<string>
  selfContactId: string | null
}
export interface PreparedSuggestions { suggestions: NewSuggestion[] }  // NewSuggestion ⊃ SpeakerSuggestion + requiresWarning flag carried in rationale
export function applyConflictPolicy(input: PolicyInput): PreparedSuggestions
```
**Rules (§15):**
1. **Manual assignment wins** — a label already in `recording_speakers` with `source='user'` gets **no** identity suggestion (the user spoke). It can still appear as a merge `representative`/member only if its mapping is preserved.
2. **Confirmed > provisional** — a label assigned via `source IN ('confirmed','suggestion_confirmed')` is likewise not re-suggested for identity unless the new top contact **differs and** is strong (then emit a low-rank "looks more like X" identity suggestion, never auto-applied).
3. **Cross-contact merge warning** — a merge cluster spanning two labels assigned to two **different** contacts is tagged `requiresWarning` in the rationale (`"merges <ContactA> and <ContactB>"`); the renderer renders it gated, never one-tap (AC7). (Unit 3 already drops the *strong* cross-contact case; this catches the user-assigned cross-contact case.)
4. **Re-transcribe** is handled at invalidation time (§9), not here.
5. **Multiple labels → self** — if ≥2 labels strong-match the self contact, emit a single `kind='merge'` self-merge suggestion (representative = longest clean label), **not** N identity suggestions to self (§15.5). Down-stream this is a normal user-confirmed merge.
6. **Never train on provisional** — informational; banking lives in the accept path (§7), policy just never marks an auto-bank.
**Dismissed suppression:** any prepared suggestion whose key ∈ `dismissedKeys` is dropped.
**Dependencies:** none beyond the input types. Pure → unit-testable.

---

## 4. Data flow

```
USER opens SourceReader/SourceDetailDrawer → SpeakersPanel mounts
   │
   ├─ (existing) speakers:getForRecording → assignedNames
   └─ (NEW) speakers:getSuggestions(recordingId)
         │  handler:
         │    1. embedRecordingLabels(recordingId)        # Phase-3 idempotency fix — see §9 (NOT idempotent as shipped)
         │    2. runMatcher(recordingId)                  # writes new pending suggestions
         │    3. rows = getPendingSuggestions(recordingId)
         │    4. resolve contact names (getContactById) for identity/merge rows
         │  → Result<SuggestionView[]>
   ▼
SpeakersPanel renders read-only chips under each label row:
   identity:  "Looks like Robyn (likely)"   [Confirm] [Dismiss]
   merge:     "A & C may be the same voice"  [Confirm merge] [Dismiss]
   mixed:     "B may contain two voices"      [Dismiss]   (no confirm — informational; backstop is Phase 6)
   │
   ├─ Confirm identity  → speakers:assign({recordingId,fileLabel,contactId, source:'suggestion_confirmed'})
   │                       then speakers:dismissSuggestion(id) marks it accepted (resolved)
   ├─ Confirm merge     → speakers:merge({recordingId, fromLabel, toLabel})  (+ warning dialog if requiresWarning)
   │                       then mark accepted
   └─ Dismiss           → speakers:dismissSuggestion(id)  → status='dismissed' (persists for this diarization run)
   │
   └─ onChanged() → host refetches turns + assignedNames + suggestions (existing refreshSpeakers, extended)
```

**Re-transcribe flow (AC11):**
```
recordings:transcribe (existing) on an already-transcribed recording:
   clearTranscriptForRetranscribe(id) + deleteRecordingSpeakersForRecording(id)   # existing
   + (NEW) deleteLabelEmbeddingsForRecording(id)                                   # stale embeddings
   + (NEW) expireSuggestionsForRecording(id)                                       # stale suggestions → status='expired'
   ...new ASR/diarization pass:
        - write new turns + new labels (existing Stage-1 upsert)...
        - the embeddings table is now EMPTY for this recording (the deleteLabelEmbeddingsForRecording
          above cleared the prior-run rows); under option (b) the fresh run id is NOT minted here
          (there is no recordings.diarization_run_id column to persist it onto) — it is minted by the
          next embedRecordingLabels when it finds the table empty (see §5 resolution order).
          (Under option (a): mint a FRESH drun_${randomUUID()} here and persist it to
           recordings.diarization_run_id — the §2 version key; do NOT reuse transcripts.id, which is constant.)
   next SpeakersPanel open → embedRecordingLabels (fresh) → runMatcher
        → embedRecordingLabels finds the empty table, mints a fresh drun_${randomUUID()}, and stamps
          every recording_label_embeddings row of this pass with it (option (b)); or reads the new id
          off recordings.diarization_run_id (option (a)) — see §5 "Run-id source"
        → runMatcher reads that run id off the embeddings, tags its suggestions with it
        → prior confirmed identities are RE-MATCHED against the still-banked voiceprints
          (the user's confirmed prints survive — voiceprints are per-contact, not dropped)
        → high-confidence re-matches surface as strong identity suggestions on the NEW labels
        → a prior run's dismissal of the same key carries the OLD run id (already expired),
          so it does NOT suppress the new run's suggestion (AC11 hole closed)
   renderer shows a one-line banner: "Re-transcribed — speaker labels were re-lettered;
   confirm the suggested identities below." (AC11 "user is warned")
```
**Decision (no silent re-application):** rev-2 §15.4 says old assignments are *re-matched, not migrated by label name*, and Phase 3-4 forbids auto-apply. So "prior confirmed identities are restored by re-match" is realized as **strong, pre-selected identity suggestions** the user confirms — not a silent write. This satisfies AC11 ("restored by re-match, not wiped") while honoring "no auto-apply." Banked voiceprints are the durable memory that makes the re-match trivially one-tap.

---

## 5. New IPC endpoints + preload bridge + DB helpers

### IPC (in `speakers-handlers.ts`)

```ts
// speakers:getSuggestions — lazy trigger + read. Embeds (idempotent per §9 Phase-3 fix) then matches then returns.
ipcMain.handle('speakers:getSuggestions', async (_, recordingId: unknown): Promise<Result<SuggestionView[]>> => { ... })

// speakers:dismissSuggestion — persist a dismissal (AC7).
ipcMain.handle('speakers:dismissSuggestion', async (_, suggestionId: unknown): Promise<Result<{ id: string }>> => { ... })

// speakers:acceptSuggestion — convenience: marks a suggestion accepted AFTER the renderer
// has already called speakers:assign/merge. Keeps the suggestion lifecycle in one place.
ipcMain.handle('speakers:acceptSuggestion', async (_, suggestionId: unknown): Promise<Result<{ id: string }>> => { ... })

// speakers:setSelf — "this label IS the already-marked self contact" (rev-2 §10 self-enroll, AC6).
// DEPENDS ON sub-project A: A OWNS the self-contact primitive (contacts:setSelf, getSelfContactId,
// the "This is me" PersonDetail control, is_self exposure). B does NOT define, create, or set the
// self contact. B only RESOLVES it via A's getSelfContactId() and, when one exists, assigns the
// label to it + banks the self print:
//   1. selfContactId = getSelfContactId()            (A's primitive — the single source of truth)
//   2. if (selfContactId === null) return success({ selfAssigned:false, needsSelfContact:true })
//        → the renderer surfaces "Mark a contact as Me first" pointing at A's PersonDetail
//          "This is me" control. B NEVER silently creates/sets a self contact (that is A's job).
//   3. assign the label to selfContactId with source='confirmed' (a self mapping is a confirmed
//        identity, not a guess) via the same internal assign path speakers:assign uses.
//   4. EXPLICITLY bank the self print: captureVoiceprint(recordingId, fileLabel, selfContactId, 'self').
//        CRITICAL: captureVoiceprint is NOT fired by the assign write — upsertRecordingSpeaker does
//        not trigger it; only the speakers:assign handler's setImmediate hook does
//        (speakers-handlers.ts:105-111). A setSelf that only calls upsertRecordingSpeaker would
//        silently NEVER enroll the self print, breaking AC6 ("mark me once enrolls"). So setSelf
//        MUST invoke captureVoiceprint itself, gated by the same §7 banking gates (clean-speech,
//        not-suspected-mixed, consistency). See §7.
ipcMain.handle('speakers:setSelf', async (_, request: unknown): Promise<Result<{ selfAssigned: boolean; needsSelfContact?: boolean; contactId?: string }>> => { ... })
```
**Dependency on sub-project A (explicit, FINAL).** `getSelfContactId()` is the only self-contact read B performs, and it is provided by A's lane (the helper already exists at `database.ts:2946`; A surfaces it through `contacts:getSelf` + the "This is me" UI). B issues **no** `setSelfContact`/`is_self` write and ships **no** "This is me" control — those are A's. If A has not shipped (no contact is `is_self`), B's `speakers:setSelf` returns `needsSelfContact:true` and the renderer routes the user to A's control rather than inventing a self contact. This removes the duplicate self-contact definition the earlier draft carried.

**`SuggestionView`** (returned shape — flattens the DB row + resolved names for the renderer):
```ts
interface SuggestionView {
  id: string
  kind: 'identity' | 'merge' | 'mixed'
  targetLabel: string
  targetLabel2?: string | null
  contactId?: string | null
  contactName?: string | null          // resolved via getContactById
  contactName2?: string | null         // for cross-contact merge warnings
  score: number | null
  rank: number | null
  rationale: string | null             // human string; carries "strong"/"likely"/"requiresWarning"
  requiresWarning: boolean             // derived from rationale tag — drives the merge warning dialog
}
```
**`speakers:getSuggestions` handler body:** validate (zod `z.string().min(1)`) → `embedRecordingLabels(recordingId)` (await; never throws) → `runMatcher(recordingId)` → map `getPendingSuggestions` rows to `SuggestionView` (resolve names; drop `kind='backstop'` — not produced here). Wrapped in try/catch → `success([])` on any failure (a panel must never break on suggestions). **Note:** `embedRecordingLabels` + `runMatcher` are bounded but can take a few seconds on first open of a long recording; the handler returns once and the renderer shows a "Analyzing voices…" spinner. Re-open is fast (embeddings persisted; matcher suppresses already-dismissed).

### Preload (`electron/preload/index.ts`, extend the existing `speakers` block)

```ts
speakers: {
  assign: (request) => callIPC('speakers:assign', request),
  merge: (request) => callIPC('speakers:merge', request),
  getForRecording: (recordingId) => callIPC('speakers:getForRecording', recordingId),
  getSuggestions: (recordingId) => callIPC('speakers:getSuggestions', recordingId),     // NEW
  dismissSuggestion: (id) => callIPC('speakers:dismissSuggestion', id),                 // NEW
  acceptSuggestion: (id) => callIPC('speakers:acceptSuggestion', id),                   // NEW
  setSelf: (request) => callIPC('speakers:setSelf', request)                            // NEW
}
```
**`speakers:assign` extension:** add an optional `source` to `AssignSpeakerSchema` (`z.enum(['user','confirmed','suggestion_confirmed','self_auto']).optional().default('user')`) so a suggestion-confirm writes `source='suggestion_confirmed'` (the v27 CHECK already accepts it). Backward compatible — existing callers omit it and get `'user'`.

### New DB helpers (`database.ts`)

```ts
// Enumerate contacts that have ≥1 ACTIVE voiceprint of the current model — the matcher's contact set.
export function getContactsWithActiveVoiceprints(modelId: string): Array<{ contact_id: string }>
//   SELECT DISTINCT contact_id FROM voiceprints WHERE disabled_at IS NULL AND model_id = ?

// All suggestions for a recording (ANY status), scoped to a diarization run — lets the matcher
// suppress same-run dismissed/accepted keys without bleeding across re-transcribes (AC7/AC11).
// diarizationRunId is REQUIRED-by-convention from the matcher; the optional ?? form is for callers
// that legitimately want every run (e.g. diagnostics). When provided it filters WHERE diarization_run_id = ?.
export function getSuggestionsForRecording(recordingId: string, diarizationRunId?: string | null): SpeakerSuggestion[]

// Re-transcribe invalidation (AC11): mark every pending/accepted suggestion of a recording 'expired'.
export function expireSuggestionsForRecording(recordingId: string): void
//   UPDATE speaker_suggestions SET status='expired', resolved_at=? WHERE recording_id=? AND status IN ('pending','accepted')

// Mark a suggestion accepted (the accept path; distinct from dismiss).
export function acceptSuggestion(id: string): void
//   UPDATE speaker_suggestions SET status='accepted', resolved_at=? WHERE id=?
```

**`Voiceprint` interface + read query — ALREADY WIDENED BY SUB-PROJECT A; B only DEPENDS on it (no duplicate code change here).** The shipped `Voiceprint` interface was only `{ id, contact_id, model_id, dim, embedding, created_at }` (database.ts:2874-2881) even though the table carries provenance/quality columns (schema lines 282-289), so `getActiveVoiceprintsByContactId`'s `SELECT *` returned `quality_score`/`created_from` at runtime but they were **invisible at the type layer**. **Sub-project A (A §3.7, `docs/superpowers/specs/2026-06-19-voice-library-phase2-manual-identity-design.md`) has ALREADY widened the interface** to surface the provenance/quality fields as optional. Because A runs first (A → B → C, sequential), by the time B lands the interface is:
```ts
export interface Voiceprint {
  id: string; contact_id: string; model_id: string; dim: number; embedding: Uint8Array; created_at: string
  // provenance/quality — added by A §3.7 (already columns; surfaced to the reader):
  source_recording_id?: string | null; source_label?: string | null
  clean_speech_ms?: number | null; quality_score?: number | null
  model_version?: number | null
  created_from?: 'manual' | 'confirmed' | 'self' | 'import' | null
  disabled_at?: string | null; superseded_by?: string | null
}
```
`getActiveVoiceprintsByContactId` keeps its `SELECT *` (A's change is type-only; the columns already came back at runtime). **B does NOT re-widen this interface** — it is not in B's modify list. B simply **consumes** the already-widened type: §3 unit (2) reads `quality_score` (the `quality_score ?? DEFAULT_Q` down-weight and the outlier-quarantine) and `created_from` (provenance-aware weighting) directly off each print, relying on A having made them type-visible.

**`insertVoiceprint`'s INSERT — ALSO ALREADY WIDENED BY SUB-PROJECT A; B only DEPENDS on it.** The shipped `insertVoiceprint(vp: Omit<Voiceprint,'created_at'>)` wrote only the 6 base columns (database.ts:2883-2889). **A §3.7 has ALREADY widened both the accepted input type** (it widens automatically once A widens `Voiceprint`, since it is `Omit<Voiceprint,'created_at'>`) **and the INSERT column list/VALUES** to write `source_recording_id, source_label, clean_speech_ms, quality_score, model_version, created_from` (NULL/`'manual'` defaults preserve A's existing callers — A banks `created_from='manual'` for assign, `'self'` for self-enroll). **This is A's code change, not B's** — B does NOT re-widen the INSERT. B only depends on it being there so that B's `captureVoiceprint(...,createdFrom)` (§7) can pass its provenance through an `insertVoiceprint` that already accepts it. (A widens it; B consumes it.)

**Run-id source (how `embedRecordingLabels` learns the current `diarization_run_id`).** `embedRecordingLabels` currently stamps embeddings with `transcript_id: transcript?.id` and **omits** `diarization_run_id` (voiceprint-service.ts:292-297 → NULL). Phase 3 makes it populate the run id. Source of the value, in order of preference: (a) the ASR/diarization pass that wrote the turns persists its freshly-minted `diarizationRunId` on the `recordings` row (a small `recordings.diarization_run_id` column — the one schema add this sub-project needs; or reuse an existing run-metadata column if AC1's instrumentation already added one) and `embedRecordingLabels` reads it; (b) if no such column exists yet, `embedRecordingLabels` derives the run id itself from the embeddings table — **reuse-existing-first, mint-only-when-empty** (see resolution order below) — deriving freshness from the fact that a re-transcribe/merge drop (`deleteLabelEmbeddingsForRecording`) cleared the prior pass's rows, so a fresh embed pass after a clear necessarily mints a new id, while a re-open with rows still present reuses the id already on those rows. Option (a) is preferred (the run id is then identical between turns, embeddings, and suggestions); option (b) avoids adding a `recordings.diarization_run_id` column and is sufficient for staleness because all three consumers (embeddings, suppression query, suggestion rows) read the id off the embeddings, not off the transcript.

**Decision: ship (b)** unless AC1 instrumentation already persists a run id, to avoid the *recordings*-side schema add; revisit if a shared run id across turns/embeddings becomes needed.

**Run-id resolution order under option (b) — REQUIRED, read-existing-first (consistent with §9 Issue-2 short-circuit and §7.1 merge invalidation).** Because under (b) there is **no** external anchor column to hold "the current run id" (it lives only on the embedding rows themselves), `embedRecordingLabels` MUST resolve the run id by reading existing rows first, NOT by minting unconditionally:
  1. **If `getLabelEmbeddingsForRecording(recordingId)` returns ≥1 row:** REUSE that row's `diarization_run_id` (every row of a pass shares one id) and **short-circuit — do NOT mint, do NOT re-embed.** This is the re-open fast path; it is the *only* way the §9 step-2 short-circuit can ever match (a freshly-minted random UUID could never equal the id already on pre-existing rows, so an unconditional "mint per pass" would make that short-circuit dead code and force a full ffmpeg decode + N sherpa computes on **every** panel open — silently regressing the very first-open-latency fix §9 promises).
  2. **Only if the table is empty for this recording** (the post-re-transcribe / post-merge state, where `deleteLabelEmbeddingsForRecording` already cleared all prior-run rows): mint a fresh `drun_${randomUUID()}`, stamp every label row of this new pass with it, and embed. Emptiness — produced solely by the upstream row deletion — is what guarantees a new id after a re-transcribe or merge; the deletion, not any separate "mint" instruction elsewhere, is the source of freshness.

This makes "ship (b)" a **read-existing-first** rule, not an unconditional "mint once per pass." The earlier "mint once per (recording, turns-content) embedding pass" phrasing is dropped: it contradicted the §9 short-circuit and would have re-paid first-open latency on every open.

**Note:** option (b) does **not** make this sub-project migration-free — the `speaker_suggestions.diarization_run_id` column (below) is required regardless of run-id source, because the suppression query and suggestion rows live on that table. The choice between (a) and (b) only governs whether a *second* column (`recordings.diarization_run_id`) is added. **If you instead adopt option (a)** (add `recordings.diarization_run_id`), the run id becomes an external anchor that both the §9 short-circuit and the §7.1 merge-handler mint can read/write coherently, and the read-existing-first ordering above is unnecessary — but then this "Decision: ship (b)" line must be flipped to ship (a) and the §7.1 step-3 "mint" becomes a real write to that column.

### Schema change — `speaker_suggestions.diarization_run_id` (REAL migration, v28)

> **Migration ownership (sequencing A → B → C):** **v28 is owned by sub-project B** (this `speaker_suggestions.diarization_run_id` add); the next sub-project **C takes v29**. A added no migration (it widens types/INSERTs over v27 columns that already exist), so B is the first post-v27 `SCHEMA_VERSION` bump.

**`recording_label_embeddings` already has the column** (schema line 297; v27 migration line 1553) — no change there. **`speaker_suggestions` does NOT** (schema lines 312-326; v27 migration lines 1557-1562; v27 test insert at `database-v27.test.ts:109` carries no run id). The earlier "no migration — v27 already has the column on both tables" claim was **false for `speaker_suggestions`** and is dropped. Adding the column is a **real schema change**, done in the two ways `database.ts` already adds columns:

1. **Bump `SCHEMA_VERSION` 27 → 28** (database.ts:11) and add `MIGRATIONS[28]` with an **idempotent** add (guard on `PRAGMA table_info`, since sql.js `ALTER TABLE … ADD COLUMN` lacks `IF NOT EXISTS`):
   ```ts
   // MIGRATIONS[28] — speaker_suggestions.diarization_run_id (Phase 3-4)
   const cols = database.exec("PRAGMA table_info(speaker_suggestions)")
   const names = cols.length && cols[0].values ? cols[0].values.map(c => c[1]) : []
   if (!names.includes('diarization_run_id')) {
     database.run('ALTER TABLE speaker_suggestions ADD COLUMN diarization_run_id TEXT')
   }
   ```
   Also add the column to the fresh-DB `SCHEMA` `CREATE TABLE speaker_suggestions` (so new installs get it directly), exactly as v27 did for `recording_label_embeddings`.
2. **Phase-2 structural-repair fallback (defense in depth):** add a `speaker_suggestions` block to the Phase-2 boot repair (database.ts:1655+, alongside the existing `recordings`/`knowledge_captures` PRAGMA-then-`ALTER ADD COLUMN` repairs) that force-adds `diarization_run_id TEXT` if missing — so a DB that somehow skips the v28 migration still gets the column on next boot. (`recording_label_embeddings` needs no such repair; it already has the column.)

A **migration test** asserts `PRAGMA table_info(speaker_suggestions)` contains `diarization_run_id` after init (mirroring the existing v27 column assertions), and that `insertSuggestion` round-trips the run id.

### Interface/writer widenings (the column now exists; the TS layer + INSERT must use it)
- `SpeakerSuggestion`'s `status` field is added to the existing interface (currently omits it, database.ts:2918-2922) so `getSuggestionsForRecording` can carry it, and a `diarization_run_id` field is added to the interface so suppression can read it.
- `insertSuggestion`'s INSERT (database.ts:2923-2928) currently writes columns `(id, recording_id, transcript_id, kind, target_label, target_label_2, contact_id, score, rank, rationale, status, created_at)` — it must also write `diarization_run_id` (add it to the column list + VALUES + the `SpeakerSuggestion` input type) so the matcher can tag each suggestion with its run. `getSuggestionsForRecording` then filters `WHERE recording_id = ? AND diarization_run_id = ?` when a run id is supplied.

---

## 6. New/modified renderer components

### `SpeakersPanel.tsx` (modified — the only renderer change)

Add a **read-only suggestions layer** and confirm/dismiss/self-enroll, reusing the existing assign/merge plumbing.

- **New props:** `suggestions?: SuggestionView[]` (fetched by the host, mirroring `assignedNames`), and the panel calls `window.electronAPI.speakers.dismissSuggestion/acceptSuggestion/setSelf`.
- **Per-label chips:** under each label row (after the `→ name` display), render the label's pending suggestions:
  - **identity** (`contactName` present): chip `Looks like {contactName} ({strong→"match"|likely→"likely"})` + `[Confirm]` `[Dismiss]`. Confirm → `assign(label, contactId, 'suggestion_confirmed')` then `acceptSuggestion(id)`; Dismiss → `dismissSuggestion(id)`. Pre-selected styling for `strong` (rev-2 §10/AC6 "suggested, not auto-applied" — *pre-selected* = visually emphasized, still requires the click).
  - **merge** (`targetLabel`+`targetLabel2`): chip `{A} & {B} may be one voice` + `[Confirm merge]` `[Dismiss]`. If `requiresWarning`, Confirm opens a confirm dialog (`"This merges {contactName} and {contactName2} into one speaker. Continue?"`, AC7/§15.3) before calling `mergeInto`.
  - **mixed:** chip `{label} may contain two voices` + `[Dismiss]` only. **No confirm** in Phase 3-4 (the re-transcribe backstop that acts on it is Phase 6). It is read-only evidence (AC8).
- **Self-enroll (depends on sub-project A):** a small `This is me` action on each label row → `speakers.setSelf({ recordingId, fileLabel })` then `onChanged()` (AC6). The handler resolves self via A's `getSelfContactId()` (B never sets self). Two outcomes the panel renders: (a) a self contact exists → the label is assigned to it (`source='confirmed'`) and the self print banked; (b) **no** self contact yet (`needsSelfContact:true`) → the panel shows a non-destructive prompt **"Mark a contact as Me first"** that deep-links to A's PersonDetail "This is me" control (`contacts:setSelf`), rather than silently creating a self contact. The "This is me" / `is_self` UI itself is **A's**, not duplicated here — B only consumes the result.
- **Read-only-first:** even on a single-speaker recording (`readOnly` today hides merge/reassign), **identity** suggestions and **self-enroll** still render (a solo recording is exactly where "mark as me" matters). Merge/mixed chips are naturally absent for one label.
- **Budget (§9):** show at most `MAX_VISIBLE_SUGGESTIONS_PER_LABEL` (2) identity chips per label; a `Dismiss all suggestions` affordance at the panel header dismisses every pending suggestion (loops `dismissSuggestion`).
- **`onChanged`** continues to drive the host refetch; the host's `refreshSpeakers` is extended to also call `speakers.getSuggestions`.

### Host wiring (`SourceReader.tsx` + `SourceDetailDrawer.tsx`)

- Extend the existing `refreshSpeakers` (`SourceReader.tsx:146`) to fetch suggestions alongside turns + names (`Promise.all([... , api.speakers.getSuggestions(recordingId)])`), store in `suggestions` state, pass to `SpeakersPanel`. Same defensive guards (`if (!api?.speakers?.getSuggestions) skip`) so unit tests with a partial `electronAPI` don't break.
- `SourceDetailDrawer.tsx` (line ~128, ~405) mirrors the same addition.
- **Re-transcribe banner:** when `transcripts.getByRecordingId` returns a transcript whose labels have no embeddings yet but suggestions were recently expired — *simplest reliable signal:* the host already re-renders after a transcribe; show the banner whenever `suggestions` is empty AND there exist unassigned multi-labels AND a fresh-analysis spinner just completed. **Decision:** keep it simple — show a dismissible info banner `"Re-analyzed speakers after re-transcription — confirm the suggestions below."` whenever a `getSuggestions` call returns identity suggestions for a recording that has zero `source='confirmed'` rows but did before (tracked via a `wasConfirmed` flag the host derives from the previous `assignedNames`). This is a UX nicety; the hard AC11 guarantee (invalidate + re-match, not wipe) is enforced in main.

---

## 7. Banking on accept (rev-2 §6/§10 — wired, not new engine)

> **Ratified decisions (FINAL — not subject to further confirmation; mirror sub-project A §3.1/§10):**
> 1. **Banking policy — bank on the FIRST clean assignment.** A confirmed identity (`created_from='manual'`) banks a print on the **first** clean assignment; the system does **NOT** require ≥2 recordings before banking. The corroboration signal is a **derived "remembered from N recordings" count** (distinct `source_recording_id`, surfaced in A's Voices tab) — it is a display signal, never a gate on the first bank. The matcher (this sub-project) weights by print count at match time, so blocking the first bank would only strand a usable print. A self-enroll bank follows the same rule with `created_from='self'`.
> 2. **At-rest encryption of the embedding BLOB — DEFERRED (documented follow-up).** The Phase-2 privacy posture stands: voiceprints are **local-only + renderer-isolated (no BLOB ever crosses IPC) + excluded-from-backup (`excludeVoiceprintsFromBackup` defaults `true`)**. At-rest BLOB encryption is explicitly out of scope and tracked as a follow-up; it is not an open question.

**Baseline — what sub-project A has ALREADY done to `captureVoiceprint` (B builds ON this, not on the shipped original).** Because the sub-projects land sequentially (A → B → C), by the time B is implemented `captureVoiceprint` is **A's version**, not the shipped 3-arg/6-column original. Specifically, **A §3.1/§3.7 has ALREADY:**
- **Kept the 3-arg signature `captureVoiceprint(recordingId, fileLabel, contactId)`** but changed its return from a bare boolean to a **rich `CaptureResult`** — `{ captured: boolean; voiceprintId?: string; cleanSpeechMs?: number; reason?: CaptureSkipReason }` where `CaptureSkipReason` is the discriminated enum (`'voiceprint-disabled' | 'voiceprint-unavailable' | 'no-audio-file' | 'insufficient-clean-speech' | 'no-samples' | 'decode-failed' | 'embedding-failed'`). The caller (`speakers:assign` setImmediate) reports outcome to the renderer via the `voiceprint:captured` push event.
- **Made `insertVoiceprint` write provenance** with `created_from` **defaulting to `'manual'`** (A's manual-bank path), plus `source_recording_id`, `source_label`, `clean_speech_ms`, `quality_score`, `model_version` — the §5 widening, which is **A's** code change.
- **Applied the non-matcher banking gate** inside `captureVoiceprint`: bank only when (a) the privacy toggle is on and (b) `cleanSpeechMs ≥ MIN_CLEAN_SPEECH_MS`. A left the embedding-comparison clause as a typed hook (`shouldBankGivenExisting` returning `true`) for B to fill in.

**B's change is ADDITIVE on A's version — do NOT re-derive from the shipped original.** B threads a 4th parameter and inserts its two banking gates **into A's `captureVoiceprint` body**:

1. **Add a 4th param `createdFrom` (default `'manual'`).** B extends A's 3-arg signature to `captureVoiceprint(recordingId, fileLabel, contactId, createdFrom: 'manual' | 'confirmed' | 'self' = 'manual')`. The **default stays `'manual'`** precisely to preserve A's manual-bank path (any of A's callers that don't pass the 4th arg still bank `'manual'`, unchanged). The value B passes is reconciled to **A's `created_from` union** `'manual' | 'confirmed' | 'self' | 'import'` (§5): the suggestion-confirm path passes **`'confirmed'`**, the self-enroll path passes **`'self'`** (see the `speakers:assign` block below and the self-enroll paragraph). `insertVoiceprint` already accepts and writes `created_from` (A's widening, §5) — B only chooses which value to thread in.
2. **Insert B's two banking gates INTO A's body** (small, isolated additions to the function A already shipped), satisfying §10 "not suspected-mixed + consistent":
   - **Not suspected-mixed:** before banking, check whether a `kind='mixed'` suggestion exists for `(recordingId, fileLabel)` (pending or accepted) → if so, **skip banking** (a new `reason: 'label suspected mixed'` added to A's `CaptureSkipReason` enum). The mapping still succeeds (label→contact for this recording), but no print is learned (rev-2 §10 "never train on a mixed label").
   - **Consistency:** this is the implementation of A's deferred `shouldBankGivenExisting` hook. If the contact already has ≥1 active print, require `cosine(newEmb, centroid(existingPrints)) ≥ BANK_CONSISTENCY` (default 0.35, well below MATCH to allow legitimate within-person spread) → else **bank-but-flag** (mark `quality_score` low / `status` for review) rather than refuse, so a genuinely-variable voice still grows its library; the centroid's outlier quarantine (unit 2) protects matching.

So B does **not** re-add provenance writing or the clean-speech/privacy gate (those are A's, already in the body) — B only adds the `createdFrom` param, the two new gates, and the one new `CaptureSkipReason` member. The **identity-confirm path** keeps firing `captureVoiceprint` from the `speakers:assign` `setImmediate` hook (A's rewritten block — see below), now passing `createdFrom='confirmed'` on the suggestion-confirm route.

**The `speakers:assign` `setImmediate(captureVoiceprint)` block — ALREADY REWRITTEN BY SUB-PROJECT A; B threads `createdFrom` into A's call, does NOT rewrite the block.** The shipped block (`speakers-handlers.ts:105-111`) just fired `captureVoiceprint` unconditionally and `console.log`'d the result. **Sub-project A (A §3.4/§3.6) has ALREADY rewritten this block** to:
- **compute `priorContactId` synchronously BEFORE the `upsertRecordingSpeaker` overwrite** (`getRecordingSpeaker(recordingId, fileLabel)?.contact_id`),
- **auto-purge the prior contact's stranded prints on a genuine reassign** (when `priorContactId !== contactId`) via `deleteVoiceprintsBySource(recordingId, fileLabel, priorContactId)`, run synchronously before the deferred capture so the wrong-attribution biometric is gone before the new print lands,
- **emit the `voiceprint:captured` push event** (with `purgedPriorContactId`/`purgedCount`) inside the `.then`, guarded by `mainWindow && !mainWindow.isDestroyed()`.

**B's only change to this block is to thread `createdFrom` into A's `captureVoiceprint` call** — it does **not** re-derive the block from the shipped original, and it does not touch A's priorContactId/auto-purge/event logic. The assign path passes **`'confirmed'`** when the assignment `source === 'suggestion_confirmed'` (a user-confirmed identity suggestion is a confirmed identity), and otherwise **`'manual'`** (preserving A's default for a plain manual assign). Concretely B widens A's call from `captureVoiceprint(recordingId, fileLabel, contactId)` to `captureVoiceprint(recordingId, fileLabel, contactId, source === 'suggestion_confirmed' ? 'confirmed' : 'manual')` inside A's existing `setImmediate`. (The self-enroll path is the `speakers:setSelf` handler, which invokes `captureVoiceprint(..., 'self')` explicitly — see below — not this assign block.)

**Self-enroll resolves self via sub-project A, then banks explicitly (Issue: the assign write does NOT fire capture).** **The self contact is owned by A.** `speakers:setSelf` does NOT create or set a self contact — it calls A's `getSelfContactId()` (the single source of truth; `database.ts:2946`). If it returns `null`, the handler returns `needsSelfContact:true` and **no** assign/bank happens — the renderer routes the user to A's "This is me" PersonDetail control (§6). Only when `getSelfContactId()` resolves a `selfContactId` does B assign the label to it and bank.

Once `selfContactId` is resolved, the bank must be **explicit**: `captureVoiceprint` is fired **only** by the `speakers:assign` handler's `setImmediate` hook — **not** by `upsertRecordingSpeaker`. So `speakers:setSelf`, which assigns the label directly, would **silently never enroll the self print** and break AC6 ("mark me once enrolls"). Therefore `speakers:setSelf` **must explicitly invoke** `captureVoiceprint(recordingId, fileLabel, selfContactId, 'self')` after its assign write (or delegate to the same internal capture path `speakers:assign` uses). The §7 banking gates **run on the self path too** — clean-speech ≥ `MIN_CLEAN_SPEECH_MS`, not-suspected-mixed, and consistency — so a short or mixed self label is mapped-but-not-banked exactly like any other confirmation (rev-2 §10 "self-enrollment subject to the same gates"). `source='confirmed'` is written to `recording_speakers` for the self assignment (a self mapping is a confirmed identity, not a guess), while `created_from='self'` distinguishes the *voiceprint's* provenance. **B writes no `is_self` and ships no "This is me" UI — the duplicate self-contact definition from the earlier draft is removed; the primitive lives entirely in A** (spec A `docs/superpowers/specs/2026-06-19-voice-library-phase2-manual-identity-design.md` §3.3/§3.10).

The **un-bank** control (AC12) is the existing `disableVoiceprint`/`deleteVoiceprint` (Phase 1) surfaced on the contact (that UI is Phase 2's lane — this sub-project only ensures the provenance (`source_recording_id`, `source_label`) is written so a specific print is identifiable).

### 7.1 Merge invalidates affected embeddings + suggestions (AC7 — explicit handler change)

AC7 (rev-2 §18) requires that a confirmed merge **"invalidates/recomputes affected embeddings."** This does **not** happen for free. The shipped `speakers:merge` handler (speakers-handlers.ts:130-177) only calls `updateTranscriptTurns` + (conditional) `upsertRecordingSpeaker` + `deleteRecordingSpeaker` — it touches **neither** `recording_label_embeddings` **nor** `speaker_suggestions`. After a confirmed merge, the `fromLabel` no longer exists in turns, but its stale `recording_label_embeddings` row persists, and (per the Issue-2 fix, `embedRecordingLabels` short-circuits when fresh rows already exist for the run) the next matcher run would **still see the phantom `fromLabel`** and re-emit a merge/identity suggestion for a label the user already merged away. The user-confirmed merge would "invalidate" nothing.

**Fix — modify the `speakers:merge` handler** (added to the §13 modify manifest). After step 1 rewrites the turns and before returning, add:
1. `deleteLabelEmbeddingsForRecording(recordingId)` — drop the now-stale per-label embeddings (the merged label set is structurally different; a scoped delete of just `fromLabel` is insufficient because `toLabel`'s embedding must also be recomputed from the union of turns).
2. `expireSuggestionsForRecording(recordingId)` — expire the pending/accepted suggestions of the **old** label set so a phantom-`fromLabel` suggestion can't survive.
3. **Force a fresh run id via the row deletion in step 1 — do NOT separately "mint" one here.** Under option (b) there is no `recordings.diarization_run_id` column to persist a minted id onto, and the merge handler does not call `embedRecordingLabels` itself, so a literal "mint a run id in the merge handler" instruction would be a no-op dead instruction. The freshness comes **solely** from step 1's `deleteLabelEmbeddingsForRecording(recordingId)`: it leaves the embeddings table empty, so the next `embedRecordingLabels` (per the §5 read-existing-first resolution order / §9 Issue-2 freshness check) finds no rows, falls through to its mint-when-empty branch, and stamps the post-merge label set with a freshly-minted `drun_${randomUUID()}`; the next `runMatcher` then tags its suggestions with that new id, so run-scoped suppression cannot mismatch against the pre-merge run's (now-expired) rows. (Under option (a), step 3 *does* become a real write: assign a fresh `drun_${randomUUID()}` to `recordings.diarization_run_id` so the next embed pass reads the new anchor.)

This makes "merge invalidates affected embeddings" a concrete, tested handler change rather than the earlier hand-wave ("a merge rewrites turns → labels change → matcher re-runs on next open"). A **merge-invalidation test** (extend `speakers-handlers.test.ts`) asserts the merge handler calls `deleteLabelEmbeddingsForRecording` + `expireSuggestionsForRecording` and that the post-merge matcher run produces no `fromLabel` suggestion. The same invalidation applies whether the merge originated from a user tap or from confirming a `kind='merge'` suggestion (both route through `speakers:merge`).

---

## 8. Calibration (rev-2 §11 / AC14) — config + harness, no auto-apply ships without it

**Thresholds as model-versioned config** (`config.ts`, new `voiceMatching` section, defaults = Phase-0 starting points):
```ts
interface MatchThresholds {
  modelId: string            // must equal VOICEPRINT_MODEL_ID or thresholds are treated as uncalibrated
  matchSuggest: number       // 0.42
  matchAuto: number          // 0.55
  matchMargin: number        // 0.06
  mergeThreshold: number     // 0.62
  mixedDispersion: number    // 0.35
  centroidOutlier: number    // 0.25
  bankConsistency: number    // 0.35
  maxMergeSuggestions: number // 5
  calibrated: boolean        // false until the harness re-confirms; gates the (deferred) auto-apply only
}
```
The matcher reads these via `getConfig().voiceMatching` and passes them into the pure units (so units stay config-free + testable). If `modelId !== VOICEPRINT_MODEL_ID`, the matcher logs and uses the built-in defaults (a model swap invalidates calibration — rev-2 §11).

**Calibration harness** (`electron/main/services/voiceprint/__tests__/calibration.harness.ts`, a *node script + test*, not shipped runtime): given a labeled fixture set (synthetic embeddings + a small real-vector fixture if available), sweep thresholds and report identity top-1 / FAR / FRR / margin / unknown-rejection; **self FAR**; merge same-speaker recall vs different/similar-voice FP; suggestions-per-recording. **AC14 gate:** the harness asserts, against the fixture, `selfFAR === 0` and merge-precision + suggestion-count budgets at the chosen constants; CI fails if a constants change regresses these. **No auto-apply is in this sub-project**, so AC14's "auto-apply ships only if…" is honored vacuously *and* the harness is in place for the deferred self-auto-apply sub-project. The Robyn/Tiffany similar-voice pair (AC10) is a required fixture: assert neither auto-merged (unit 3 guard) nor mis-assigned (unit 2 margin demotion → `decision='none'`).

---

## 9. Error handling & edge cases

- **No embeddings / no contacts with prints:** matcher returns zero summary; panel shows no chips (and no error). First-ever use (empty library) → only merge/mixed possible (no identity), which is correct.
- **Model mismatch (AC4):** label embeddings or voiceprints with a stale `model_id` are excluded from comparison (`skippedModelMismatch`), never silently coerced.
- **Idempotency / re-open — `embedRecordingLabels` is NOT idempotent as shipped (must be fixed).** §4's handler calls `embedRecordingLabels` on **every** `getSuggestions` (i.e. every panel open). The shipped function is **not** idempotent: `insertLabelEmbedding` does `INSERT OR REPLACE`, but the table's PRIMARY KEY is `id` (schema line 294) and `embedRecordingLabels` sets `id: le_${randomUUID()}` (voiceprint-service.ts:293) — a **fresh UUID every call**, with **no** UNIQUE constraint on `(recording_id, file_label[, diarization_run_id])`. So `INSERT OR REPLACE` **never collides**: each open inserts a brand-new row per label, **accumulating duplicates**. `getLabelEmbeddingsForRecording` then returns N copies of every label, which would inflate merge clusters (a label "merges" with its own duplicate at cosine ≈ 1.0), double-emit identity suggestions, and corrupt the suggestion budget. **Decision — fix (a): deterministic id + scoped delete + freshness guard.** Phase 3 makes `embedRecordingLabels`:
  1. **resolve the current `diarization_run_id` read-existing-first (§5 run-id resolution order):** call `getLabelEmbeddingsForRecording(recordingId)`; if it returns ≥1 row, the run id is that row's `diarization_run_id` (do **not** mint — minting a fresh UUID here would make step 2 unmatchable dead code); only if the table is empty does step 3 mint a fresh `drun_${randomUUID()}`. (Under option (a), the run id instead comes from `recordings.diarization_run_id`.)
  2. **short-circuit (true idempotency check):** if step 1 found rows (i.e. `getLabelEmbeddingsForRecording(recordingId)` already returns rows for this recording, whose `diarization_run_id` we just adopted as the current run id), **return without re-embedding** — so first-open latency is paid once per run, not on every open. This short-circuit is reachable *only because* step 1 reads the run id off those existing rows rather than minting; a mint-first ordering would never match and would re-embed on every open.
  3. otherwise (the table is empty — post-re-transcribe / post-merge, where `deleteLabelEmbeddingsForRecording` already cleared the prior-run rows), mint a fresh `drun_${randomUUID()}` and write each row with a **deterministic** `id = le_${recordingId}_${runId}_${label}` and the freshly-minted `diarization_run_id`. (The `deleteLabelEmbeddingsForRecording(recordingId)` that produced this empty state was performed by the re-transcribe / merge invalidation path, §7.1 / AC11 — not by `embedRecordingLabels` itself, which finds the table already empty.) The deterministic id means even a within-run double-fire collapses via `INSERT OR REPLACE` instead of duplicating.

  This replaces the earlier (incorrect) "INSERT OR REPLACE per label is already idempotent" claim. `runMatcher` then deletes prior **pending** suggestions **scoped to the current `diarization_run_id`** before regenerating, and **suppresses** any key already `dismissed`/`accepted` *within that same run* (via `getSuggestionsForRecording(recordingId, diarizationRunId)`). A user who dismissed "Looks like Robyn" never sees it again **for that diarization run** (AC7) — but a re-transcribe (new run id) **does** re-surface it, because prior-run rows were hard-`expired` and carry a different run id (AC11).
- **Re-transcribe (AC11):** `recordings:transcribe` (already-transcribed branch) and `transcription.ts`'s Stage-1 start both already drop `recording_speakers`; this sub-project adds `deleteLabelEmbeddingsForRecording` + `expireSuggestionsForRecording` at the same two points so stale embeddings/suggestions don't leak into the new run. Voiceprints are **not** touched (the durable memory for re-match).
- **Mixed-detection cost:** windowed re-embedding is the most expensive path. Bounded by: only for labels with `clean_speech_ms ≥ 2*MIN_CLEAN_SPEECH_MS`; window/hop caps the count; all compute is off-thread via `embedSamples`. If the decode/embed fails, mixed detection is skipped for that label (no flag) — never blocks identity/merge.
- **Margin tie (AC10):** two contacts within `matchMargin` → identity demoted to `none` (no suggestion) rather than guessing. The user can still manually assign.
- **Solo over-split (AC9):** handled by merge detection (two fragments of one voice cluster ≥ `mergeThreshold` ≈ 0.9) — surfaced as a normal merge suggestion; never persisted as two speakers without the user confirming the merge, but the over-split is transient in the diarizer output, not a library poison (banking is gated).
- **Privacy gate (§14):** `enableVoiceprintCapture=false` short-circuits `runMatcher` and `embedRecordingLabels` (Phase 1 already gates the latter) → zero suggestions; existing manual assign/merge unaffected.
- **`speakers:assign` source widening:** the optional `source` defaults to `'user'`; a malformed value is rejected by the zod enum (and the DB CHECK is a second line). Self-enroll uses `'confirmed'` (a self assignment is a confirmed identity, not a guess).
- **Concurrent panel opens / double-fire:** `runMatcher` is safe to run twice (delete-then-insert pending for the current run); a second concurrent call may insert duplicate ids — guarded by deterministic suggestion `id = vmsug_<recordingId>_<diarizationRunId>_<kind>_<label>[_<label2|contact>]` so `INSERT OR REPLACE` collapses duplicates **within a run** while keeping a prior run's (now-`expired`) rows distinct — the run-id segment is what prevents a new run from accidentally overwriting/colliding with a stale row of the same kind+label. (When the run id is absent — the legacy degrade case in flow step 2 — a stable literal like `norun` is substituted so the id stays deterministic.)
- **Long recording first-open latency:** handler awaits embed+match once; renderer shows a spinner; subsequent opens are fast.

---

## 10. Testing strategy

**No real USB/hardware. Mock sherpa (`sherpa-onnx-node`), `electron` (`utilityProcess`/`app`/`ipcMain`), and `child_process` (ffmpeg) exactly as the existing suites do** (`voiceprint-service.test.ts`, `voiceprint-worker-pool.test.ts`, `database-v27.test.ts`). The pure units need none of that.

| Unit | Test file | What's tested (pure, fast) | Mocked |
|---|---|---|---|
| (1) vector-math | `vector-math.test.ts` | cosine/centroid/dispersion on hand-built vectors; blob round-trip | none |
| (2) identity-matcher | `identity-matcher.test.ts` | threshold+margin decisions; hybrid centroid-vs-print; quality down-weight; outlier quarantine; **AC10** margin-demote on two-close-contacts | none (inject `ContactPrints`) |
| (3) merge-detector | `merge-detector.test.ts` | union-find clusters; cap; **§7 cross-contact guard splits a cluster (AC10)**; solo over-split collapses (AC9) | none |
| (4) mixed-detector | `mixed-detector.test.ts` | variance signal; two-contact signal; short-label skip (AC8) | none |
| (5) speaker-matcher | `speaker-matcher.test.ts` | end-to-end with **mocked `database.ts`** (`getLabelEmbeddingsForRecording`/`getContactsWithActiveVoiceprints`/`getActiveVoiceprintsByContactId`/`getSelfContactId`/`insertSuggestion`/`getSuggestionsForRecording`) + mocked `voiceprint-service.embedLabelWindows`; AC4 model-mismatch skip; **AC7 same-run dismissed-suppression** (dismissed key with the current run id is suppressed); **AC11 cross-run NON-suppression** (a dismissed key carrying a *different/old* run id does NOT suppress a new-run suggestion of the same key); run id read off the embeddings + written onto suggestions; idempotent re-run; privacy gate | DB, embedLabelWindows |
| (6) conflict-policy | `conflict-policy.test.ts` | §15 rules 1/2/3/5; dismissed-key drop; cross-contact warning tag | none |
| IPC | `speakers-suggestions-handlers.test.ts` | `getSuggestions` calls embed→match→getPending and shapes `SuggestionView`; never throws → `success([])` on failure; `dismiss`/`accept`; **`setSelf` resolves self via A's `getSelfContactId()`** — when it returns a contact id, assert the label is assigned `source='confirmed'` and `captureVoiceprint(...,'self')` is explicitly invoked (the assign write alone would not, AC6) under the banking gates; **when `getSelfContactId()` returns `null`, assert NO assign/capture and the result carries `needsSelfContact:true`** (B never sets `is_self` — that is A's primitive); `assign` `source` widening | `ipcMain` (mock `getSelfContactId`), all of `database.ts` + `voiceprint-service` + `speaker-matcher` |
| Banking gates | extend `voiceprint-service.test.ts` | bank-skip when a `mixed` suggestion exists; consistency flag; provenance written via the widened `insertVoiceprint` (`source_recording_id`/`source_label`/`quality_score`/`clean_speech_ms`); **`created_from` threaded** — `'confirmed'` from the assign path, `'self'` when `captureVoiceprint(...,'self')` | DB, embedSamples |
| Schema migration (v28) | extend `database-v27.test.ts` / new `database-v28.test.ts` | after init, `PRAGMA table_info(speaker_suggestions)` contains `diarization_run_id`; `insertSuggestion` round-trips the run id; idempotent re-init does not error; Phase-2 repair adds the column on a DB missing it | DB |
| Merge invalidation | extend `speakers-handlers.test.ts` | `speakers:merge` calls `deleteLabelEmbeddingsForRecording` + `expireSuggestionsForRecording` (the deletion — not a separate "mint" — is what forces the next `embedRecordingLabels` to mint a fresh run id on the now-empty table, §7.1 step 3); a post-merge matcher run emits **no `fromLabel`** suggestion (no phantom label) and its embeddings/suggestions carry a run id different from the pre-merge run's, AC7/§7.1 | DB, voiceprint-service, speaker-matcher |
| Embed idempotency | extend `voiceprint-service.test.ts` | **read-existing-first short-circuit:** a second `embedRecordingLabels` call with rows already present for the recording does **not** call `embedSamples` **and does not call `deleteLabelEmbeddingsForRecording`** — it reuses the existing rows' `diarization_run_id` and returns (proving the short-circuit reads the existing run id rather than minting; a mint-first regression would fail this by re-embedding); re-calling on the same run therefore does not accumulate duplicate rows; an **empty** table (post-clear) mints a fresh run id and re-embeds with the deterministic id `le_${recordingId}_${runId}_${label}` (Issue-2 fix, §5/§9) | DB, embedSamples |
| Re-transcribe | extend `recording-handlers.test.ts` / new | already-transcribed branch also calls `deleteLabelEmbeddingsForRecording`+`expireSuggestionsForRecording`; voiceprints untouched | DB |
| Renderer | extend `SpeakersPanel.test.tsx` | chips render per kind; Confirm identity → `assign(...,'suggestion_confirmed')`+`acceptSuggestion`; Dismiss → `dismissSuggestion`; mixed chip has no Confirm; cross-contact merge opens warning dialog; self-enroll → `setSelf`; budget cap; "Dismiss all" | `window.electronAPI` stub |
| Calibration | `calibration.harness.test.ts` | self FAR=0 + merge precision/suggestion budget at default constants on the fixture; AC10 fixture | none (synthetic vectors) |

**Not unit-tested (out of harness):** the actual ERes2Net numeric accuracy on real audio — that's the Phase-0 spike's job and the deferred live calibration; this sub-project asserts *behavior given embeddings*, with synthetic vectors that reproduce the Phase-0 separation (same-person ~0.76, different ~0.10, similar-voice ~0.45).

---

## 11. Acceptance criteria mapping (rev-2 §18)

| AC | How this sub-project satisfies it |
|---|---|
| **AC4** (model compat) | `runMatcher` drops label embeddings/voiceprints whose `model_id ≠ VOICEPRINT_MODEL_ID`; `getContactsWithActiveVoiceprints(modelId)` filters by model. Unit 5 test. |
| **AC5** (identity) | Unit 2: threshold (`matchSuggest`/`matchAuto`) **and** margin-over-second-best; confirming banks only if clean (existing) + not-mixed + consistent (§7 banking gates). |
| **AC6** (self) | Self is **suggested** (pre-selected chip), never auto-applied in this phase. The self-contact primitive (`is_self`, `contacts:setSelf`, "This is me" UI) is **owned by sub-project A** — B does not redefine it. `speakers:setSelf` **resolves** self via A's `getSelfContactId()`; if a self contact exists it assigns the label (`source='confirmed'`) and enrolls once by **explicitly** calling `captureVoiceprint(..., 'self')` after the assign write (the assign write alone does NOT fire capture, §5/§7), gated by the §7 banking gates; if none is set it returns `needsSelfContact:true` and routes the user to A's control (never silently creates self). Auto-apply is deferred (§1). |
| **AC7** (merge) | Unit 3 cluster-aware + capped; dismissals persist for the **diarization run** (suppression via `getSuggestionsForRecording(recordingId, diarizationRunId)`, keyed on the run id so a stale dismissal can't bleed into a new run); cross-contact merge `requiresWarning` → renderer dialog; **merge invalidates affected embeddings (explicit, not hand-waved)** — the `speakers:merge` handler is modified to call `deleteLabelEmbeddingsForRecording(recordingId)` + `expireSuggestionsForRecording(recordingId)` after rewriting turns, and to **mint a fresh `diarization_run_id`** for the post-merge label set, so the next panel-open re-embeds the merged label set against a new run and never sees a phantom `fromLabel` (see §7.1). |
| **AC8** (mixed-label) | Unit 4 within-label variance / two-contact match; **not** the Q&A heuristic. Read-only flag (no confirm) in this phase. |
| **AC9** (solo) | Merge detector collapses same-voice over-split fragments; never persists ≥2 speakers without user-confirmed merge; banking gated so fabricated labels don't poison the library. |
| **AC10** (similar voices) | Two lines of defense: unit 2 margin-demote (no identity suggestion when two contacts are within margin) **and** unit 3 cross-contact guard (won't merge two labels strong-matching different contacts). Required calibration fixture. |
| **AC11** (re-transcribe) | New run **mints a fresh `diarization_run_id`** (so old and new suggestions/embeddings are distinguishable — `transcripts.id` is constant and cannot serve this, §2); `deleteLabelEmbeddingsForRecording` + `expireSuggestionsForRecording` hard-expire the prior run's rows so a stale same-key dismissal can never suppress the new run (the suppression query is run-scoped, §3 step 8 / §9); prior confirmed identities restored by **re-match** (strong pre-selected suggestions on new labels, banked voiceprints survive), not wiped; banner warns of re-lettering. |
| **AC14** (calibration) | Thresholds are model-versioned config; calibration harness asserts self FAR=0 + merge/suggestion budgets; auto-apply (the thing AC14 ultimately gates) is **not** shipped here, so the gate is satisfied and the harness is ready for the deferred sub-project. |

ACs **1/2/3** (instrumentation, clean embeddings, off-thread) are Phase-1 (shipped) and consumed here. ACs **12/13** (undo/delete, privacy toggle UI) are Phase-2's lane; this sub-project only writes the provenance that makes per-print un-bank possible and respects the §14 master gate.

---

## 12. Non-goals / deferred to sibling sub-projects

- **Auto-apply (any kind), including self auto-apply** — rev-2 §13. This phase is suggest+confirm only. The calibration harness + provenance + thresholds-config it would need are built here; the auto-apply producer + guardrails are a separate go/no-go sub-project.
- **The re-transcribe *backstop* producer/UX** (auto/one-tap "re-transcribe with more speakers" acting on `kind='mixed'`) — Phase 6. This sub-project **produces** `kind='mixed'` evidence and wires re-transcribe **invalidation**, but does not build the backstop's confirm-and-re-transcribe surface (the mixed chip has no Confirm here).
- **Static `speaker_options` range + failure budgets at the diarizer** — Phase 5.
- **Recording-type inference / adaptive probe / type→floor** — research-gated (§13).
- **Per-contact voiceprint-management UI / disable-recognition toggle UI** — Phase 2's lane (the DB primitives exist; this phase respects them).
- **Cross-device/cloud voiceprint sharing; post-hoc label splitting; word-level mid-utterance splitting; server-side AssemblyAI Speaker ID; auto-merge of similar voices** — rev-2 §17.
- **Persisting window embeddings** — transient by decision (§3 unit 4); if mixed-detection cost proves prohibitive on real long recordings, a `recording_label_window_embeddings` table is a future optimization (YAGNI now).

---

## 13. File manifest

**Create (main):** `electron/main/services/voiceprint/vector-math.ts`, `identity-matcher.ts`, `merge-detector.ts`, `mixed-detector.ts`, `speaker-matcher.ts`, `conflict-policy.ts`; `electron/main/services/voiceprint/__tests__/*.test.ts` (per the table) + `calibration.harness.ts`.
**Modify (main):** `electron/main/ipc/speakers-handlers.ts` (4 new handlers — `setSelf` **explicitly calls `captureVoiceprint(...,'self')`** since the assign write does not fire capture — + `assign` source widening; **`createdFrom` threaded into A's already-rewritten `setImmediate(captureVoiceprint)` block** — A §3.4/§3.6 already added priorContactId/auto-purge/`voiceprint:captured`-emit; B does NOT rewrite that block, it only widens A's `captureVoiceprint(...)` call to pass `source === 'suggestion_confirmed' ? 'confirmed' : 'manual'` (§3 Fix-3/§7); + **`speakers:merge` invalidation:** after rewriting turns, call `deleteLabelEmbeddingsForRecording` + `expireSuggestionsForRecording` — the row deletion is what forces the next `embedRecordingLabels` to mint a fresh run id (§7.1 step 3); the handler itself does NOT mint under (b), §7.1/AC7); `electron/main/services/database.ts` (**bump `SCHEMA_VERSION` 27→28 + add `MIGRATIONS[28]` with an idempotent `ALTER TABLE speaker_suggestions ADD COLUMN diarization_run_id TEXT`** — **v28 is owned by B; C takes v29** — + add the column to the fresh `SCHEMA` `CREATE TABLE speaker_suggestions` + a **Phase-2 structural-repair fallback** for `speaker_suggestions.diarization_run_id`, §5; 4 new helpers; add `status` **and `diarization_run_id`** to `SpeakerSuggestion` + **widen `insertSuggestion`'s INSERT** to write `diarization_run_id`; `getSuggestionsForRecording` filters by `diarization_run_id`. **NOT a B change — done by A §3.7, B only consumes:** the `Voiceprint` interface widening (`quality_score`/`created_from`/`source_recording_id`/`source_label`/`model_version`/`disabled_at`/`superseded_by`, read side over `getActiveVoiceprintsByContactId`'s `SELECT *`) **and** `insertVoiceprint`'s INSERT widening (`source_recording_id, source_label, clean_speech_ms, quality_score, model_version, created_from`, with `created_from` defaulting to `'manual'`) — **A widens these; B's matcher consumes the widened `Voiceprint` type and B's `captureVoiceprint` threads provenance through the already-widened `insertVoiceprint`. The `created_from` union is A's `'manual' | 'confirmed' | 'self' | 'import'`; B writes `'confirmed'`/`'self'` into it.**); `electron/main/services/voiceprint-service.ts` (**`sliceLabelWindows` (pure, fixed-window slicer — does NOT reuse `pcmToFloat32`'s single-chunk turn concat, Fix-1/§3 unit 4) + `embedLabelWindows` (off-thread wrapper, accepts a pre-decoded `pcm` Buffer to reuse the matcher's decode)**; **`captureVoiceprint` — ADDITIVE on A's version:** A already kept the 3-arg signature returning a rich `CaptureResult` and writes provenance (`created_from` default `'manual'`); B adds a **4th param `createdFrom: 'manual' | 'confirmed' | 'self' = 'manual'`** and inserts B's **two banking gates (not-suspected-mixed + consistency)** into A's body + a new `'label suspected mixed'` `CaptureSkipReason` member — B does NOT re-add provenance writing or the clean-speech/privacy gate (those are A's); **`embedRecordingLabels` made idempotent** — deterministic `id = le_${recordingId}_${runId}_${label}`, freshness short-circuit when rows already exist for the run, and `deleteLabelEmbeddingsForRecording` before re-embed (§9 Issue-2 fix) — and **populates `diarization_run_id`** — currently `id: le_${randomUUID()}` with no run id, voiceprint-service.ts:292-297 — via the §5 run-id source); `electron/main/services/config.ts` (`voiceMatching` section); `electron/main/ipc/recording-handlers.ts` + `electron/main/services/transcription.ts` (add `deleteLabelEmbeddingsForRecording` + `expireSuggestionsForRecording` to the existing re-transcribe drops (the two points at recording-handlers.ts:317-319 and transcription.ts:474); do NOT mint a run id here under (b) — minting is lazy in `embedRecordingLabels` when it finds the embeddings table empty, §5 resolution order / lines 300-303. If option (a) is ever re-chosen, this line must say so explicitly: mint a fresh `drun_${randomUUID()}` per ASR pass and persist it to `recordings.diarization_run_id` — which then also requires adding `recordings.diarization_run_id` to the `database.ts` modify list above).
**Modify (preload):** `electron/preload/index.ts` (4 new `speakers.*` bridge methods).
**Modify (renderer):** `src/features/library/components/SpeakersPanel.tsx` (suggestion chips, confirm/dismiss/self-enroll); `src/features/library/components/SourceReader.tsx` + `SourceDetailDrawer.tsx` (fetch + pass `suggestions`, re-transcribe banner).
