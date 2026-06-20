# Voice Library — Phase 5: Conservative Static `speaker_options` + Failure Budgets + Solo

**Date:** 2026-06-19
**App:** `apps/electron` (universal knowledge hub)
**Status:** Implementation-level design (sub-project C). Derived from — and subordinate to — the approved rev-2 design `docs/superpowers/specs/2026-06-19-voice-library-speaker-identity-design.md`.
**Builds on (SHIPPED):** Phase 1 foundation plan `docs/superpowers/plans/2026-06-19-voice-library-foundation.md` (ERes2Net swap, v27 tables, off-thread embedding, privacy config). The shipped speaker-diarization feature `docs/superpowers/specs/2026-06-17-speaker-diarization-design.md` (AssemblyAI provider, `transcripts.turns`, `recording_speakers`).
**Maps to rev-2:** §9 (failure budgets + conservative static floor, no probe in v1 — this spec ships `min:1` as a **calibration-gated §15 divergence** from §9's recommended `min 2`, see Authority note), AC1 (instrumentation), AC9 (Solo — satisfied by the solo flag + banking gates per rev-2 §9, **not** by `min:1`; the word *persistent* in AC9 is load-bearing), partial AC11 (re-transcribe re-sends options + new run id). §15 conflict hierarchy (invoked explicitly to override §9's `min 2`), §16 conceptual model, §17 non-goals honored.

> **Authority note (§15 conflict hierarchy).** Where this implementation-level spec and rev-2 disagree, **rev-2 wins**. Where rev-2 and the live AssemblyAI API disagree, the **live API wins** (rev-2 itself was burned twice by the provider: `model_region`, `sentiment_analysis`).
>
> **What is validated vs. what is a design choice (be precise — do not overclaim):**
> - **Validated against the live API docs (fetched 2026-06-19).** The `speaker_options` *shape* — `{ min_speakers_expected, max_speakers_expected }`, mutually exclusive with `speakers_expected` — and the default duration-tiered ceilings (no max 0–2 min, 10 for 2–10 min, 30 for 10+ min) are confirmed verbatim from the docs.
> - **Validated against real audio by the throwaway probe** `apps/electron/scripts/aai-diarization-tune.mjs`. The probe submitted, against the user's real recording: `baseline` (no hint), `speakers_expected: 4`, and `speaker_options` ranges `{4,6}`, `{5,8}`, `{6,10}`, `{8,12}`. So what the probe *empirically* confirms is: (a) the API accepts the `speaker_options` range form and returns sane label counts for it, and (b) how `min:4–8 / max:6–12` ranges behave on that audio. **The probe's lowest `min` was 4 and its narrowest `max` was 6.**
> - **NOT validated — an explicit, unproven design choice.** The spec's central policy value `min:1 / max:8` was **never submitted by the probe**. The probe never tested `min:1`, and never tested the `{1,8}` pair. The `min:1` floor and the width-7 range are a *design decision* (justified below), not a probe-confirmed number. The earlier draft's claim that the probe "already submitted these exact permutations" was inaccurate and is retracted.
>
> **`min:1` is a deliberate divergence from rev-2 §9, NOT an AC9 requirement (§15 invoked explicitly).** Be honest about what this value is and is not:
> - **AC9 does NOT mandate `min:1`.** AC9 (rev-2 line 162) reads: "a one-speaker recording is not forced to ≥2 **persistent** speakers." The word *persistent* is load-bearing. A transient over-split label that the merge-suggester collapses and that **never becomes a `recording_speakers` contact** does not violate AC9. Rev-2 §9 (line 105) is explicit that the solo case is satisfied **without** `min:1` — via "the **merge-suggester**" collapsing transient over-splits plus banking gates that prevent *persistence*, and it classifies "forcing `min 1` to skip the over-split entirely" as "a **research-gated nicety, not required for correctness**." So an earlier framing in this spec that called `min:1` "the AC9 keystone" / claimed AC9 "requires" it was **wrong and is retracted.** AC9 is satisfiable on rev-2's documented merge-suggester + banking-gate path with `min:2`.
> - **What `min:1` actually buys** is an *additional, source-level* guarantee on top of the §6.3 detection path: it lets the diarizer return a single label directly so a genuine solo needs no transient over-split + merge round-trip at all. That is a UX/robustness improvement, not a correctness requirement.
> - **Why we still ship `min:1` (the real, honest justification).** Under §15, **rev-2 wins on disagreement** — so adopting `min:1` over rev-2 §9's recommended `min 2` is a *knowing override of rev-2*, made here on the over-split-is-recoverable / under-split-is-not cost asymmetry (§1.1), not because any AC forces it. Rationale: rev-2 §9's `min 2` plus a merge-suggester is a correct path, but it (a) makes the *common* solo case (memos, dictation, the user talking to a silent service) depend on the embedding merge-suggester (sub-project B) to undo a forced second label, and (b) banks an over-split round-trip into the steady state. `min:1` removes that dependency at the source for ≥2-min recordings while the §6.3 embedding-free dominance heuristic remains the backstop for any over-split AAI produces anyway. **This is a divergence we are choosing with eyes open under §15, not an AC-forced value.**
> - **The cost of `min:1` — and why the calibration gate is now a HARD ship precondition, not a follow-up.** The live API docs warn that an incorrect hint "may produce random splits of single-speaker segments," and that `min:1` paired with a wide `max` is precisely the configuration most prone to spurious solo over-splits on short/ambiguous audio — which directly *increases* the §6.3 `dominant_single_speaker` detection burden. We also note the docs recommend, when uncertain, `max ≈ min + 2` (a *tight* range); `[1, 8]` (width 7) is deliberately wider, justified by the same asymmetry (a single static range must cover 1:1 → church-small in one shot, which `min+2` cannot). Because rev-2 already research-gated `min:1` and the docs flag it as the highest solo-over-split-risk setting, the divergence ships **only if** the calibration gate below passes. Two mandatory conditions:
> 1. The `< minDurationMsForHint` (2 min) cutoff in §3.1 exists *specifically* to keep the highest-over-split-risk short clips on pure auto-detect, where the `min:1` floor never applies.
> 2. **Calibration gate (rev-2 §11/AC14) — a HARD precondition to ship `min:1`, blocking, not a follow-up.** Before the `[1, 8]` default is locked into a shipped build, run the **`{min:1,max:8}` permutation itself** through the existing probe on the user's real solo, 1:1, and medical audio (the probe already exists; adding one `['range-1-8', { speaker_options: { min_speakers_expected: 1, max_speakers_expected: 8 } }]` line is trivial). Confirm `min:1` does not produce gratuitous solo over-splits beyond what the §6.3 heuristic catches. **If this gate has not been run and passed, ship `minSpeakers: 2` (rev-2 §9's value) instead and rely on the merge-suggester + banking-gate path rev-2 documents — that path satisfies AC9 on its own.** If the gate fails for `min:1`, either narrow `max` toward the docs' `min+2` guidance, raise `minDurationMsForHint`, or fall back to `min:2`. This is the same calibration `max:8` already needed (§8.5) — `min:1` is folded into it. The value ships as a config-overridable default (§3.4); calibration may revise it without code change.

---

## 1. Problem & scope

