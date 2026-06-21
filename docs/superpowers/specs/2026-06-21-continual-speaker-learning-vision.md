# Continual Speaker Learning — Vision Note (future sub-project)

**Status:** Vision / future sub-project. NOT scheduled. Captured 2026-06-21 during the
`getSuggestions` performance work so the idea isn't lost. This is intentionally a
high-level note, not a spec — each loop below becomes its own brainstorm → spec → plan
cycle when picked up.

## Goal

Make the system get **better the more it's used**: voiceprints should sharpen and
diarization should resolve more turns to real people over time, so each correction makes
the next recording need fewer corrections.

## The two loops (and what already exists vs. what's missing)

### Loop 1 — Voiceprints improve as the user confirms speakers (enrollment)

**Already live:** Every confirm banks a voiceprint for the contact (`captureVoiceprint`),
and a contact holds *many* prints. The matcher (`electron/main/services/voiceprint/identity-matcher.ts`,
`scoreLabelAgainstContacts`) already uses a **centroid-of-non-outlier-prints + best-single-print
hybrid** (takes whichever scores higher), so matching genuinely strengthens with each
confirmation today.

**Missing (the quality levers):**
- **Quality-gated banking** — `shouldBankGivenExisting` (`voiceprint-service.ts:332`) is a
  **stub returning `true`**. A noisy or mis-confirmed clip currently gets banked and can
  pollute the centroid. A real consistency gate (reject/flag prints inconsistent with the
  existing set) is the single biggest quality lever. *Highest value, lowest cost.*
- **Pruning / decay** — cap prints per contact; retire low-quality or stale prints; keep a
  representative set. Today prints only accumulate.
- **Negative signal** — per-turn corrections ("this turn is *not* X", via
  `transcripts:updateTurns`) are currently discarded; they're a strong training signal.
- **Self-calibrating thresholds** — `voiceMatching.calibrated` is `false` (uncalibrated
  defaults). As labeled data accumulates, fit suggest/auto/merge thresholds to *this* library.

### Loop 2 — Diarization improves as the library grows (voiceprint-guided)

**Today:** Diarization is **fully unsupervised** — the engine gets only a min/max speaker
count (`electron/main/services/asr/speaker-options-policy.ts`) and emits anonymous labels
A/B/C; the voice library is matched **post-hoc** and never fed back into diarization. Every
new recording starts from scratch.

**Missing:**
- **Cheap path (any engine, incl. Gemini):** keep unsupervised diarization, add a
  **library-guided relabel pass** that assigns each cluster to a known contact when the
  match is confident, and re-splits/merges clusters that disagree with the library. As the
  library grows, more clusters auto-resolve and fewer anonymous labels remain.
- **Deep path (engine-dependent):** true enrollment-guided diarization seeded with known
  prints. AssemblyAI / pyannote support speaker enrollment; Gemini does not — so this is
  provider-specific.

## The flywheel

`confirm / correct` → cleaner prints (Loop 1) → more confident library-guided labeling
(Loop 2) → fewer anonymous labels → fewer corrections on the next recording.

## Suggested decomposition (each its own spec when picked up)

1. **Enrollment quality** — quality-gated banking (kill the `shouldBankGivenExisting` stub)
   + pruning/decay + per-turn negative signal. *Start here; biggest accuracy win, contained.*
2. **Library-guided relabeling** — the cheap post-diarization relabel pass (provider-agnostic).
3. **Enrollment-guided diarization** — provider-specific (AssemblyAI/pyannote), larger.
4. **Self-calibration** — fit thresholds to the accumulated labeled set.

## Relationship to the in-flight performance work (not throwaway)

The `getSuggestions` window-embedding persistence spec is **foundational** for this:
- Persisted embeddings make a relabel pass (Loop 2, cheap path) inexpensive to run.
- The per-turn-reassign invalidation surfaced by that spec's adversarial review is exactly
  the "corrections must propagate" plumbing the flywheel depends on.

So: finish the perf spec first; it lays groundwork. Then pick up sub-project (1).
