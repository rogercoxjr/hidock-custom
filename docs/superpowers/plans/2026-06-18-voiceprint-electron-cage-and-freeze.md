# Voiceprint Electron-Cage + Freeze Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make voiceprint capture actually work in the Electron main process (it currently throws `External buffers are not allowed` under Electron's V8 Memory Cage) and stop it freezing the UI on long recordings.

**Architecture:** Three small, independent changes to the existing voiceprint capture path — no new dependencies, no process-model change, no leaving Electron. (1) Pass the already-exposed `enableExternalBuffer=false` flag to `sherpa-onnx-node`'s `compute()` so it allocates a V8-owned buffer instead of an external one. (2) Cap the clean-speech audio fed to the extractor to 60 s so `compute()` runs on a bounded clip regardless of recording length. (3) Defer the (already fire-and-forget) capture hook to a later tick with `setImmediate` so the `speakers:assign` IPC returns and the UI updates before any capture work runs on the main thread.

**Tech Stack:** Electron 39 main process (TypeScript, CJS bundle), `sherpa-onnx-node@1.13.3` (native N-API addon), Vitest. All tests mock the native addon; no real hardware/USB/network.

**Why these three (from the 2026-06-18 research):** the installed addon wrapper `node_modules/sherpa-onnx-node/speaker-identification.js:47-49` is `compute(stream, enableExternalBuffer = true) { return addon.speakerEmbeddingExtractorComputeEmbedding(this.handle, stream.handle, enableExternalBuffer) }`. The app calls `compute(stream)` with no second arg, so it defaults to `true`, the addon creates an external ArrayBuffer, and Electron's V8 cage throws **inside** `compute()` before it returns. (The prior commit `56b65d09` that wrapped `compute()`'s *return value* in `new Float32Array(...)` is therefore unreachable under the cage — it is kept here only as a harmless defensive copy that an existing test relies on.) Upgrading the package, going out-of-process (the cage is per-process and inherited), and swapping to `onnxruntime-node` were all evaluated and rejected.

