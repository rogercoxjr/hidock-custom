# Voice Library & Auto-ID for On-Device Diarization — Design Spec

**Date:** 2026-06-19
**App:** `apps/electron` (universal knowledge hub)
**Status:** Design (brainstormed; pending user review → implementation plan)
**Builds on:** the shipped speaker-diarization feature (`2026-06-17-speaker-diarization-design.md`) — AssemblyAI Universal-3 Pro one-call ASR, `transcripts.turns`, `recording_speakers` + `voiceprints` tables, the Speakers panel in `SourceReader.tsx`, and the now-working on-device voiceprint engine (`voiceprint-service.ts`, WeSpeaker `wespeaker_en_voxceleb_resnet34_LM`, 256-dim, `compute(stream, false)`).

---

## 1. Problem

The HiDock P1 is a **standalone physical recorder**. Unlike a meeting app, there is **no calendar invite and no attendee list** to tell us how many people are in a recording — so the proven accuracy lever, AssemblyAI's `speaker_options.min_speakers_expected`, has no obvious source. Left to its defaults, AssemblyAI **under-counts**: it merges similar voices (e.g. a mother and daughter) into one label and absorbs short interjections into a neighbor's turn (confirmed on `2026Jun16-122033-Rec04.wav`: 3 labels found for 4 real people; a doctor's question and the user's answer collapsed into one turn).

Two asymmetries drive the whole design:

- **Under-split is unrecoverable; over-split is recoverable.** You cannot split one label into two people after the fact (the audio is already one labeled blob), but you *can* merge two labels that are really one person. So we must bias toward over-splitting.
- **The recordings are personal and recurring.** The user is in **every** recording, and the other voices are largely **repeat players** (family, a handful of doctors) — though new/one-off voices appear regularly too.

## 2. Principle: recognition over enumeration

We do not try to *count* speakers. We **recognize** them. A single engine — a per-label voice embedding (the existing 256-dim WeSpeaker model) — feeds three kinds of suggestion into the Speakers panel, and **every confirmation makes the system smarter** (active learning):

