# Voice Library & Auto-ID for On-Device Diarization — Design Spec

**Date:** 2026-06-19
**App:** `apps/electron` (universal knowledge hub)
**Status:** Design rev 2 (post adversarial-review + Phase-0 validation; pending user review → implementation plan)
**Builds on:** the shipped speaker-diarization feature (`2026-06-17-speaker-diarization-design.md`) and the on-device voiceprint engine (`voiceprint-service.ts`, sherpa-onnx-node, `compute(stream, false)`).

> **Rev 2 — what changed and why.** Rev 1 (infer recording *type* → set a high `min_speakers_expected` floor → diarize → embed → match/merge → backstop) was put through two independent adversarial reviews and a front-loaded Phase-0 validation spike. The reviews converged on one verdict: rev 1 steered the diarizer on speculative inference *before* proving the embedding foundation, reversed a prior shipped decision without rebutting it, and deferred all the hard accuracy proofs to "calibration" scheduled last. The Phase-0 spike then produced hard evidence that reshapes the design:
> - **The embedding model was the binding constraint, and it's fixable.** WeSpeaker (current) gives ~26.8% cross-recording EER on real far-field P1 audio — unusable. **3D-Speaker ERes2Net** gives **~0.8% EER on clean labels (~9.5% with contaminated labels)** and cleanly separates same-person from different-people (medians 0.76 vs 0.10). TitaNet was middling (18.5%); CAM++ failed. **ERes2Net is adopted** (256-dim — same as WeSpeaker, no storage migration; 26 MB).
> - **Recognition over enumeration is validated** with that model. The voice-library + merge core is now low-risk and evidence-backed.
> - **The over-split floor / type-probe is demoted to a research-gated phase** (the cost reviewer showed the probe is likely net-negative; the lever's efficacy at separating merged people is still unproven and matters less now that matching + merge work).
> - **Safety/hygiene is now first-class, not a footnote:** clean-speech quality gates, voiceprint provenance + delete/undo (none exists today), no training on provisional/auto labels, negative-feedback storage, a conflict hierarchy, a durable job state machine, a **Solo** type, and privacy/consent.
> Rev 1's body is superseded; this is the authoritative design.

---

## 1. Problem & principle

The P1 is a **standalone recorder** — no calendar invite, no attendee list. AssemblyAI under-counts speakers (merges similar voices, absorbs short interjections). Two asymmetries:
- **Under-split is hard to recover; over-split is recoverable** — but *not free* (every over-split label is a merge the user must vet, plus embedding/UX/data work). **Principle: bias *against* under-splitting, but cap over-splitting aggressively, and treat both errors as costly** (failure budgets in §9).
- **Recordings are personal and recurring** — the user is in nearly every one, and the other voices are largely repeat players (family, a few doctors), with some new/one-off voices.

**The design recognizes people rather than counting them.** One engine — a per-label ERes2Net voice embedding — feeds confidence-ranked suggestions (identity match, over-split merge, unknown). Confirmations grow a local library, but only from clean, corroborated evidence.

## 2. Evidence base (Phase-0 validation — done before this spec)

Measured on the user's real P1 recordings (Rec97/02/04/05/06; medical appointments, far-field):
- **Model trial (Rec04 separability):** ERes2Net & TitaNet open a wide gap between different-people and same-person over-splits; WeSpeaker & CAM++ do not.
- **Cross-recording EER (5 recordings, labeled by the user):** ERes2Net **~0.8% (clean) / 9.5% (with 2 user-flagged mixed labels)**; TitaNet 18.5%; WeSpeaker 26.8%. Same-person cross-recording cosine 0.46–0.89 (median 0.76) vs different-people −0.11–0.46 (median 0.10); separating threshold ~0.42–0.45.
- **Key learning:** the one near-miss positive was a 14-second clip → **enrollment quality/length gates are mandatory** (§6). The two contaminated labels were the user's "mostly-X" mixed labels → **mixed-label detection matters** (§7).

These numbers are directional (small clean positive set, n≈7) but the distribution separation is unambiguous. Calibration (§11) re-confirms on a larger labeled set before auto-apply ships.

## 3. Model: adopt ERes2Net

Replace `wespeaker_en_voxceleb_resnet34_LM` with **`3dspeaker_eres2net` (en VoxCeleb, 16k)** in `voiceprint-service.ts` / `fetch-models.mjs` / `electron-builder.yml` (same bundling pattern; pin SHA). 256-dim → **no `voiceprints` storage migration**. All stored embeddings carry a `model_id`/`model_version`; embeddings from different models are never compared (§8/§10). (Any pre-existing WeSpeaker prints are marked superseded, not compared.)

## 4. Architecture & data flow (foundation-first)

```
Recording synced
   │
   ▼
(B) Full pass  ── AssemblyAI transcribe with a CONSERVATIVE STATIC over-split range
   │              (speaker_options, §9) — no type probe in v1. Labels + turns persist (existing Stage-1).
   ▼
(C) Embed labels  ── decode 16k mono → CLEAN segment selection (§6) → ERes2Net 256-dim, L2-normed.
   │                  Runs in a worker/utilityProcess (NOT setImmediate — see §12), bounded; lazy where possible.
   ▼
(D) For each label embedding, compare against:
   ├─ Voice library (self + recurring contacts; per-print + robust centroid, §10)  ──►  identity suggestion
   ├─ Other labels in THIS recording                                                ──►  over-split MERGE suggestion (cluster-aware, §7)
   └─ within-label window variance / two-contact match                              ──►  SUSPECTED MIXED-label flag (§7)
   ▼
(E) Speakers panel: confidence-ranked suggestions → confirm identity / confirm merge / map unknown.
   │   Confirm writes recording_speakers; banks a voiceprint ONLY when clean+corroborated (§6/§10).
   ▼
(F) Backstop: full-transcript analysis flags likely under-split (evidence-based, §7) → one-tap, user-confirmed
              "Re-transcribe with more speakers" that RESTORES confirmed identities via library re-match (§7).
```

## 5. Scope: ship-now core vs research-gated

**Ship-now core (low-risk, evidence-backed — this spec's primary deliverable):** ERes2Net swap; instrumentation/diarization-run metadata; clean per-label embeddings with provenance/quality; manual identity assignment; **confirmed** identity suggestions; **cluster-aware** merge suggestions; suspected-mixed-label flag; negative-feedback (dismissal) storage; self-enrollment as a *suggestion*; a conservative **static** `speaker_options` range; privacy controls. Depends on no unproven lever.

**Research-gated (separate, each behind its own proof):** recording-type inference + adaptive probe + type→floor; **self auto-apply**; the re-transcribe backstop's automation. Explicitly deferred — see §13.

## 6. Component C — clean label embeddings (quality is the whole game)

- **Clean segment selection (§23 of the review; the spike's circularity caveat):** don't trust raw turns. Drop turns < `MIN_TURN_S` (default 3 s); trim `TRIM_S` (default 0.6 s) inward from each turn edge to avoid speaker-transition bleed; prefer longer turns; cap per-label at `MAX_EMBED_S` (60 s); skip a label entirely if < `MIN_CLEAN_S` (10 s) survives. (These exact gates produced the clean ERes2Net EER; the 14 s near-miss shows they matter.)
- **Off the main thread for real:** the embedding pass runs in a **worker_thread or utilityProcess**, not `setImmediate` (which does not move synchronous native compute off the event loop — see §12). Embedding *N* labels is *N* bounded computes; never block the UI.
- **Decode once**, slice all labels from one PCM buffer; **stream/raise the 256 MB cap** so long Service recordings (the multi-speaker target) aren't silently skipped (§12).
- **Lazy/deferred:** embed after the final transcription pass (not before a possible re-transcribe), and prefer embedding on Speakers-panel open; most one-off voices never need an embedding.
- **Persist** per-label embeddings with full provenance (§8).

## 7. Component D/F — matching, cluster-aware merge, mixed-label detection, backstop

**Identity matching** (cosine, normalized): compare each label to the library (self + per-contact prints and a robust centroid of *high-quality confirmed* prints only, §10).
- `≥ MATCH_AUTO` → strong. **Suggest** (pre-selected). Auto-apply is research-gated (§13) and even then only for self under guardrails.
- `MATCH_SUGGEST ≤ s < MATCH_AUTO` → suggest top 1–2 with a **margin** requirement over the second-best contact.
- below → unknown. Calibrated start (ERes2Net): `MATCH_SUGGEST ≈ 0.42`, `MATCH_AUTO ≈ 0.55` (§11).

**Cluster-aware merge** (not pairwise): build connected components of labels above `MERGE_THRESHOLD`; suggest collapsing each cluster; cap visible suggestions (§9 budget); **suggest-only, never auto**. Guard: never suggest merging two labels that already high-confidence match two *different* contacts.

**Suspected-mixed-label detector (the missing bridge to under-split):** flag a label whose within-label window embeddings have high variance, or that matches two different contacts in different time-slices. This is what actually catches the original bug (one label = two people), far better than rev 1's circular "Q-and-answer in one turn" check (a single speaker asks+answers; transcripts lack truth) — that heuristic is dropped.

**Backstop:** present *evidence*, not just a type — "Label B looks like two voices / matches both Robyn and Tiffany." On confirm, re-transcribe with a higher floor. **Critical: re-transcribe must RESTORE prior confirmed identities** by re-matching the new labels against the now-banked voiceprints — today `recordings:transcribe` calls `deleteRecordingSpeakersForRecording`, which would wipe the user's mapping work; AC requires re-application, and the banner warns of re-lettering. User-confirmed only (no surprise spend).

## 8. Data model

Existing: `voiceprints`, `recording_speakers`, `transcripts.turns/speakers`.

Additions:
- **`recording_label_embeddings`** — `id, recording_id, transcript_id, diarization_run_id, file_label, model_id, model_version, dim, embedding(BLOB), normalized, clean_speech_ms, turn_count, quality_score, status, created_at, updated_at`. Invalidated/recomputed on re-transcribe **and on any label-mutating op** (merge, reassign) — tagged with the diarization-run/generation id so stale rows are detectable.
- **`speaker_suggestions`** — `id, recording_id, transcript_id, kind(identity|merge|mixed|backstop), target_label, target_label_2, contact_id, score, rank, rationale, status(pending|accepted|dismissed|expired), created_at, resolved_at`. Makes dismissal-suppression and AC testing possible; **dismissed suggestions do not reappear for the same transcript version.**
- **Voiceprint provenance** — extend `voiceprints` with `source_recording_id, source_label, clean_speech_ms, quality_score, model_id, model_version, created_from(manual|confirmed|self|import), disabled_at, superseded_by`. **A `deleteVoiceprint`/disable path is required** (none exists today; matching is centroid-able so one bad print must be excisable).
- **Recording type/options** — store the `speaker_options` actually sent, the label count returned, and (when research-gated type inference ships) the classified type + classifier/prompt version.
- **`recording_speakers.source`** — add `confirmed`/`self_auto`/`suggestion_confirmed`; the existing column has a `CHECK(source IN ('user','auto'))` constraint, so this is a **table-rebuild migration** (SQLite can't ALTER a CHECK), not a value add — call it out in the plan.
- **`is_self`** — one self contact, enforced singleton (unique partial index).

## 9. Failure budgets & conservative static floor (no probe in v1)

- **Static `speaker_options`:** send a single conservative over-split-biased range (start ~`min 2 / max 8`, calibrated). Per §1, over-split is the safer error and the merge-suggester cleans it. **No type probe in v1** — the cost reviewer showed it's likely a net surcharge (text-only saves only ~9%, and the backstop is kept anyway), and it's the least-proven lever. Type inference is research-gated (§13).
- **Failure budgets (new):** cap labels surfaced for action, cap merge suggestions shown (rank by relevance; collapse unmapped strangers into a quiet "N other speakers"), require `MIN_CLEAN_S` before a label participates in any suggestion, and offer a "done with this recording / dismiss all."
- **Solo/Dictation (memo, dictation, a service where the user is silent):** the worry is fabricated speakers from forcing a floor onto one voice. Resolution in v1 *without* type detection: a solo recording that the static floor over-splits into 2 same-voice labels is collapsed back to one by the **merge-suggester** (same engine — ERes2Net rates two fragments of one voice ~0.9, well above `MERGE_THRESHOLD`), so the over-split is transient, not persistent (AC9). Crucially, fabricated labels **never poison the library** because banking is gated (clean + corroborated + not-mixed, §10) and a user won't map a fabricated label to a contact. Explicit solo *detection* (forcing `min 1` to skip the over-split entirely) is a research-gated nicety, not required for correctness.

## 10. Print vs centroid; self-enrollment

- **Hybrid:** keep individual prints (with quality + provenance); compute a per-contact **robust centroid from high-quality confirmed prints only**; match against centroid *and* top individual prints; require a margin over the second-best contact; down-weight low-quality/old prints; quarantine outliers.
- **Bank conservatively:** a confirmation banks a print **only** if the source label passes the clean-speech gate **and** is not flagged suspected-mixed **and** the new print is consistent with the contact's existing prints. Distinguish **"accept this label for THIS recording"** (cheap, reversible, no bank) from **"remember this voice"** (banks, ideally after corroboration across ≥2 recordings). **Never train on provisional/auto labels.**
- **Self-enrollment:** "mark a label as me" once → banks the self print (subject to the same gates). In v1 self is matched and **suggested** (pre-selected), not silently auto-applied (§13).

## 11. Calibration (front gate — Phase-0 already done; re-confirm before auto-apply)

Phase-0 established viability (ERes2Net ~0.8–9.5% EER). Before the research-gated auto-apply ships, re-calibrate on a larger labeled set spanning the real types (appointment, service, meeting, 1:1, **solo**, noisy, short, and a similar-voice pair like Robyn/Tiffany), measuring: identity top-1 / FAR / FRR / margin / unknown-rejection; self FAR (target **0%**); merge same-speaker recall vs different-speaker (and similar-voice) false-positive rate; suggestions-per-recording (UX budget). Ship auto-apply only if **self FAR = 0** and merge precision and suggestion-count budgets are met. Constants are **model-versioned config** (re-calibrate if the model id changes — the provider already changed behavior on us: model_region, sentiment).

## 12. Verified code-level fixes (from the reviews; must be in the plan)

- **`setImmediate` ≠ off-thread** (`speakers-handlers.ts`): the N-label embed must use a real worker/utilityProcess; `ext.compute` is a synchronous native call.
- **256 MB PCM cap** (`voiceprint-service.ts`) silently rejects ~2.3 h+ recordings (long services) → stream the decode or raise/scope the cap.
- **`recording_speakers.source` CHECK constraint** → table-rebuild migration (§8).
- **Backstop wipes mappings** (`deleteRecordingSpeakersForRecording` on re-transcribe) → must restore via re-match (§7).
- **No `deleteVoiceprint` path** exists → add it (§8).

## 13. Research-gated (deferred; each needs its own go/no-go)

- **Recording-type inference + adaptive probe + type→floor range.** Deferred: likely net-negative cost; efficacy at *forcing* a merged-pair split is unproven; the conservative static floor + merge-suggester covers the common cases. If revisited: fold type classification into the existing full-transcript Ollama analysis (not a separate probe), and prove the floor actually separates a known merged pair before relying on it.
- **Self auto-apply.** Only after calibration shows self FAR = 0, with ≥2 high-quality confirmed self prints, never on Solo/Service, never trained on its own auto-labels, always undoable and visibly distinct.
- **Backstop automation** (auto re-transcribe) — v1 is suggest-and-confirm only.

## 14. Privacy & consent (voiceprints are biometric-ish; recordings are medical)

Local-only by default; **no voiceprint upload**; **per-contact delete voiceprints**; a **"disable voice recognition"** toggle; **exclude voiceprints from cloud sync/backups** unless explicitly enabled; encryption-at-rest consistent with the app's existing secure-storage story; a clear in-UI explanation. Medical-appointment audio is sensitive — treat the library accordingly.

## 15. Conflict resolution hierarchy (deterministic)

1. Manual user assignment wins over everything.
2. Confirmed suggestion > auto/provisional.
3. A merge involving two *different confirmed contacts* requires a high-friction warning (it collapses two identities) — never one-tap.
4. Re-transcription creates a **new** diarization run; old assignments are not blindly reused — they are re-matched, not migrated by label name.
5. Multiple labels matching self → suggest a self-merge, don't auto-apply to all.
6. Auto-learning never consumes provisional/auto labels.

## 16. Conceptual model (keep these distinct)

**Label** (diarizer output, one transcript run) ≠ **speaker assignment** (label→person for one recording) ≠ **contact/person** (user-facing identity) ≠ **voiceprint** (one embedding sample) ≠ **centroid/profile** (aggregate). One contact has many prints; one label can contain multiple people; one person can be many labels.

## 17. Non-goals (v1)

Cross-device/cloud voiceprint sharing; post-hoc splitting of an under-segmented label from labels alone (only re-transcribe fixes it); mid-utterance word-level speaker splitting; server-side AssemblyAI Speaker Identification; auto-merge of similar voices.

## 18. Acceptance criteria (failure-mode-shaped)

- **AC1 (instrumentation):** every transcription stores the `speaker_options` sent, label count returned, transcript/run id, model id, timestamps.
- **AC2 (clean embeddings):** label embeddings are produced only from segments passing `MIN_TURN_S`/`TRIM_S`/`MIN_CLEAN_S`; each stores model id/version, dim, clean-speech ms, quality, source label/run.
- **AC3 (off-thread):** embedding the N labels of a long (≥2 h) recording does not stall the main thread (worker/utilityProcess; not `setImmediate`); long recordings are not silently skipped by the PCM cap.
- **AC4 (model compatibility):** embeddings of differing model id/dim are never compared.
- **AC5 (identity):** suggestions require threshold **and** margin over second-best; confirming banks a print only if clean + not suspected-mixed + consistent.
- **AC6 (self):** self is **suggested** (pre-selected), not silently auto-applied, in v1; "mark me" once enrolls.
- **AC7 (merge):** suggestions are cluster-aware, capped, dismissals persist for the transcript version; merging two different confirmed contacts requires explicit warning; merge invalidates/recomputes affected embeddings.
- **AC8 (mixed-label):** a label containing two voices is flagged via within-label variance / two-contact match (not the Q&A heuristic).
- **AC9 (solo):** a one-speaker recording is not forced to ≥2 persistent speakers.
- **AC10 (similar voices):** the Robyn/Tiffany-type pair is neither auto-merged nor mis-assigned at the calibrated thresholds.
- **AC11 (re-transcribe):** a new diarization run invalidates stale embeddings/suggestions; prior confirmed identities are restored by re-match, not wiped; the user is warned.
- **AC12 (undo & delete):** auto/confirmed assignments are undoable; a wrong-match control un-banks the specific print it produced; `deleteVoiceprint` exists.
- **AC13 (privacy):** per-contact voiceprint delete + a disable-recognition toggle exist; voiceprints are excluded from sync/backups by default.
- **AC14 (calibration):** thresholds accepted only if self FAR = 0 and merge precision + suggestion-count budgets are met, on a labeled multi-type set.

## 19. Implementation phases (re-sequenced: prove → store → suggest → steer)

1. **ERes2Net swap + instrumentation/storage** — model swap (no migration), diarization-run metadata, per-label embeddings with provenance/quality, the new tables. No product magic yet.
2. **Manual identity + voiceprint hygiene** — manual assign, conservative banking, delete/undo, privacy controls.
3. **Read-only suggestions** — identity + cluster-merge + mixed-label, behind a low-risk surface; dismissal storage; no auto-apply.
4. **User-confirmed suggestions + self-enroll (suggested)** — the Speakers-panel UX, conflict hierarchy.
5. **Conservative static `speaker_options` + failure budgets + Solo handling.**
6. **Backstop (suggest-and-confirm, identity-restoring re-transcribe).**
7. **Research-gated** (separate go/no-go each): type inference/probe; self auto-apply; backstop automation.