**Quality gate (run from `apps/electron` after each task's tests pass):** `npm run typecheck && npm run lint && npm run test:run`

---

## File Structure

All paths relative to `apps/electron/`.

**Modify:**
- `electron/main/services/voiceprint-service.ts` — the capture service. Task 1 widens the `SherpaModule` `compute` type and passes `false` at the call site; Task 2 adds a `MAX_EMBED_SPEECH_MS` cap inside `pcmToFloat32`.
- `electron/main/services/__tests__/voiceprint-service.test.ts` — Task 1 makes the two AC4 sherpa stubs reject external buffers (so the success test fails unless `false` is passed); Task 2 adds a cap test.
- `electron/main/ipc/speakers-handlers.ts` — Task 3 wraps the capture hook in `setImmediate`.
- `electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts` — Task 3 asserts the capture is deferred (not run on the synchronous IPC path) and updates the two existing tests that assumed synchronous firing.

No files are created. No production code outside these four files changes.

---

## Task 1: Fix the V8-cage error — pass `enableExternalBuffer=false` to `compute()`

**Files:**
- Modify: `electron/main/services/voiceprint-service.ts:94` (the `compute` type) and `:264-267` (the call site + its now-wrong comment)
- Test: `electron/main/services/__tests__/voiceprint-service.test.ts` (the two `SpeakerEmbeddingExtractor` stubs in the `captureVoiceprint() — AC4` describe block, and test `8a`)

- [ ] **Step 1: Make the AC4 sherpa stubs reject external buffers (write the failing condition)**

There are **two** identical `SpeakerEmbeddingExtractor` stub classes in the AC4 describe block of `voiceprint-service.test.ts`: one installed in `beforeAll`, one re-installed in a `finally` block (test `8d` temporarily removes the stub). In **both**, replace the `compute()` method. Current code (appears twice):

```typescript
          compute() {
            return computeResult
          }
```

Replace **both occurrences** with:

```typescript
          compute(_stream: unknown, enableExternalBuffer?: boolean) {
            // Simulate Electron's V8 Memory Cage: the addon default
            // (enableExternalBuffer=true) allocates an EXTERNAL ArrayBuffer that the
            // cage rejects INSIDE compute(). Only an explicit `false` is allowed.
            if (enableExternalBuffer !== false) {
              throw new Error('External buffers are not allowed')
            }
            return computeResult
          }
```

(Leave the `compute()` in test `1.`'s availability stub — the one returning `new Float32Array(this.dim)` — untouched; that test never calls `captureVoiceprint`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts -t "8a"`
Expected: FAIL. The production code calls `ext.compute(stream)` (no second arg), the stub throws `External buffers are not allowed`, `captureVoiceprint` catches it and returns `{ captured: false }`, so `expect(res.captured).toBe(true)` fails.

- [ ] **Step 3: Widen the `compute` type signature**

In `electron/main/services/voiceprint-service.ts`, the `SherpaModule` type (around line 89-96). Change line 94 from:

```typescript
    compute(stream: SherpaStream): Float32Array
```

to:

```typescript
    // enableExternalBuffer defaults to true in the addon; we MUST pass false so it
    // allocates a V8-owned buffer (Electron's V8 cage rejects external buffers).
    compute(stream: SherpaStream, enableExternalBuffer?: boolean): Float32Array
```

- [ ] **Step 4: Pass `false` at the call site and fix the stale comment**

In the same file, the capture block (around lines 264-267). Change:

```typescript
    // sherpa-onnx-node's compute() can return a Float32Array backed by EXTERNAL native
    // memory. Under Electron's V8, persisting a view over it throws "External buffers are
    // not allowed" when sql.js binds the BLOB. Copy into a V8-owned array first.
    const embedding = new Float32Array(ext.compute(stream))
```

to:

```typescript
    // Pass enableExternalBuffer=false: the addon default (true) allocates an EXTERNAL
    // ArrayBuffer that Electron's V8 Memory Cage rejects INSIDE compute() (verified in
    // node_modules/sherpa-onnx-node/speaker-identification.js). false → V8-owned buffer.
    // The new Float32Array(...) copy is now a harmless defensive copy (kept so the stored
    // BLOB never aliases the addon's buffer; an existing test asserts this).
    const embedding = new Float32Array(ext.compute(stream, false))
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts`
Expected: PASS — all 17 tests green. Test `8a` now passes (`compute(stream, false)` returns `computeResult`), and its existing `row.embedding.buffer` not-aliasing assertion still holds because the `new Float32Array(...)` copy is retained.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/rcox/hidock-tools/hidock-next
git add apps/electron/electron/main/services/voiceprint-service.ts apps/electron/electron/main/services/__tests__/voiceprint-service.test.ts
git commit -m "fix(electron): pass enableExternalBuffer=false to sherpa compute (V8 cage)

compute(stream) defaulted enableExternalBuffer=true, so the addon allocated an
external ArrayBuffer that Electron's V8 Memory Cage rejects inside compute() —
voiceprint looked available but every capture failed. The flag is already plumbed
in the installed sherpa-onnx-node@1.13.3 wrapper; pass false for a V8-owned buffer.
Supersedes the misdiagnosed copy-the-result fix (56b65d09), which was unreachable
because compute() never returned. Test stubs now reject external buffers (RED->GREEN).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Cap clean-speech audio fed to the extractor (freeze fix, part A)

**Files:**
- Modify: `electron/main/services/voiceprint-service.ts:116` (add a constant after `MIN_CLEAN_SPEECH_MS`) and `:187-199` (`pcmToFloat32`)
- Test: `electron/main/services/__tests__/voiceprint-service.test.ts` (add a case to the `pcmToFloat32()` describe block)

- [ ] **Step 1: Write the failing test**

In `voiceprint-service.test.ts`, find the `pcmToFloat32()` describe block (it contains tests `8e-1`, `8e-2`, `8e-3`). Add this test inside that block. It builds a PCM buffer for a single 70-second turn (70 s > the 60 s cap) and asserts the output is capped at exactly 60 s of samples:

```typescript
  it('8e-4. caps output at MAX_EMBED_SPEECH_MS (60 s) of samples regardless of turn length', async () => {
    const { pcmToFloat32, MAX_EMBED_SPEECH_MS } = await import('../voiceprint-service')
    const capSamples = (MAX_EMBED_SPEECH_MS / 1000) * 16000 // 60 s × 16000 = 960000
    // One 70 s clean turn for label A → 70 s × 32 bytes/ms × 1000 = 2,240,000 bytes.
    const pcm = Buffer.alloc(70_000 * 32)
    const turns = [{ speaker: 'A', startMs: 0, endMs: 70_000, text: 'long' }] as never
    const out = pcmToFloat32(pcm, turns, 'A')
    expect(out.length).toBe(capSamples)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts -t "8e-4"`
Expected: FAIL — `MAX_EMBED_SPEECH_MS` is not exported yet (`undefined`), so `capSamples` is `NaN` and the import destructure yields `undefined`; the assertion fails (and/or the test errors on the missing export). Either way it is RED.

- [ ] **Step 3: Add the `MAX_EMBED_SPEECH_MS` constant**

In `voiceprint-service.ts`, immediately after `MIN_CLEAN_SPEECH_MS` (line 116):

```typescript
/** §6.7: require ≥10 s of clean (non-overlapped) speech before enrolling. */
export const MIN_CLEAN_SPEECH_MS = 10_000

/** Cap the clean speech fed to the extractor. A speaker embedding saturates well
 *  under a minute; 60 s bounds compute() time (and the slicing loop) so a long
 *  recording can't freeze the main thread. Well above MIN_CLEAN_SPEECH_MS. */
export const MAX_EMBED_SPEECH_MS = 60_000
```

- [ ] **Step 4: Cap the slice loop in `pcmToFloat32`**

Replace the whole `pcmToFloat32` function (lines 187-199) with:

```typescript
export function pcmToFloat32(pcm: Buffer, turns: Turn[], label: string): Float32Array {
  const BYTES_PER_MS = 32 // 16000 samples/s × 2 bytes/sample ÷ 1000 ms/s
  const MAX_SAMPLES = (MAX_EMBED_SPEECH_MS / 1000) * 16000 // 60 s cap (see MAX_EMBED_SPEECH_MS)
  const out: number[] = []
  for (const t of turns) {
    if (t.speaker !== label) continue
    const start = Math.max(0, Math.floor(t.startMs * BYTES_PER_MS))
    const end = Math.min(pcm.length, Math.floor(t.endMs * BYTES_PER_MS))
    for (let i = start; i + 1 < end; i += 2) {
      out.push(pcm.readInt16LE(i) / 32768)
      if (out.length >= MAX_SAMPLES) return Float32Array.from(out) // stop once capped
    }
  }
  return Float32Array.from(out)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts`
Expected: PASS — 18 tests green. `8e-4` now sees `out.length === 960000`; `8e-1/2/3` (small inputs, below the cap) are unaffected; `8a` still passes (its 12 s fixture is below the cap).

- [ ] **Step 6: Commit**

```bash
cd /c/Users/rcox/hidock-tools/hidock-next
git add apps/electron/electron/main/services/voiceprint-service.ts apps/electron/electron/main/services/__tests__/voiceprint-service.test.ts
git commit -m "fix(electron): cap voiceprint clean speech to 60s (freeze fix A)

captureVoiceprint sliced the speaker's ENTIRE clean speech (8+ min on long
recordings) and fed it to a synchronous sherpa compute() on the main thread,
freezing the UI. Cap pcmToFloat32 output to MAX_EMBED_SPEECH_MS (60 s) — plenty
for an embedding, well above the 10 s gate — so compute() runs on a bounded clip.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Defer capture off the `speakers:assign` IPC path (freeze fix, part B)

**Files:**
- Modify: `electron/main/ipc/speakers-handlers.ts:102-108` (the fire-and-forget capture block)
- Test: `electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts` (add a "deferred" test; update tests `1` and `3` to await a tick)

- [ ] **Step 1: Write the failing test for deferral**

In `speakers-assign-voiceprint.test.ts`, add this test inside the `describe('speakers:assign → voiceprint capture (§6.7)', ...)` block:

```typescript
  it('6. defers capture to a later tick — not run on the synchronous assign IPC path', async () => {
    const fn = handlers.get('speakers:assign')!
    await fn({}, { recordingId: 'rec_1', fileLabel: 'A', contactId: 'c_1' })
    // The IPC has returned but capture must NOT have run yet (it would block the
    // main thread; it is scheduled for a later tick).
    expect(vi.mocked(captureVoiceprint)).not.toHaveBeenCalled()
    await new Promise((r) => setImmediate(r)) // let the deferred capture fire
    expect(vi.mocked(captureVoiceprint)).toHaveBeenCalledWith('rec_1', 'A', 'c_1')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts -t "defers capture"`
Expected: FAIL — the current handler calls `void captureVoiceprint(...)` synchronously, so after `await fn(...)` the first assertion `expect(captureVoiceprint).not.toHaveBeenCalled()` fails (it was already called).

- [ ] **Step 3: Wrap the capture hook in `setImmediate`**

In `speakers-handlers.ts`, replace the capture block (lines 102-108):

```typescript
        // Fire-and-forget voiceprint capture (§6.7). NEVER block or fail the mapping:
        // a slow/missing sherpa addon or short clean-speech must not affect assign.
        void captureVoiceprint(recordingId, fileLabel, contactId)
          .then((r) => {
            if (!r.captured) console.log(`[Voiceprint] skipped (${recordingId}/${fileLabel}): ${r.reason}`)
          })
          .catch((e) => console.warn(`[Voiceprint] capture error (${recordingId}/${fileLabel}): ${(e as Error).message}`))
```

with:

```typescript
        // Voiceprint capture (§6.7): NEVER blocks or fails the mapping. Deferred to a
        // later tick with setImmediate so the assign IPC returns and the UI updates
        // before any (synchronous, bounded) embedding work runs on the main thread.
        setImmediate(() => {
          captureVoiceprint(recordingId, fileLabel, contactId)
            .then((r) => {
              if (!r.captured) console.log(`[Voiceprint] skipped (${recordingId}/${fileLabel}): ${r.reason}`)
            })
            .catch((e) => console.warn(`[Voiceprint] capture error (${recordingId}/${fileLabel}): ${(e as Error).message}`))
        })
```

- [ ] **Step 4: Update the two existing tests that assumed synchronous firing**

Tests `1` and `3` assert `captureVoiceprint` was called by the time `await fn(...)` resolves. With deferral they must await a tick first.

Test `1` — change its body from:

```typescript
    const fn = handlers.get('speakers:assign')!
    await fn({}, { recordingId: 'rec_1', fileLabel: 'A', contactId: 'c_1' })
    expect(vi.mocked(captureVoiceprint)).toHaveBeenCalledWith('rec_1', 'A', 'c_1')
```

to:

```typescript
    const fn = handlers.get('speakers:assign')!
    await fn({}, { recordingId: 'rec_1', fileLabel: 'A', contactId: 'c_1' })
    await new Promise((r) => setImmediate(r)) // capture is deferred to a later tick
    expect(vi.mocked(captureVoiceprint)).toHaveBeenCalledWith('rec_1', 'A', 'c_1')
```

Test `3` — add the same `await new Promise((r) => setImmediate(r))` line immediately after its `await fn({}, ...)` call (before the `expect(res.success)` / `callOrder` assertions). `upsert` still runs synchronously in the handler and `capture` runs on the tick, so `callOrder.indexOf('upsert') < callOrder.indexOf('capture')` still holds.

(Tests `2`, `4`, `5` need no change: `2` only checks `res.success`; `4`/`5` return before scheduling, so `captureVoiceprint` is never called even after a tick.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts`
Expected: PASS — all 6 tests green (5 original + the new deferral test).

- [ ] **Step 6: Commit**

```bash
cd /c/Users/rcox/hidock-tools/hidock-next
git add apps/electron/electron/main/ipc/speakers-handlers.ts apps/electron/electron/main/ipc/__tests__/speakers-assign-voiceprint.test.ts
git commit -m "fix(electron): defer voiceprint capture off the assign IPC tick (freeze fix B)

Wrap the fire-and-forget captureVoiceprint hook in setImmediate so speakers:assign
returns and the UI updates before the (now 60s-bounded) synchronous embedding work
runs on the main thread. The mapping is unaffected; capture still never throws.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all three tasks)

- [ ] **Run the full quality gate**

```bash
cd /c/Users/rcox/hidock-tools/hidock-next/apps/electron
npm run typecheck && npm run lint && npm run test:run
```
Expected: typecheck clean; lint 0 errors; full suite green (≈1836 tests — the existing count plus `8e-4` and the new deferral test). One unrelated jsdom perf test (`src/__tests__/performance/library-performance.test.tsx`) may flake under full-suite CPU load — re-run it in isolation to confirm it passes.

- [ ] **Live re-test in the dev app (manual, user-driven — the cage repros only under Electron)**

1. `cd apps/electron && npm run dev`
2. Open a recording with a speaker who has ≥10 s of clean speech (e.g. Rec97 Speaker A).
3. Assign that speaker to a Contact. The assign should feel instant (no freeze).
4. Confirm the main-process log shows **no** `External buffers are not allowed`, and a `voiceprints` row is written (`model_id = wespeaker_en_voxceleb_resnet34_LM`, `dim = 256`).

---

## Self-Review

**1. Spec coverage.** Two problems were specified. (A) V8-cage error → Task 1 (`enableExternalBuffer=false`). (B) UI freeze → Task 2 (cap the audio) + Task 3 (defer off the IPC tick). All covered.

**2. Placeholder scan.** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete before/after code and an exact command with expected output.

**3. Type consistency.** `MAX_EMBED_SPEECH_MS` is defined in Task 2 Step 3 and consumed in Task 2 Step 4 and its test (same name). The `compute` signature widened in Task 1 Step 3 (`compute(stream, enableExternalBuffer?: boolean)`) matches the call in Task 1 Step 4 (`ext.compute(stream, false)`) and the stub signature in Task 1 Step 1 (`compute(_stream, enableExternalBuffer?)`). `captureVoiceprint(recordingId, fileLabel, contactId)` is unchanged and referenced consistently in Task 3.

**Note on the `new Float32Array(...)` copy:** intentionally retained (not removed) in Task 1 — it is now a harmless defensive copy, and test `8a`'s `row.embedding.buffer` not-aliasing assertion depends on it. Removing it would break that assertion; that is out of scope.