1. **Identity match** — "This label is probably Robyn" (label embedding ≈ a known contact's voiceprint).
2. **Over-split merge** — "Labels A and C are the same voice — merge?" (two labels' embeddings ≈ each other within one recording).
3. **Unknown** — map it manually, which banks a new voiceprint for next time.

The speaker *count* becomes almost irrelevant: match the knowns, over-split the rest, suggest merges, learn as you go.

## 3. User decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Scope | **One comprehensive spec** for the whole identity system (all 6 parts below) |
| Common case | **Mostly recurring people + some new** → need both a voice library AND a clean unknown-handling fallback |
| Bias | **Over-split, never under-split** — over-split is cleaned up for free by the merge-suggester |
| How to know speaker scale | **Infer recording *type* from the transcript** (no per-recording tagging by the user) |
| Type → floor | A **recording-type → `speaker_options` range** table (§5) |
| Type detection | An **adaptive probe**: cheap incremental scout passes, escalate while the classifier is `UNCERTAIN`, capped (§6) |
| Re-transcribe on detected under-count | **Suggest, one-tap to confirm** (no surprise spend on the metered tier) — used only as a backstop when the probe was fooled |
| Auto-apply vs suggest | **Suggest, don't auto-apply** identity/merge — except the user's **own** enrolled voice, which is safe to auto-apply |
| Self-enrollment | **"Mark a label as me"** the first time (no separate recording chore); auto-matched thereafter |
| Calibration | Thresholds, probe params, and type ranges are **empirically calibrated on the user's real recordings** before being relied upon (§12) |

## 4. Architecture & data flow

```
Recording synced
   │
   ▼
(A) Adaptive type probe  ── clip next chunk (skip leading silence) → text-only transcribe →
   │                         Ollama classifies {1:1|Appointment|Meeting|Service|UNCERTAIN};
   │                         while UNCERTAIN and under cap: transcribe NEXT chunk, accumulate text, re-classify
   ▼
type → speaker_options { min, max }  (§5)
   │
   ▼
(B) Full pass  ── AssemblyAI transcribe the WHOLE file ONCE with that floor → labels + turns (existing Stage-1)
   │
   ▼
(C) Auto-embed every label  ── decode → ≤60 s clean slice per label → sherpa compute(…, false) → 256-dim
   │                            (deferred off the main thread; skip labels with <10 s clean speech)
   ▼
(D) Match each label embedding against:
   ├─ Voice library (self + contacts' voiceprints)  ──►  identity suggestion ("probably Robyn")
   └─ Other labels in THIS recording                 ──►  merge suggestion ("A = C, same voice")
   │
   ▼
(E) Speakers panel: ranked suggestions → confirm identity / confirm merge / map unknown
   │                  (confirm writes recording_speakers + banks/strengthens the contact's voiceprint)
   ▼
(F) Backstop: the full transcript's Ollama analysis re-checks type/under-count; if it contradicts the probe
              (or finds a Q-and-its-answer in one label), surface one-tap "Re-transcribe as <Type>" (floor pre-filled)
```

## 5. Recording types → `speaker_options` ranges

Starting ranges (to be confirmed in calibration, §12; the Rec04 sweep already showed `min=4` correctly split the 4-person appointment while `min=8` shredded it):

| Type | `min_speakers_expected` | `max_speakers_expected` |
|---|---|---|
| 1:1 | 2 | 3 |
| Appointment | 2 | 6 |
| Meeting | 6 | 12 |
| Service | 8 | 15 |
| (probe `UNCERTAIN` at cap) | 2 | 10 (neutral wide range; lean over, rely on merge-suggester + backstop) |

`speaker_options` is sent on the AssemblyAI `/v2/transcript` request alongside the existing `speech_models`/`speaker_labels`/`keyterms_prompt`/`language_code` (and still **no** `model_region`, **no** `sentiment_analysis` — per the shipped corrections). It is a tolerant min/max *range*, not an exact count.

## 6. Component A — Adaptive type probe

**Purpose:** infer the recording *type* (→ floor range) cheaply, before the full pass, with no user tagging.

**Algorithm:**
1. Determine the probe start by **skipping leading non-speech** (first detected speech; ffmpeg silence-trim or a short VAD). The probe samples *speech*, not setup/silence.
2. Clip the **next `PROBE_STEP_MS`** of audio (default **120 s**) with ffmpeg; transcribe it **text-only (no `speaker_labels`)** — cheaper and faster; classification needs words, not diarization.
3. Append the chunk's text to the accumulated probe transcript. Ask Ollama (the local model already used for analysis) to classify into **`1:1 | Appointment | Meeting | Service | UNCERTAIN`** (a *category*, not a fuzzy probability — small models are unreliable at calibrated confidence).
4. If the result is a concrete type → stop, map to the floor range (§5).
5. If `UNCERTAIN` and total probed audio `< PROBE_CAP_MS` (default **~6 min**) → go to step 2 (transcribe the *next* chunk; never re-transcribe earlier audio).
6. If `UNCERTAIN` at the cap → use the neutral `UNCERTAIN` range (§5) and rely on the merge-suggester + backstop.

**Why this shape (rationale captured for implementers):**
- **Incremental, not cumulative.** Transcribing `0–2, 2–4, 4–6` bills 6 min; `0–2, 0–4, 0–6` bills 12. Always transcribe only the new chunk and accumulate text.
- **Escalate on uncertainty, not word count.** 2 min almost always has enough words; the real failures are *unrepresentative* openings — pre-meeting small talk (lots of words, reads like a 1:1) and music/announcement intros (few words). An "still can't name the type" trigger covers both; a word-count trigger covers only the second.
- **Capped** so a genuinely ambiguous recording can't probe-transcribe half of itself and erase the savings.

**Tunable parameters (calibrated, §12):** `PROBE_STEP_MS` (default 120 000), `PROBE_CAP_MS` (default ~360 000), the leading-silence skip, and the type→range table.

## 7. Component B — Full pass with the inferred floor

The existing two-stage worker runs unchanged except the AssemblyAI request body gains `speaker_options` from the probe's chosen range. One full transcription of the whole file. Turns/labels persist via the existing `upsertTranscriptStage1` path.

## 8. Component C — Auto-embed every label

Today `captureVoiceprint` runs only when the user *maps* a label. This generalizes it to **embed every label automatically** after the full pass:

- For each label, gather its turns, decode the recording to 16 kHz mono PCM (`-f s16le`), slice the label's clean (non-overlapped) speech capped at `MAX_EMBED_SPEECH_MS` (60 s), and compute a 256-dim embedding via `sherpa.compute(stream, false)` (the V8-cage-safe call).
- **Off the main thread** — the embedding pass is deferred (the freeze fix). Embedding *N* labels is *N* bounded computes; run them sequentially in the deferred job so the UI never blocks.
- **Skip** labels with `< MIN_CLEAN_SPEECH_MS` (10 s) clean speech — no reliable embedding; that label stays "unknown / manual" with no suggestion.
- **Persist** per-label embeddings (new table, §11) so the panel can render suggestions without re-decoding.
- Decode the recording **once** and slice all labels from the single PCM buffer (avoid one ffmpeg spawn per label).
- Degrades exactly as today: if sherpa or a usable clip is missing, no embeddings are produced, no suggestions appear, and manual mapping still works.

## 9. Component D — Matching & merge-suggester

A new `voiceprint-matcher` module operating on cosine similarity of L2-normalized 256-dim embeddings.

**Identity matching:** for each label embedding, find the best-matching library voiceprint (the user's own enrolled print + every contact's banked prints; compare to each print or a per-contact centroid).
- similarity ≥ `MATCH_AUTO` → strong match. **Auto-apply only for the user's own voice** (safe, present every time); for others, **suggest** ("probably Robyn — confirm").
- `MATCH_SUGGEST` ≤ similarity < `MATCH_AUTO` → **suggest** with the top one or two candidates.
- below `MATCH_SUGGEST` → no identity suggestion (treat as unknown).

**Merge-suggester (over-split cleanup):** within a single recording, compute pairwise similarity between label embeddings. Pairs ≥ `MERGE_THRESHOLD` → **suggest** merging ("A and C are the same voice").
- **Suggest only, never auto-merge.** The one case where two labels are similar but must stay separate is genuinely-similar-but-distinct voices — a mother and daughter. Auto-merging would silently destroy the split we worked to get; a one-tap confirm lets the user decline that pair.
- `MERGE_THRESHOLD` is set *higher* than `MATCH_SUGGEST` (same-person-same-recording embeddings are nearly identical; we want to surface over-splits without flagging the mother/daughter pair).

All thresholds are calibrated (§12).

## 10. Component E/F — Self-enrollment, suggestion UX, and the backstop

**Self-enrollment (E):** the first time the user marks any label as "me" (a designated self contact / `is_self` voiceprint), that embedding is banked as the self print. From then on, the self voice is auto-matched in every recording (the one auto-apply case). No separate recording flow.

**Suggestion UX (E):** the Speakers panel (in the live `SourceReader.tsx` host) renders, per label, the highest-ranked action:
- **Identity suggestion** — "Robyn (likely) · Confirm · Change" (Change opens the existing contact picker / inline quick-add).
- **Merge suggestion** — "A + C look like one person · Merge · Dismiss".
- **Unknown** — the existing manual map control.
Confirming an identity writes `recording_speakers` (with a non-`user` source marking it auto/confirmed) and **banks/strengthens** that contact's voiceprint (active learning). Confirming a merge collapses the labels via the existing `speakers:merge` path.

**Backstop (F):** the full transcript's Ollama analysis (already running for the summary) also re-classifies the type and checks for under-count tells — most reliably *found-speaker-count < the classified type's min*, and as a bonus a single label containing both a question and its answer. On a hit, the panel surfaces a one-tap **"Re-transcribe as <Type>"** with the corrected floor pre-filled (a second billed pass, user-confirmed — never automatic).

## 11. Data model

Existing (from the diarization feature): `voiceprints(contact_id, model_id, dim, embedding, created_at)`, `recording_speakers(recording_id, file_label, contact_id, source, confidence?)`, `transcripts.turns/speakers`.

Additions:
- **Self voiceprint** — a designated self contact, or an `is_self` flag on `voiceprints` (a contact representing the device owner). One per install.
- **`recording_label_embeddings`** (new) — `recording_id, file_label, model_id, dim, embedding (BLOB), created_at`. Per-label embeddings from Component C, so suggestions render without re-decoding. Cleared/recomputed on re-transcribe.
- **Recording type** — store the probe's classified type + the `speaker_options` range used, on the recording or transcript row (needed for display and for "re-transcribe as <type>").
- **`recording_speakers.source`** — extend the vocabulary to distinguish `user` (manual), `auto` (self auto-applied), `confirmed` (a suggestion the user accepted). Used for analytics and to avoid re-suggesting.

## 12. Calibration (required gate, like the diarization AC0)

The starting numbers in this spec are hypotheses. Before the system is relied upon, run a calibration pass against the user's **real recordings of each type** (medical appointment, church service, business meeting, 1:1) — the same empirical method as the Rec04 `speaker_options` sweep:

- **Type ranges (§5):** confirm each type's min/max produces correct separation without shredding.
- **Probe (§6):** confirm `PROBE_STEP_MS` / `PROBE_CAP_MS` and the classifier reliably name the type from the opening; measure how often the probe is fooled (→ backstop rate).
- **Thresholds (§9):** set `MATCH_AUTO`, `MATCH_SUGGEST`, `MERGE_THRESHOLD` so (a) the user's own voice auto-matches reliably, (b) over-split labels are flagged for merge, and (c) the mother/daughter pair is *not* auto-merged.

Deliverable: the tuned constants, recorded in the implementation, with the calibration recordings/results noted.

## 13. Cost & degradation

- **Passes per recording:** probe (a few cheap text-only minutes, incremental) + **one** full transcription. A second full pass happens only via the user-confirmed backstop. This is the minimum that still avoids under-counts.
- **Metered tier:** AssemblyAI bills per audio-minute per pass; the probe adds a small fixed overhead and *saves* full re-transcribes on the heavy (church/business) cases. Re-transcribe is always user-confirmed.
- **Graceful degradation:** sherpa or model missing → no embeddings → no suggestions, manual mapping intact (today's behavior). Probe/Ollama unavailable → skip type inference, use the neutral floor, rely on the backstop. None of these block transcription or mapping.

## 14. Non-goals (v1 of this system)

- **Cross-device / cloud voiceprint sharing** — the library is local to this install.
- **Splitting a single under-segmented label into two people post-hoc** — impossible from labels alone; the floor + re-transcribe is the only remedy.
- **Mid-utterance word-level speaker splitting** — AssemblyAI per-word speaker is still dropped (a separate future enhancement; v1 keeps one label per utterance).
- **Server-side AssemblyAI Speaker Identification** (`known_values`) — evaluated; it only *names* labels the diarizer already produced, so it doesn't fix the under-count; deferred.
- **Auto-merging** similar voices — always suggest, never auto (mother/daughter protection).

## 15. Acceptance criteria

- **AC1 (floor on request):** the AssemblyAI request carries `speaker_options { min_speakers_expected, max_speakers_expected }` derived from the inferred type; a recording with no type inferred uses the neutral range.
- **AC2 (adaptive probe):** type detection runs as incremental text-only chunks, accumulates text, escalates only while the classifier returns `UNCERTAIN`, never re-transcribes earlier audio, and stops at the cap.
- **AC3 (auto-embed):** after a full pass, every label with ≥10 s clean speech gets a persisted 256-dim embedding; embedding runs off the main thread (no UI freeze); missing sherpa/clip degrades to no-suggestion + manual mapping.
- **AC4 (identity suggestions):** each embeddable label is matched against the library; the user's own voice auto-applies; other matches above threshold appear as one-tap suggestions; confirming banks/strengthens that contact's voiceprint.
- **AC5 (merge suggestions):** within a recording, near-identical label pairs are surfaced as one-tap merge suggestions; merges are never auto-applied.
- **AC6 (self-enrollment):** marking a label "me" once banks the self print and auto-matches it in later recordings.
- **AC7 (backstop):** when the full transcript indicates an under-count for the classified type, the panel offers a one-tap "Re-transcribe as <Type>" with the floor pre-filled; it never re-transcribes without confirmation.
- **AC8 (calibration):** type ranges, probe params, and thresholds are tuned against real recordings of each type and recorded.

## 16. Suggested implementation phases

The user chose one spec; these are *build* phases the implementation plan can sequence (each independently testable), not separate specs:

1. **Floor on request + adaptive probe** (§5–7) — type inference drives `speaker_options`. Immediate accuracy win on the under-count bug.
2. **Auto-embed every label** (§8) — the shared embedding foundation.
3. **Matcher + merge-suggester + suggestion UX** (§9–10 E) — identity/merge suggestions, self-enrollment.
4. **Backstop + calibration** (§10 F, §12) — re-transcribe-as-type and tuned constants.
