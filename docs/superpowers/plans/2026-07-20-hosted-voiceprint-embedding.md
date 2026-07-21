# Plan: Voiceprint enrollment on the hosted hub (plain Node)

**Date:** 2026-07-20
**Status:** Proposed (implementation not started)
**Symptom:** People never accumulate enrolled voiceprints; voices are never identified, even after assigning a speaker to lots of content.

## Root cause (confirmed)

Voiceprint capture is fully implemented for **Electron**, but the hosted hub runs **plain Node** (`node out/server/index.js`), where it is a *designed no-op*:

1. `voiceprint-worker-pool.ts` runs embedding in Electron's `utilityProcess`. Under plain Node that API is absent, so `embedSamples()` logs *"utilityProcess unavailable under plain Node — skipping embedding (hosted no-op)"* and resolves `null` (`voiceprint-worker-pool.ts:86-101`).
2. `modelPath()` returns `''` when `electron` can't be imported (`voiceprint-service.ts:334-346`).
3. `captureVoiceprint()` therefore returns `{captured:false, reason:'embedding-failed'}` and never calls `insertVoiceprint()` — silently.
4. The matcher/`getSuggestions` path depends on banked voiceprints (`buildContacts` filters to contacts with active prints), so it also yields nothing.

Additional runtime gaps the fix must close:
- **The ONNX model is not in the runtime image.** `Dockerfile` never copies `resources/models/`, and only `build:unpack/win/mac/linux` run `models:fetch`. `resources/models/` holds just `.gitkeep`.
- **`sherpa-onnx-node` may not be installed in the image.** `Dockerfile:63-64` treats it as an optional "Phase 2" dep and tolerates its absence (`npm rebuild sherpa-onnx-node 2>/dev/null || echo "... not installed"`). If absent, `require('sherpa-onnx-node')` fails and `isVoiceprintAvailable()` is `false`.
- **`isVoiceprintAvailable()` only checks the addon**, not the model file (`voiceprint-service.ts:125-127`) — so absence surfaces as a silent per-capture failure rather than an honest "unavailable" state.

The capture *trigger* is already wired for hosted mode: `electron/server/routes/speakers.ts:150-164` calls `captureVoiceprint`/`embedRecordingLabels`. Once embedding produces a vector under plain Node, rows get written and the whole downstream (People voiceprint badge, `PersonDetail` Voices tab, matcher suggestions) comes alive with no renderer changes.

## Goal

On the hosted hub: assigning a person as a speaker in a recording with ≥10 s clean speech enrolls a voiceprint; People/PersonDetail show enrolled voices; the matcher produces speaker suggestions.

## Approach (5 workstreams)

### 1. Plain-Node embedding backend (`worker_threads`)
Replace the Electron-only `utilityProcess` pool with a runtime-detecting embedder, keeping the public surface identical (`embedSamples(modelPath, sampleRate, samples): Promise<Float32Array|null>`, `shutdownVoiceprintPool()`), so callers (`voiceprint-service.ts`) are unchanged.

- Detect: if Electron `utilityProcess` is available → keep current path; else → `worker_threads.Worker`.
- New worker `electron/main/workers/voiceprint-worker.node.ts` (or make the existing `voiceprint-worker.ts` runtime-agnostic): load `sherpa-onnx-node`, build `SpeakerEmbeddingExtractor({ model: modelPath })`, `compute(stream, false)` (V8 external-buffer flag stays `false`), post the `Float32Array` back.
- CPU-bound work stays off the Fastify event loop (that's the whole point of the worker). Keep the existing `EMBED_TIMEOUT_MS` and "resolve null, never throw" contract.
- Reuse a single warm worker (extractor construction is expensive); serialize requests or use a tiny pool (N=1–2).

### 2. `modelPath()` hosted resolution
When `electron` is unavailable, resolve from config instead of returning `''`:
- Read `HIDOCK_MODELS_DIR` (new env), default `/app/models` in the image; return `join(dir, `${VOICEPRINT_MODEL_ID}.onnx`)`.
- Keep the Electron packaged/dev branches unchanged.

### 3. Model + addon provisioning in the image
- **Addon:** promote `sherpa-onnx-node` so it is reliably installed for linux-x64 in the runtime image (either make the `Dockerfile:64` rebuild non-optional, or confirm the linux prebuild ships and the omit=dev install keeps it). Verify `node -e "require('sherpa-onnx-node')"` in a build smoke step.
- **Model:** add a build stage (or extend `native-deps`) that runs `node scripts/fetch-models.mjs` (sha256-pinned, ~26 MB) and `COPY --from=... /app/resources/models /app/models` into the runtime stage. Set `ENV HIDOCK_MODELS_DIR=/app/models`.
- `deploy-hub.sh` builds on the server over SSH — no change needed beyond the Dockerfile doing the fetch. Confirm the build host has network egress to the k2-fsa release URL (or vendor the model to an internal mirror).
- Confirm `ffmpeg-static`'s binary is present at runtime (Dockerfile already runs its install script, `:59`) since `decodeRecordingPcm16k()` shells out to it.

### 4. Honest availability reporting
- Extend `isVoiceprintAvailable()` (or add `voiceprintReadiness()`) to check **addon AND model file exists AND embedding backend available**. Return a small status object.
- Surface it: the `PersonDetail` Voices tab already reads `config.privacy.enableVoiceprintCapture` (`PersonDetail.tsx:692`); add a parallel "voice recognition unavailable in this deployment" state driven by the readiness check, so the UI never implies enrollment is happening when it can't.

### 5. Tests
- Unit: `worker_threads` embedder returns a 256-dim `Float32Array` for a known PCM buffer (skip/guard when addon+model absent in CI).
- Integration (plain Node, better-sqlite3): after `captureVoiceprint(recording, label, contactId)` with ≥10 s synthetic clean speech, a `voiceprints` row exists (`getContacts().voiceprintCount === 1`). This is the true end-to-end assertion for the hosted path.
- Readiness: `voiceprintReadiness()` reports `unavailable` when the model file is missing; `ready` when present.
- Keep/extend `electron/server/__tests__/guards/electron-reachability.guard.test.ts` so the server never statically imports Electron.

## Risks / open questions
- **Native ABI:** `sherpa-onnx-node@1.13.3` prebuild must match `node:22-bookworm-slim` (glibc). If no prebuild, it needs a build toolchain in the image (currently only in the `native-deps` stage). Verify early with a smoke `require`.
- **CPU/latency & memory:** embedding is CPU-heavy; on a shared Unraid box, cap concurrency and keep the 60 s `MAX_EMBED_SPEECH_MS` bound. Measure per-enrollment time.
- **Image size:** +~26 MB model + sherpa runtime libs. Acceptable, note it.
- **Backfill:** existing contacts assigned before the fix won't have prints. Optional follow-up: a one-shot "re-embed assigned recordings" job. Out of scope for v1.
- **Model egress at build time:** if the build host can't reach GitHub releases, vendor the model to an internal artifact store and point `fetch-models.mjs`/the Dockerfile at it.

## Sequencing
1. Workstream 1 + 2 behind the existing null-safe contract (no behavior change until a model is present).
2. Workstream 3 (image) — makes it actually run on the hub.
3. Workstream 4 (honest UI) — can land in parallel; independently valuable even before embedding works.
4. Workstream 5 throughout (TDD).

Smallest shippable slice that fixes the symptom: **1 + 2 + 3**. Workstream 4 is the honest-degradation safety net if 3 is delayed.