### 1.1 The problem this sub-project solves

The P1 is a **standalone recorder**. There is **no calendar invite / attendee list** to seed a speaker count (confirmed by the user this session). Today (post 2026-06-17) the AssemblyAI submit body sends `speaker_labels: true` and **nothing else** — speaker count is fully auto-detected. The 2026-06-17 spec §"Speaker count" explicitly deferred any `speakers_expected`/`speaker_options` hint to "Phase 2." **This sub-project is that hint, done conservatively.**

Two facts from the user drive the whole policy:
- Real recordings span a wide range: **1:1 (2 speakers)**, medical appointments **2–6**, business meetings **10–12**, church **8+**. No single number fits.
- **Over-splitting is RECOVERABLE** (the user merges two labels back together — one tap, sub-project B's merge-suggester even pre-stages it). **Under-splitting is NOT** (one label holds two people; the only fix is a full re-transcribe, which costs money and re-letters speakers). AssemblyAI's own docs confirm the failure modes: too-high `max` → "sentences from the same speaker split across multiple labels" (over-split, recoverable); too-low → "merge multiple speakers into one" (under-split, unrecoverable).

**Policy, therefore: bias toward over-splitting, cap it so it never explodes, and never force a genuine solo recording into ≥2 persistent speakers.**

### 1.2 What this sub-project delivers

1. **A conservative STATIC `speaker_options` policy** — one safe range applied to every diarized run, biased to over- not under-split. **No type inference, no adaptive probe, no per-recording tuning** (all research-gated Phase 7).
2. **Diarization-run instrumentation** — a new `diarization_runs` table + helper that records, per ASR pass, the `speaker_options` actually sent, the label count returned, the transcript/run id, model id, and timestamps. This satisfies **rev-2 AC1**, which the 2026-06-17 foundation did NOT implement (verified: only a free-text `diarization_run_id` column on `recording_label_embeddings` exists; nothing populates it and there is no run-metadata table).
3. **Failure budgets** — a precise definition of what counts as a *diarization failure* vs an expected over-split, surfaced through the same instrumentation + structured operator logs (the action-capping budgets — "cap labels surfaced," "dismiss all" — are UI and live in sub-project B/Phase 3-4; here we define only the run-level budget and the floor that feeds it).
4. **Solo handling (AC9)** — ensure a genuinely one-speaker recording is **not forced to ≥2 *persistent* speakers** (AC9's word *persistent* is load-bearing). The correctness mechanism is the deterministic post-run **solo flag** persisted on the run (§6.3) plus the banking gates that stop any over-split label from becoming a `recording_speakers` contact — **this alone satisfies AC9, with no embeddings and even with `min:2`** (it is rev-2 §9's documented path). The `min_speakers_expected: 1` floor (§6.2) is an *additional* source-level guarantee that lets the diarizer return one label directly; it is a deliberate divergence from rev-2 §9 (which recommends `min 2` and research-gates `min:1`), **not** an AC9 requirement — see the Authority note and §3.1. Independent of the embedding matcher (sub-project B).

### 1.3 Explicitly OUT of scope (deferred)

- **Recording-type inference / adaptive probe / type→floor range** → rev-2 §13, Phase 7. We send ONE static range regardless of content.
- **The embedding-based merge-suggester, identity matcher, mixed-label detector** → sub-project B / Phase 3. We must remain *independent* of it. (We reference it only to note that solo over-split is *transient* because B collapses it — but Phase 5 must be correct even if B is absent: see §6.3.)
- **Auto re-transcribe backstop automation** → Phase 6/7. Phase 5 only guarantees that a re-transcribe *re-sends* the policy options and opens a *new* run id (§6.4).
- **Any UI for editing the range.** The range is model-versioned config (§3.4); v1 ships sane defaults and exposes them in config only, no settings screen. (openQuestion #1.)
- **Self auto-apply, voiceprint banking changes** → Phases 4/7.

---

## 2. Conceptual model (rev-2 §16, kept distinct)

- **`speaker_options`** = the hint we *send* to AssemblyAI (a min/max range). Input.
- **label count** = the number of distinct `turns[].speaker` labels AssemblyAI *returned*. Output.
- **diarization run** = one ASR pass on one recording. Has its own id; a re-transcribe creates a **new** run (never reuses the old one — §15.4).
- **solo** = a *run-level* property meaning "this recording is genuinely one speaker." Distinct from "the diarizer returned 1 label" (it might over-split a solo into 2 same-voice labels — still solo).

We do NOT introduce a "recording type." A run is just `{ options_sent, label_count, is_solo, duration }`.

---

## 3. Architecture & components

All paths relative to `apps/electron/`. All changes are **main-process + DB**; **no renderer changes are required** for v1 (the instrumentation surfaces through logs + the existing transcript flow; a future panel reads `diarization_runs`, but that is sub-project B/Phase 3-4 UI). Minimal-UI per the brief.

```
                 transcribeRecording (transcription.ts, Stage 1)
                          │
                          ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ (1) speaker-options-policy.ts   computeSpeakerOptions(durationMs)│  ← pure, unit-testable
  │       → { min_speakers_expected, max_speakers_expected } | null  │
  └───────────────────────────────────────────────────────────────┘
                          │ opts
                          ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ (2) asr.transcribe(file, { meetingContext, speakerOptions })     │  ← assemblyai-asr.ts
  │       sends speaker_options in the submit body (ms timestamps)    │
  │       returns AsrResult { text, language, turns }                 │
  └───────────────────────────────────────────────────────────────┘
                          │ asrResult
                          ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ (3) solo-detection.ts   classifyRunOutcome(turns, opts, durMs)   │  ← pure, unit-testable
  │       → { labelCount, isSolo, soloReason, failure }              │
  └───────────────────────────────────────────────────────────────┘
                          │ outcome
                          ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ (4) database.ts   insertDiarizationRun(run)                      │  ← AC1 storage
  │       diarization_runs(id, recording_id, transcript_id, provider,│
  │         model, options_min, options_max, options_sent_json,      │
  │         label_count, is_solo, solo_reason, failure_reason,        │
  │         duration_ms, created_at)                                  │
  │       upsertTranscriptStage1 receives diarization_run_id so       │
  │       label-embeddings (Phase 1 column) can tag their run.        │
  └───────────────────────────────────────────────────────────────┘
```

### 3.1 Component 1 — `speaker-options-policy.ts` (NEW)

**What it does.** Pure function. Given the recording duration (ms) and the model-versioned policy config, returns the conservative static `speaker_options` to send, or `null` to send nothing.

**Interface.**
```typescript
// electron/main/services/asr/speaker-options-policy.ts
export interface SpeakerOptions {
  min_speakers_expected: number
  max_speakers_expected: number
}

export interface SpeakerOptionsPolicy {
  /** Floor sent to the diarizer. 1 = solo permitted at source (calibration-gated §15
   *  divergence from rev-2 §9); 2 = rev-2 §9's recommended value. NOT what satisfies
   *  AC9 — AC9 is met by the solo flag + banking gates regardless (§6.3). */
  minSpeakers: number          // default 1 IFF the calibration gate (Authority note item 2) passed; else 2 per rev-2 §9
  /** Ceiling we send. Conservative over-split bias, but capped (rev-2 §9). */
  maxSpeakers: number          // default 8
  /** AssemblyAI applies no max limit under 2 min; sending a range there is a no-op
   *  surcharge of risk for tiny clips. Skip the hint below this duration. */
  minDurationMsForHint: number // default 120_000 (2 min — AAI's own first tier)
  /** Model-version tag; re-tune if the speech model changes (rev-2 §3.4/§11). */
  version: number              // default 1
}

/** Returns the options to send, or null to send NONE (auto-detect). Pure. */
export function computeSpeakerOptions(
  durationMs: number | null | undefined,
  policy?: Partial<SpeakerOptionsPolicy>
): SpeakerOptions | null
```

**Decision logic (v1, static).**
- If `durationMs` is unknown/null OR `< minDurationMsForHint` → return `null` (let AAI auto-detect; below 2 min AAI imposes no max anyway, and short clips are the highest over-split risk per AAI's "random splits of single-speaker segments" warning). This keeps tiny memos/dictations from being pushed to 2+ labels by a floor — they over-detect least when left alone.
- Otherwise → return `{ min_speakers_expected: minSpeakers (1), max_speakers_expected: maxSpeakers (8) }`.

**Why `min 1 / max 8` is the conservative choice (grounded in the live API + rev-2 §9):**
- `min_speakers_expected: 1` — **a deliberate divergence from rev-2 §9 under §15, NOT an AC9 requirement.** Rev-2 §9 recommends the static range start at `min 2 / max 8` and explicitly classifies "forcing `min 1`" as "a research-gated nicety, not required for correctness" — it satisfies AC9 instead via the merge-suggester + banking gates (the word *persistent* in AC9 is load-bearing: a transient over-split that never becomes a contact does not violate AC9). So `min:2` would **not** violate AC9, and `min:1` is **not** AC-forced. We nonetheless ship `min:1` as a knowing override of rev-2 §9 (§15 says rev-2 wins on disagreement; we are choosing to override it here with eyes open), justified by the over-split-recoverable / under-split-not asymmetry (§1.1): `min:1` lets a genuine solo return one label *at the source*, so the common solo case (memo/dictation/silent-service) does not have to depend on the embedding merge-suggester (sub-project B) to undo a forced second label. It tells AAI a one-speaker result is *allowed* (AAI's default already permits 1; sending `min:1` makes intent explicit and survives a future default change). **Because the docs flag `min:1` + wide `max` as the highest solo-over-split-risk setting and rev-2 research-gated it, this value ships only if the calibration gate (Authority note item 2) passes; otherwise ship `min:2` per rev-2 §9.** (openQuestion #2: this is a documented §15 override of rev-2 §9's `min 2`, gated on calibration — not an AC-forced value.)
- `max_speakers_expected: 8` — over-split bias **with a cap**. 8 comfortably covers 1:1, medical (2–6), and church-small; it deliberately *under*-shoots large business meetings (10–12) and big church (8+). That is intentional: rev-2 §9 says "cap over-splitting aggressively," and AAI warns a too-high `max` *itself* causes same-speaker fragmentation. For the rare large meeting, the run is flagged `failure: 'hit_ceiling'` (§4) and the user can one-tap re-transcribe with a higher floor (Phase 6 backstop). 8 is the *starting* default pending the calibration gate (Authority note / §8); it is config (§3.4) and re-tunable.
- The range `[1, 8]` for ≥2 min is **strictly inside AAI's own default ceiling** (10 for 2–10 min, 30 for 10+ min), so we are *tightening* the ceiling toward over-split-but-bounded, never loosening it.

**Dependencies.** None (pure). Reads policy from a default constant; the caller may inject overrides from config (§3.4).

### 3.2 Component 2 — `assemblyai-asr.ts` (MODIFY) + `asr-provider.ts` (MODIFY interface)

**What changes.** The `AsrProvider.transcribe` opts gains an optional `speakerOptions`. `createAssemblyAiAsr` includes it in the submit body when present.

**Interface change (`asr-provider.ts`).**
```typescript
export interface AsrProvider {
  transcribe(
    filePath: string,
    opts: { meetingContext?: string; speakerOptions?: SpeakerOptions }
  ): Promise<AsrResult>
}
```
`SpeakerOptions` is imported from `./speaker-options-policy` (or re-declared in `asr-provider.ts` to avoid a circular import — **decision: declare the `SpeakerOptions` interface in `asr-provider.ts` and have the policy module import it**, since `asr-provider.ts` is the lower-level shared types module). Gemini/Whisper providers ignore the field (they don't diarize) — no change to them beyond the wider `opts` type, which is already optional-keyed so existing callers compile unchanged.

**Submit-body change (`assemblyai-asr.ts`).** In the existing `submitBody`:
```typescript
const submitBody: Record<string, unknown> = {
  audio_url: upload_url,
  speech_models: speechModels,
  speaker_labels: true,
  keyterms_prompt: buildKeyterms(opts.meetingContext),
  language_code: languageCode
}
// Phase 5: conservative static over-split range (rev-2 §9). Sent ONLY when the
// policy yields one (>=2 min recordings). min_speakers_expected:1 keeps AC9 (solo
// never forced up); max is capped to avoid AAI's "same-speaker split" over-fragmentation.
// speaker_options and speakers_expected are mutually exclusive — we NEVER send speakers_expected.
if (opts.speakerOptions) {
  submitBody.speaker_options = {
    min_speakers_expected: opts.speakerOptions.min_speakers_expected,
    max_speakers_expected: opts.speakerOptions.max_speakers_expected
  }
}
```
**Constraints honored:** `speaker_options` is mutually exclusive with `speakers_expected` per the API; we never send the singular form. The existing "forbidden keys" test (no `speech_model`, `word_boost`, `model_region`, `sentiment_analysis`) is untouched. The `multichannel` per-channel multiplier warning does not apply (we never set `multichannel`).

**Return shape.** Unchanged (`AsrResult`). The label count is derived downstream from `turns` (Component 3) — the provider stays a thin transport.

**Dependencies.** `SpeakerOptions` type. No new network calls (same single submit). No retry/timeout changes.

### 3.3 Component 3 — `solo-detection.ts` (NEW)

**What it does.** Pure function. Given the returned `turns`, the options sent, and the duration, classify the run outcome: label count, solo verdict + reason, and any failure budget breach.

**Interface.**
```typescript
// electron/main/services/asr/solo-detection.ts
import type { Turn } from './asr-provider'
import type { SpeakerOptions } from './asr-provider'

export type DiarizationFailureReason =
  | 'no_turns'          // diarizing provider returned 0 turns on a non-empty recording
  | 'hit_ceiling'       // labelCount === max_speakers_expected → likely under-split (rev-2 §9 budget)
  | 'over_floor'        // labelCount > max_speakers_expected somehow (shouldn't happen; defensive)
  | null

export interface RunOutcome {
  labelCount: number
  isSolo: boolean
  soloReason: 'single_label' | 'dominant_single_speaker' | null
  failure: DiarizationFailureReason
}

export function classifyRunOutcome(
  turns: Turn[] | undefined,
  optionsSent: SpeakerOptions | null,
  durationMs: number | null | undefined
): RunOutcome
```

**Solo detection logic (deterministic, NO embeddings — independent of sub-project B).**
1. `labelCount` = distinct `turns[].speaker` count (reuse the same first-seen-order roster logic as `deriveSpeakerRosterSummary`; we only need the count). 0 turns → `labelCount = 0`.
2. **`isSolo = true` when EITHER:**
   - `labelCount <= 1` (the diarizer returned one or zero speakers — clearly solo); `soloReason = 'single_label'`. OR
   - `labelCount === 2` AND one label dominates: the dominant label's clean/total talk-time fraction `>= SOLO_DOMINANCE_FRACTION` (default **0.97**) AND the minor label has `< SOLO_MINOR_MAX_MS` total talk (default **3000 ms**). This catches the classic solo over-split where AAI split a single voice into a big A and a tiny spurious B (e.g. a cough, a 1-second "mm-hm" mis-clustered). `soloReason = 'dominant_single_speaker'`.
   - Talk-time per label = sum of `(endMs - startMs)` over that label's turns (we do NOT need overlap-aware clean-speech here — raw talk-time is the right signal for "did this label actually say anything"). This is intentionally a *conservative* solo test: it fires only on near-total dominance, so a real short interjection from a second person (which we must NOT swallow) keeps the run multi-speaker.
3. `failure`:
   - 0 turns on a recording with `durationMs > 0` → `'no_turns'` (a genuine diarization failure: the provider gave us nothing).
   - `optionsSent != null` AND `labelCount === optionsSent.max_speakers_expected` → `'hit_ceiling'` (the run pinned the ceiling we set; this is the **under-split risk signal** — the true count may be higher than `max`, exactly the unrecoverable error rev-2 §9 warns about). This does NOT fail the transcription; it is a logged/stored budget breach that flags the recording as a re-transcribe candidate for Phase 6.
   - `labelCount > (optionsSent?.max_speakers_expected ?? Infinity)` → `'over_floor'` (defensive; AAI shouldn't exceed the max we sent, but if it does we record it).
   - otherwise `null`.

**Why this is correct without the matcher.** The merge-suggester (sub-project B) collapses an over-split solo *after the fact* using embeddings; but Phase 5's `isSolo` flag must be derivable from turns alone so AC9 holds even before B ships and even if voiceprints are disabled (privacy toggle). The dominance heuristic is the embedding-free safety net.

**Dependencies.** `Turn`, `SpeakerOptions` types. Pure. Constants (`SOLO_DOMINANCE_FRACTION`, `SOLO_MINOR_MAX_MS`) are module-level and re-exported for test + future config.

### 3.4 Policy config (model-versioned)

Per rev-2 §11/§3.4, thresholds are **model-versioned config** so they can be re-tuned if the speech model changes. Add a `diarization` sub-section to `transcription` config (so it travels with the provider it tunes):

```typescript
// config.ts — AppConfig.transcription, additive
transcription: {
  /* …existing… */
  diarization: {
    speakerOptionsEnabled: boolean   // master switch for sending the hint (default true)
    minSpeakers: number              // 1 IFF calibration gate passed (§15 divergence); else 2 (rev-2 §9). NOT the AC9 mechanism — see §6.3.
    maxSpeakers: number              // default 8  (capped over-split ceiling)
    minDurationMsForHint: number     // default 120_000
    policyVersion: number            // default 1  (bump on re-tune; rev-2 §11)
  }
}
```
`DEFAULT_CONFIG.transcription.diarization = { speakerOptionsEnabled: true, minSpeakers: /* 1 once the calibration gate passes; ship 2 (rev-2 §9's value) until then */ 1, maxSpeakers: 8, minDurationMsForHint: 120000, policyVersion: 1 }`. `deepMerge` already backfills this for existing configs (verified in `config.ts` — new nested keys merge from defaults). No migration. When `speakerOptionsEnabled` is false, `computeSpeakerOptions` returns `null` (pure auto-detect — a clean kill switch).

### 3.5 Component 4 — `diarization_runs` table + helpers (MODIFY `database.ts`)

**This is the AC1 storage that Phase 1 did NOT ship.** New table (a **v29** migration).

> **Cross-spec note (migration ownership / sequencing).** v28 is owned by sub-project B (`speaker_suggestions.diarization_run_id`); this sub-project (C) takes v29 because it ships after B. C bumps `SCHEMA_VERSION` to **29** and registers `MIGRATIONS[29]` = the `diarization_runs` table + `idx_diar_runs_recording` + `transcripts.diarization_run_id` column. Because the sub-projects are implemented sequentially A → B → C, C's migration runs on a DB B has already migrated to v28; the structural-repair fallback (§3.6) self-heals the case where, on a given DB, B's migration did not in fact run first.

```sql
CREATE TABLE IF NOT EXISTS diarization_runs (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    transcript_id TEXT,
    provider TEXT NOT NULL,          -- 'assemblyai' (only diarizing provider in v1)
    model TEXT,                      -- the speech_models string actually used
    options_min INTEGER,             -- min_speakers_expected sent (NULL = none sent)
    options_max INTEGER,             -- max_speakers_expected sent (NULL = none sent)
    options_sent_json TEXT,          -- full speaker_options object as sent, or NULL
    label_count INTEGER NOT NULL,    -- distinct speakers returned
    is_solo INTEGER NOT NULL DEFAULT 0,
    solo_reason TEXT,                -- 'single_label' | 'dominant_single_speaker' | NULL
    failure_reason TEXT,             -- 'no_turns' | 'hit_ceiling' | 'over_floor' | NULL
    duration_ms INTEGER,
    policy_version INTEGER,          -- which policy produced options (rev-2 §11)
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diar_runs_recording ON diarization_runs(recording_id, created_at);
```

**Helpers (exported from `database.ts`, near the Phase-1 `insertLabelEmbedding`).**
```typescript
export interface DiarizationRun {
  id: string; recording_id: string; transcript_id?: string | null
  provider: string; model?: string | null
  options_min?: number | null; options_max?: number | null; options_sent_json?: string | null
  label_count: number; is_solo: boolean
  solo_reason?: string | null; failure_reason?: string | null
  duration_ms?: number | null; policy_version?: number | null
}
export function insertDiarizationRun(r: DiarizationRun): void
/** Most-recent run for a recording (for the Phase-6 backstop + any future panel). */
export function getLatestDiarizationRun(recordingId: string): DiarizationRun | null
export function getDiarizationRunsForRecording(recordingId: string): DiarizationRun[]
```
A re-transcribe **on the diarizing path** inserts a **new** row (new `id`), never updates the old one — preserving the audit trail of every option set ever sent (rev-2 §15.4). On that same diarizing path the new run's `id` is threaded into `upsertTranscriptStage1` so per-label embeddings (Phase 1's `recording_label_embeddings.diarization_run_id`) can tag their generation, enabling stale-row detection on re-transcribe (rev-2 §8). On the **non-diarizing path** (Gemini/Whisper, `turns === undefined`) no run is minted and `diarization_run_id` is left `undefined` — see the §4 diarizing gate. **Decision:** `upsertTranscriptStage1` gains an optional `diarization_run_id?: string` param that, when present, is stored on the transcript via a new `transcripts.diarization_run_id` column (added in the same **v29** migration) so embeddings and suggestions can join run→transcript. (openQuestion #3.)

### 3.6 Structural-repair fallback (boot-time self-heal)

**Why this exists.** The sub-projects ship sequentially A → B → C, so on a freshly migrated DB v29 runs after B's v28. But neither spec *guarantees* the other's migration actually ran first on a given on-disk DB — a build could land out of order, a v28 migration could have been partially applied/rolled back, or a DB could be carried forward from a branch where B was reverted. The codebase already self-heals schema drift at boot (mirroring how the Phase-1 v27 tables and the existing migrations are PRAGMA-guarded and re-created idempotently); C does the same for its own objects so the `diarization_runs` insert path can never hit a missing table/column regardless of B's state.

**What it does.** A boot-time `ensureDiarizationSchema()` (called from the same DB-init path that runs migrations, after `runMigrations()`), idempotent and PRAGMA-guarded:

```typescript
// database.ts — defensive structural repair, runs at boot after migrations.
// Idempotent: every statement is IF NOT EXISTS or PRAGMA-guarded. Mirrors the
// existing self-heal pattern; does NOT bump SCHEMA_VERSION and is independent of
// whether MIGRATIONS[29] (or B's MIGRATIONS[28]) actually ran on this DB.
function ensureDiarizationSchema(db: Database): void {
  // (1) diarization_runs table (C owns this)
  db.run(`CREATE TABLE IF NOT EXISTS diarization_runs ( /* …full DDL from §3.5… */ )`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_diar_runs_recording ON diarization_runs(recording_id, created_at)`)

  // (2) transcripts.diarization_run_id column (C owns this) — ALTER only if absent.
  const cols = db.exec(`PRAGMA table_info(transcripts)`)
  const hasRunId = cols[0]?.values?.some((row) => row[1] === 'diarization_run_id')
  if (!hasRunId) db.run(`ALTER TABLE transcripts ADD COLUMN diarization_run_id TEXT`)
}
```

**Scope (do NOT over-reach).** C repairs **only** the two objects C owns — `diarization_runs` (+ its index) and `transcripts.diarization_run_id`. It does **not** create or repair `speaker_suggestions.diarization_run_id` (that is B's v28 object; B owns its own self-heal). The repair is purely additive (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, guarded `ADD COLUMN`); it never drops, never rewrites, and never alters B's objects, so running both specs' self-heals in either order converges to the same schema. A test (extend §8.3) asserts `ensureDiarizationSchema()` is a no-op on an already-migrated DB and that it restores the table/column on a DB where they were dropped.

---

## 4. Data flow (end to end)

1. `transcribeRecording` (Stage 1, `transcription.ts`) resolves `recording`. Computes `durationMs` from the recordings table column **`duration_seconds` (REAL)** → `recording.duration_seconds != null ? Math.round(recording.duration_seconds * 1000) : null` (the recordings/device_files_cache schema stores seconds, not ms — verified). See §7 for the null case.
2. `const opts = computeSpeakerOptions(durationMs, getConfig().transcription.diarization)` → `SpeakerOptions | null`.
3. `const asr = getAsrProvider(config)`; `const asrResult = await asr.transcribe(recording.file_path, { meetingContext, speakerOptions: opts ?? undefined })`.
4. AssemblyAI provider sends `speaker_options` in the submit body iff present; returns `turns`. Non-diarizing providers (Gemini/Whisper) return `asrResult.turns === undefined`.

**The diarizing gate — steps 5–8 run ONLY when `asrResult.turns !== undefined`.** This is the single most important control-flow guard in the feature: a diarization run exists only when a diarizing provider actually returned turns. If `turns` is `undefined` (non-diarizing provider, per §7), we **skip steps 5–8 entirely** — no `runId` is generated, `upsertTranscriptStage1` is called WITHOUT `diarization_run_id` (it stays `undefined`, which the optional param allows), and **no `diarization_runs` row is written**. This matches §7 verbatim: "when `turns` is `undefined` (provider doesn't diarize), we write **no** `diarization_runs` row … Only the AssemblyAI path instruments." Equivalently, since AssemblyAI is the only diarizing provider in v1, the guard may be written `if (config.transcription.provider === 'assemblyai')`; the `turns !== undefined` form is preferred because it is provider-agnostic and survives a future second diarizing provider.

```typescript
// Step 6 base (always): persist Stage-1 transcript. diarization_run_id is set
// ONLY on the diarizing path; otherwise omitted → undefined (optional param).
let runId: string | undefined
if (asrResult.turns !== undefined) {
  runId = 'diar_' + randomUUID()           // (5/6) only minted on the diarizing path
}
upsertTranscriptStage1({ /* …existing fields… */ turns: asrResult.turns, diarization_run_id: runId })

if (asrResult.turns !== undefined) {        // ← the diarizing gate
  // (5) classify
  const outcome = classifyRunOutcome(asrResult.turns, opts, durationMs)
  // (7) instrument — best-effort, wrapped in try/catch (see step 9)
  try {
    insertDiarizationRun({
      id: runId!, recording_id, transcript_id: 'trans_' + recordingId,
      provider: config.transcription.provider,      // 'assemblyai' on this path
      model: /* the models string already computed for transcription_model */ undefined,
      options_min: opts?.min_speakers_expected ?? null,
      options_max: opts?.max_speakers_expected ?? null,
      options_sent_json: opts ? JSON.stringify(opts) : null,
      label_count: outcome.labelCount, is_solo: outcome.isSolo,
      solo_reason: outcome.soloReason, failure_reason: outcome.failure,
      duration_ms: durationMs ?? null,
      policy_version: getConfig().transcription.diarization.policyVersion
    })
  } catch (err) { console.warn('[Diarization] insertDiarizationRun failed (best-effort)', err) }
  // (8) operator log — see below
}
```

Numbered description of the guarded block:

5. `const outcome = classifyRunOutcome(asrResult.turns, opts, durationMs)` — **diarizing path only.**
6. `runId = 'diar_' + randomUUID()` is minted **only** on the diarizing path (step above). `upsertTranscriptStage1` is always called, but `diarization_run_id` is set to `runId` only here; on the non-diarizing path it is omitted and stays `undefined`, so Gemini/Whisper transcripts carry no run id (the optional `diarization_run_id?` param already allows this).
7. `insertDiarizationRun({ … })` — **diarizing path only.** Because the gate fires only when `turns !== undefined`, `provider` here is always the diarizing provider (`'assemblyai'` in v1); we never write a row with `provider: 'gemini'`/`label_count: 0`/`is_solo: true` for a non-diarizing run.
8. **Operator log (failure budget surfacing), diarizing path only:** if `outcome.failure === 'hit_ceiling'` log `[Diarization] recording <id> hit the speaker ceiling (<max>) — possible under-split; re-transcribe candidate` (gated behind the QA-logs toggle per the QA logging rules in CLAUDE.md — note `useUIStore.getState().qaLogsEnabled` is renderer-only; in the main process emit via the existing `emitActivityLog('warning', …)` already imported in `transcription.ts`). Solo and normal runs log at info via the same `emitActivityLog`.
9. Stage 1 proceeds unchanged (the `stage1_complete` progress signal, Stage 2, etc.) on **both** paths. **The diarization-run insert happens AFTER `upsertTranscriptStage1` and is best-effort wrapped in try/catch** — instrumentation must never fail a transcription (it's observability, not correctness). On insert failure: one `console.warn`, continue.

**Re-transcribe (rev-2 AC11, partial):** the existing `clearTranscriptForRetranscribe` already wipes `turns`/`speakers`/`sentiment` and forces a fresh Stage 1. Phase 5 only ensures that fresh Stage 1 runs the *same policy* (so the re-transcribe also gets the over-split range) and inserts a **new** `diarization_runs` row. The Phase-6 backstop (raising `max` for a flagged under-split) is NOT built here; Phase 5 just makes the data available (`getLatestDiarizationRun(...).failure_reason === 'hit_ceiling'`).

> **Cross-spec note (transcription.ts is already touched by B — layer on, don't replace).** Sub-project B has **already modified** the Stage-1 re-transcribe path in `transcription.ts`: on re-transcribe it calls `deleteLabelEmbeddingsForRecording(recordingId)` + `expireSuggestionsForRecording(recordingId)` before the fresh Stage 1 runs. C ships *after* B, so C's diarization-run instrumentation (mint `runId`, `classifyRunOutcome`, `insertDiarizationRun`, thread `diarization_run_id` into `upsertTranscriptStage1`) **layers on top of B's already-modified version of the file, not the shipped 2026-06-17 original.** When editing, preserve B's `deleteLabelEmbeddingsForRecording`/`expireSuggestionsForRecording` calls; add C's instrumentation alongside them, do not revert them.
>
> **Run-id sourcing reconciliation.** C mints a fresh `'diar_' + randomUUID()` per ASR pass (one run id per diarizing transcription) and writes it to `transcripts.diarization_run_id` via `upsertTranscriptStage1`. Once C adds that column, B can *read* `transcripts.diarization_run_id` to tag/expire its own per-recording embeddings and suggestions against the specific run that produced them, rather than minting or guessing a run id of its own — C is the single source of truth for the run id; B consumes it.

---

## 5. New IPC endpoints + preload bridge

**v1 needs no new IPC for the core feature.** The policy runs entirely inside the main-process transcription pipeline; the renderer is not in the loop. This is deliberate (minimal UI per the brief).

**One read-only IPC is added for observability** (so a future Speakers panel / QA can show "diarized with N speakers, range x–y, solo?"), specced now because it is cheap and the table is the AC1 deliverable:

- Channel: `diarization:getLatestRun`
- Handler (new `electron/main/ipc/diarization-handlers.ts`, registered alongside `registerSpeakersHandlers` in `handlers.ts`):
  ```typescript
  ipcMain.handle('diarization:getLatestRun', async (_, recordingId: unknown): Promise<Result<DiarizationRun | null>> => {
    const parsed = z.string().min(1).safeParse(recordingId)
    if (!parsed.success) return error('VALIDATION_ERROR', 'Invalid recordingId', parsed.error.format())
    try { return success(getLatestDiarizationRun(parsed.data)) }
    catch (err) { return error('DATABASE_ERROR', 'Failed to load diarization run', err) }
  })
  ```
- **Preload bridge** (`electron/preload/index.ts`): add `diarization: { getLatestRun: (recordingId: string) => callIPC('diarization:getLatestRun', recordingId) }` to the exposed `electronAPI`, and the matching type in `electron/preload/index.d.ts`. Follows the existing `callIPC` wrapper pattern (QA-logged, polling-exempt list unchanged).

No `contextBridge` security change (read-only, validated string in, typed `Result` out).

---

## 6. Solo handling (AC9) — detailed

### 6.1 The AC9 requirement

> "A one-speaker recording is not forced to ≥2 persistent speakers."

Two failure paths to prevent: (a) the diarizer is *told* to find ≥2 (a `min: 2` floor) and obeys; (b) the diarizer over-splits a solo into 2 and we *persist* that as 2 contacts.

### 6.2 Layer A — never force the source (optional hardening, not the AC9 mechanism)

`min_speakers_expected: 1` (§3.1), **when the calibration gate has passed and `min:1` ships.** We never send `speakers_expected` (exact). With `min:1`, the diarizer is *permitted* to return one label, so a solo is not forced up at the source.

**This layer is a deliberate divergence from rev-2 §9, not the thing that satisfies AC9.** AC9 forbids a solo being forced to ≥2 ***persistent*** speakers; Layer B (§6.3) — the solo flag plus the banking gates that stop any over-split label from becoming a `recording_speakers` contact — is what guarantees that, and it holds **even with `min:2`** (it is rev-2 §9's documented merge-suggester + banking-gate path). So if the calibration gate (Authority note item 2) is not passed and the build ships `minSpeakers: 2` per rev-2 §9, path (a) is *not* structurally blocked at the API boundary — but AC9 is still met by Layer B, exactly as rev-2 intends. Layer A removes the need for the transient over-split + merge round-trip in the common solo case; it does not, by itself, carry AC9.

### 6.3 Layer B — detect + flag transient over-split

If AAI still over-splits a solo into 2 same-voice labels (it can — AAI warns a too-high `max` "splits sentences from the same speaker"), `classifyRunOutcome` flags `is_solo = true` via the dominance heuristic (§3.3). This flag:
- Is **persisted on the run** (`diarization_runs.is_solo`), so it is durable and queryable.
- Tells the merge-suggester (sub-project B), when present, to pre-stage collapsing the spurious second label (B's job; we just hand it the flag and the labels — we do NOT call B).
- Guards persistence: because banking a voiceprint is gated on clean + corroborated + user confirmation (Phase 1/2/4), a fabricated second label is **never silently turned into a persistent contact**. A solo run with `is_solo = true` and `labelCount = 2` does NOT auto-create two `recording_speakers` rows — Phase 5 writes nothing to `recording_speakers` (that's Phase 4's confirmed-suggestion flow). So "persistent speakers" (the AC9 concern) are only ever created by explicit user action, which won't happen for a fabricated label.

**Independence from sub-project B:** AC9 is satisfied by **Layer B alone** (the solo flag + banking gates; no embeddings, no `min:1` required) — this is rev-2 §9's documented path and it holds whether the shipped floor is `min:1` (calibration-gated) or `min:2` (rev-2 §9's value). B *improves* the UX (auto-staging the merge) but is not required for correctness. If voiceprints are disabled (privacy toggle off) or B never ships, a solo recording still: is flagged `is_solo` in the over-split case (and, if `min:1` shipped, returns 1 label directly in the common case), and creates zero persistent speakers automatically — banking is gated on clean + corroborated + explicit user confirmation, which won't happen for a fabricated label. AC9 holds regardless of the floor value.

### 6.4 Solo + re-transcribe

A re-transcribe of a solo recording re-runs the same policy (`min: 1`), so the solo property is re-derivable; a new run id is inserted; the old run's `is_solo` history is preserved.

---

## 7. Error handling & edge cases

| Case | Behavior |
|---|---|
| **Duration unknown / `recording.duration_seconds` null** | `computeSpeakerOptions(null)` → `null` (send no hint; AAI auto-detects). Decision: do NOT spawn ffprobe just to get duration — the recordings table already carries `duration_seconds` for synced files; if absent, auto-detect is the safe default (it's what ships today). (openQuestion #4.) |
| **Recording < 2 min** | `null` (no hint). Below AAI's first ceiling tier; short clips over-split worst when hinted. Solo memos/dictations land here → never forced up. |
| **Non-AssemblyAI provider (Gemini/Whisper)** | `getAsrProvider` returns a non-diarizing provider; `asrResult.turns` is `undefined`. **The §4 diarizing gate (`if (asrResult.turns !== undefined)`) is FALSE**, so steps 5–8 are skipped: `classifyRunOutcome` is never called, no `runId` is minted, and we write **no** `diarization_runs` row (there was no diarization). `upsertTranscriptStage1` is still called but WITHOUT `diarization_run_id` (it stays `undefined`). `is_solo` is irrelevant. **Only the AssemblyAI path instruments** — this is the same gate stated in §4 steps 5–8; the two sections agree verbatim. |
| **0 turns from AssemblyAI on a non-empty file** | `failure: 'no_turns'`, `labelCount: 0`, `isSolo: true` (vacuously — nothing to split). Logged as a warning; transcription still completes (Stage 2 summarizes whatever `full_text` exists). |
| **`label_count === max (8)`** | `failure: 'hit_ceiling'`. Stored + logged. Recording becomes a Phase-6 re-transcribe candidate. NOT a transcription failure. |
| **`insertDiarizationRun` throws** | Caught; `console.warn`; transcription proceeds. Instrumentation is best-effort. |
| **`speakerOptionsEnabled: false` in config** | `computeSpeakerOptions` → `null`. No hint sent. Runs still instrumented (with `options_min/max = null`). Clean kill switch. |
| **AAI rejects `speaker_options` (400)** | Surfaces as the existing `throwForStatus`/submit-failed Error → normal retry/terminal path. The probe confirmed the `speaker_options` range *form* is accepted (it ran `{4,6}…{8,12}`); the exact `{1,8}` pair is validated at the calibration gate (Authority note), and `min:1`/`max:8` are well within the API's documented bounds, so a 400 is not expected. If it ever 400s, the fix is to disable via config, not crash. |
| **Mutual exclusivity** | We send ONLY `speaker_options`, never `speakers_expected`. Enforced by the submit-body code path (there is no code that sets `speakers_expected`). A test asserts `speakers_expected` is absent. |

---

## 8. Testing strategy

**No real USB/hardware. No real AssemblyAI network. No real sherpa/ffmpeg.** Mock `electron`, `child_process`, the global `fetch`, and the sherpa addon exactly as the existing suites do (`assemblyai-asr.test.ts` stubs `fetch` + mocks `fs`; `database-v27.test.ts` mocks `electron`/`config`/`file-storage`/`vector-store`).

### 8.1 Pure unit tests (no mocks needed)

**`speaker-options-policy.test.ts`:** (assert against the **shipped** `minSpeakers`/`maxSpeakers` defaults, whatever the calibration gate locks — the test reads the default constant rather than hard-coding `1`, so it does not pre-commit `min:1` before the gate passes)
- `computeSpeakerOptions(null)` → `null`; `computeSpeakerOptions(60_000)` (1 min) → `null`; `computeSpeakerOptions(600_000)` (10 min) → `{ min: DEFAULT.minSpeakers, max: DEFAULT.maxSpeakers }`.
- Respects overrides: `computeSpeakerOptions(600_000, { minSpeakers: 1, maxSpeakers: 6 })` → `{ min:1, max:6 }`; `computeSpeakerOptions(600_000, { minSpeakers: 2 })` → `{ min:2, max: DEFAULT.maxSpeakers }`.
- `speakerOptionsEnabled: false` (passed via override) → `null`.
- **Floor invariant (not AC9 itself — AC9 lives in `solo-detection`):** `computeSpeakerOptions` returns whatever `minSpeakers` the policy carries, never `speakers_expected` (exact). The "solo not forced to ≥2 *persistent* speakers" guarantee is asserted in `solo-detection.test.ts` + the §8.4 persistence test, which hold for both `min:1` and `min:2`.

**`solo-detection.test.ts`:**
- 1 label → `isSolo: true`, `soloReason: 'single_label'`.
- 0 turns, `durationMs>0` → `failure: 'no_turns'`, `isSolo: true`.
- 2 labels, A=600000ms / B=1000ms → `isSolo: true`, `soloReason: 'dominant_single_speaker'` (B < 3000ms and A dominates ≥0.97).
- 2 labels, A=300000ms / B=120000ms (real 2-person) → `isSolo: false` (B is a real participant).
- `labelCount === max(8)` with `optionsSent={min:1,max:8}` → `failure: 'hit_ceiling'`.
- 3 labels, options `{min:1,max:8}` → `failure: null`, `isSolo: false`.

### 8.2 Provider tests (mock `fetch`, extend `assemblyai-asr.test.ts`)

- **Sends `speaker_options` when `opts.speakerOptions` present:** submit body has `speaker_options` echoing the passed `{ min_speakers_expected, max_speakers_expected }` verbatim (the provider is a thin transport — it does not know or assert the policy default, so this test passes an explicit pair and asserts round-trip) and **NO** `speakers_expected`.
- **Omits `speaker_options` when absent:** body has no `speaker_options` key (back-compat — existing happy-path tests must still pass; they call `transcribe(file, {})` with no `speakerOptions`).
- The existing "forbidden keys" assertion is extended to also assert `expect(body).not.toHaveProperty('speakers_expected')`.

### 8.3 DB tests (extend a new `database-v29.test.ts`, mirror v27 setup)

- `schema_version === 29`; `diarization_runs` table exists; `transcripts.diarization_run_id` column exists.
- `insertDiarizationRun` round-trips; `getLatestDiarizationRun` returns the most recent by `created_at`; `getDiarizationRunsForRecording` returns all, ordered.
- A second insert for the same `recording_id` does NOT overwrite the first (audit trail; both rows present).
- **Structural-repair fallback (§3.6):** `ensureDiarizationSchema()` is a no-op on an already-migrated DB (no error, schema unchanged); and on a DB where `diarization_runs` and/or `transcripts.diarization_run_id` were dropped, calling it re-creates the table/index and re-adds the column (PRAGMA-guarded, idempotent). It does NOT touch `speaker_suggestions` (B's v28 object).

### 8.4 Pipeline integration test (mock the ASR provider + DB, `transcription.ts`)

The existing transcription tests already mock `getAsrProvider`, `getLlmProvider`, and `./database`. Add:
- A diarized run (mocked `asr.transcribe` returns `turns`) results in exactly one `insertDiarizationRun` call with `label_count` matching the distinct labels and `options_min/max` matching the policy for the mocked duration.
- **The diarizing gate (§4):** a NON-diarizing run (mocked `asr.transcribe` returns `{ text, language, turns: undefined }`) results in **zero** `insertDiarizationRun` calls, `classifyRunOutcome` is never invoked, and `upsertTranscriptStage1` is called with `diarization_run_id` undefined. This is the regression test that prevents a `provider:'gemini'`/`label_count:0`/`is_solo:true` row from ever being written.
- A 1-min recording (diarizing provider) → `asr.transcribe` called with `speakerOptions: undefined` (policy returned null) and `insertDiarizationRun` records `options_min/max = null` (the gate still fires because `turns` is defined; only the policy hint is null).
- `insertDiarizationRun` throwing does NOT throw out of `transcribeRecording` (best-effort).

### 8.5 IPC test (extend/clone `speakers-handlers.test.ts` pattern)

- `diarization:getLatestRun` with a valid id returns `success(run)`; invalid id → `VALIDATION_ERROR`; DB throw → `DATABASE_ERROR`.

**What is explicitly NOT testable in unit scope (manual/calibration, rev-2 §11/AC14):** whether `min:1 / max:8` is the *right* range for the user's real solo/1:1/medical/church/business recordings, and whether the dominance thresholds catch real solo over-splits without swallowing real short interjections. **This is the calibration gate named in the Authority note, and it is a HARD precondition to ship `min:1` — blocking, not a follow-up:** before the `[1, 8]` default is locked into a build, run the `{min:1,max:8}` permutation through `aai-diarization-tune.mjs` (one extra `['range-1-8', …]` line) on real solo/1:1/medical audio and confirm `min:1` does not produce gratuitous solo over-splits beyond what §6.3 catches — the probe today only validated `min:4–8`, never `min:1`. **If this gate has not been run and passed, the build ships `minSpeakers: 2` (rev-2 §9's recommended value), which satisfies AC9 via the §6.3 solo flag + banking gates with no embeddings.** These require the labeled multi-type calibration set (rev-2 §11) and are a calibration gate, not a unit test. The spec ships sane, conservative, config-overridable defaults; calibration re-confirms before `min:1` (or any auto-apply, which is Phase 7 anyway).

---

## 9. Acceptance criteria (mapped to rev-2)

- **AC1 (instrumentation) — PRIMARY.** Every AssemblyAI transcription writes a `diarization_runs` row storing the `speaker_options` sent (`options_min/max/_json`), the label count returned, transcript id, run id, provider, model, and timestamps. Verified by §8.3 + §8.4. *(This closes the gap left by the 2026-06-17 foundation, which stored none of this.)*
- **AC9 (solo).** A one-speaker recording is never forced to ≥2 ***persistent*** speakers. The guaranteeing mechanism is **(b)**: over-split solos are flagged `is_solo` (§6.3) and never auto-promoted to `recording_speakers` (banking is gated on clean + corroborated + explicit user confirmation), so no over-split label ever becomes a persistent contact — this holds with **either** floor value and is rev-2 §9's documented path. **(a)** the `min_speakers_expected: 1` floor (§6.2) is an *additional, calibration-gated source-level guarantee*, a deliberate §15 divergence from rev-2 §9's recommended `min 2`, **not** required to meet AC9. Verified by §8.1 (`solo-detection`) + the persistence argument (§6.3); §8.2 asserts the floor value matches whichever default ships.
- **Conservative static floor (rev-2 §9).** One static range, biased to over-split (generous `max`) but capped (`max` < AAI's default 10/30 ceiling). The default ships `[1, 8]` **iff the calibration gate passes** (Authority note item 2); otherwise `[2, 8]` per rev-2 §9's recommended value. `min:1` is a calibration-gated §15 divergence, not an AC requirement; under-split is bounded by the capped `max` and surfaced as `hit_ceiling`, not eliminated by the floor. **No probe, no type inference** (§1.3). Verified by §8.1 + §8.2.
- **Failure budgets (rev-2 §9).** A run that pins the ceiling is recorded as `failure_reason: 'hit_ceiling'` (the under-split signal); 0-turn runs as `'no_turns'`. Surfaced via stored column + operator log; feeds the Phase-6 backstop. Verified by §8.1.
- **AC11 (re-transcribe), partial.** A re-transcribe re-applies the same policy and inserts a **new** run id (never reuses/overwrites). The backstop *automation* (auto-raising `max`) is Phase 6 — out of scope. Verified by §8.3 (second insert coexists) + §4 re-transcribe note.
- **AC4 (model compatibility), unaffected.** Phase 5 does not compare embeddings; `policy_version` + `model` columns let future tuning be re-derived per model (rev-2 §11).

---

## 10. Explicit non-goals / deferred to sibling sub-projects

- **Embedding matcher / merge-suggester / mixed-label detector** → sub-project B (rev-2 Phase 3). Phase 5 produces the `is_solo` flag and label inventory B consumes, but does not call or depend on B.
- **Recording-type inference, adaptive probe, type→floor range** → rev-2 §13 / Phase 7. Phase 5 is the *static* policy that the research-gated probe would later replace/augment.
- **Backstop automation (auto re-transcribe with raised `max`)** → Phase 6. Phase 5 only flags candidates (`hit_ceiling`).
- **Self auto-apply, voiceprint banking policy** → Phases 4/7.
- **Any speaker-options settings UI** → deferred; config-only in v1 (openQuestion #1).
- **Confidence-weighted / per-segment solo via embeddings** → Phase 7 (we use embedding-free dominance for correctness).

---

## 11. File-change summary

**New:**
- `electron/main/services/asr/speaker-options-policy.ts` (+ `__tests__/speaker-options-policy.test.ts`)
- `electron/main/services/asr/solo-detection.ts` (+ `__tests__/solo-detection.test.ts`)
- `electron/main/ipc/diarization-handlers.ts`
- `electron/main/services/__tests__/database-v29.test.ts`

**Modify:**
- `electron/main/services/asr/asr-provider.ts` — `SpeakerOptions` interface; widen `transcribe` opts.
- `electron/main/services/asr/assemblyai-asr.ts` — conditionally add `speaker_options` to submit body.
- `electron/main/services/asr/__tests__/assemblyai-asr.test.ts` — new assertions (sends/omits `speaker_options`; never `speakers_expected`).
- `electron/main/services/transcription.ts` — compute options, pass to ASR, classify outcome, insert run (best-effort). **Note: B has already modified this file's Stage-1 re-transcribe path (`deleteLabelEmbeddingsForRecording` + `expireSuggestionsForRecording`); C layers its instrumentation on top of B's version, not the 2026-06-17 original (see §4 cross-spec note).**
- `electron/main/services/database.ts` — `SCHEMA_VERSION` → **29**; `MIGRATIONS[29]` (`diarization_runs` + `idx_diar_runs_recording` index + `transcripts.diarization_run_id` column — **v28 is owned by sub-project B**, see §3.5 cross-spec note); boot-time `ensureDiarizationSchema()` structural-repair fallback (§3.6); `insertDiarizationRun`/`getLatestDiarizationRun`/`getDiarizationRunsForRecording`; widen `upsertTranscriptStage1` with optional `diarization_run_id`.
- `electron/main/services/config.ts` — `transcription.diarization` sub-section + defaults.
- `electron/main/ipc/handlers.ts` — register `registerDiarizationHandlers`.
- `electron/preload/index.ts` + `index.d.ts` — `diarization.getLatestRun` bridge + type.
- `electron/main/services/__tests__/transcription*.test.ts` — pipeline instrumentation assertions.

**Quality gate (from `apps/electron`):** `npm run typecheck && npm run lint && npm run test:run`.
