# Fix `transcription:getQueue` Mount Storm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement
> this plan task-by-task. Strict TDD — write the failing test, RUN it and confirm RED for the right
> reason, implement minimally, RUN and confirm GREEN, then commit. Steps use checkbox (`- [ ]`)
> syntax for tracking. Do NOT touch USB/device code. 120-char lines. Files are `eol=lf` — match
> existing EOL, no whole-file reflow. `git add` ONLY the files you changed.

**Goal:** Eliminate the ~580 `transcription:getQueue` IPC calls fired in ~1 second on Library mount,
and add a regression guard so any future caller that storms the channel is caught by a test rather
than in production.

**Tech Stack:** Electron 39 (main + preload + renderer), React 18, TypeScript, Zustand
(`subscribeWithSelector`), Vitest + `@testing-library/react`. Run from `apps/electron`:
`npm run typecheck` and `npx vitest run <path>`.

---

## Investigation summary (evidence — read before writing code)

The storm is **not reproducible from the renderer source on this branch.** Full trace:

- Preload channel mapping — the renderer method is `getTranscriptionQueue`:
  - `apps/electron/electron/preload/index.ts:593` → `getTranscriptionQueue: () => callIPC('transcription:getQueue')`
- Main handler is a thin read, no fan-out:
  - `apps/electron/electron/main/ipc/recording-handlers.ts:405-412` → returns `getQueueItems()`.
- `callIPC` (`preload/index.ts:32-50`) has **no retry/loop**; it only logs `[QA-MONITOR][IPC] <channel>`
  per call (this is how the "580 calls in ~1s" count was observed — one log line per invocation).
- The ONLY renderer caller of `getTranscriptionQueue` is `useTranscriptionSync`
  (`apps/electron/src/hooks/useTranscriptionSync.ts`):
  - mount hydration call at line 24, 5 s poll call at line 126.
  - It is guarded by a per-instance `initializedRef` (lines 13, 16-17) **and** an empty-dep
    `useEffect` (line 185), so a single mounted instance fires **once on mount + once / 5 s**.
- That hook is invoked exactly once, from the singleton `OperationController`
  (`apps/electron/src/components/OperationController.tsx:29`), which lives in Layout, renders `null`,
  and is not per-recording.
- No other path reaches the channel: `getTranscriptionStatus` has **zero** renderer callers; the
  transcription store (`src/store/features/useTranscriptionStore.ts`) never calls the queue API; the
  store selector hooks (`useTranscriptionStats` etc., consumed by `Library.tsx` and
  `OperationsPanel.tsx`) read state only; per-recording rows in `Library.tsx` use `downloadQueue`
  (download queue), not the transcription queue. No `ipcRenderer.invoke` calls exist in `src/`.

**Therefore the task's stated hypothesis (a per-recording component or a React effect loop calling
the method once per render across ~58 recordings) is NOT supported by the current code.** The most
probable explanations, ranked:

1. **Stale observation (most likely).** The 580-call storm predates the current guards. The
   `initializedRef` StrictMode double-init guard was added in commit `867ba720`
   ("guard StrictMode double-init"), and the dead `useTranscriptionStore.loadQueue` — which called a
   then-non-existent `(recordings as any).getQueue()` — was removed/neutralized (see
   `apps/electron/COMPREHENSIVE_BUG_AUDIT.md:177` TQ-07 "dead code", and
   `apps/electron/STABILITY_FIXES.md:238`). A `loadQueue` wired into a per-render or per-row effect on
   an older revision would match the symptom exactly. On HEAD that caller is gone.
2. **HMR / dev remount churn.** In `npm run dev`, Fast Refresh can remount `OperationController`
   repeatedly within a second; each remount mounts a fresh hook instance whose `initializedRef`
   starts `false`, so each remount fires one hydration call. This bursts in dev only, not in a packaged
   build, and self-quiesces. Still worth coalescing.
3. **A future/uncommitted caller** (e.g. an `embeddings`-branch component) added between observation
   and now. Not present in tracked source as of this plan.

Because the live source on HEAD cannot reproduce it, this plan does BOTH: (A) a confirmation
instrumentation step to pin the real source if it recurs, and (B) a defensive coalescing fix +
regression test that is correct and valuable regardless of which suspect is true.

---

## Task 1: Confirm the live source (instrumentation — do this FIRST, no production logic change)

**Files:**
- Modify: `apps/electron/electron/preload/index.ts` (temporary diagnostic inside `callIPC`)

### Why
Before changing behavior, capture ground truth: how many times the channel fires on a single Library
mount, and the renderer call stack of each invocation. This distinguishes suspect 1 (no storm on
HEAD), suspect 2 (storm only under HMR), and suspect 3 (a new caller with a recognizable stack).

### Steps

- [ ] **Step 1.1: Add a temporary per-channel counter + stack capture in `callIPC`.**

In `apps/electron/electron/preload/index.ts`, inside `callIPC` (lines 32-50), add — guarded by
`isQaLogsEnabled()` so it respects the QA Logs toggle — a count and a `console.trace` for the
`transcription:getQueue` channel only:

```typescript
if (channel === 'transcription:getQueue' && isQaLogsEnabled()) {
  ;(globalThis as any).__getQueueCalls = ((globalThis as any).__getQueueCalls ?? 0) + 1
  console.log(`[QA-MONITOR][IPC-COUNT] transcription:getQueue #${(globalThis as any).__getQueueCalls}`)
  console.trace('[QA-MONITOR][IPC-STACK] transcription:getQueue')
}
```

- [ ] **Step 1.2: Run the app (developer does this — agent does NOT launch it), open Library, read logs.**

  - If the count stays at 1 on mount (then +1 every 5 s): the storm is a **stale observation**
    (suspect 1) — the defensive fix in Tasks 2-3 is sufficient and the regression test prevents
    relapse. Record this in the plan's outcome notes.
  - If the count spikes only when files change / Fast Refresh runs: **suspect 2 (HMR)** — coalescing
    (Task 2) absorbs it; note it as dev-only.
  - If the stack points at a renderer module other than `useTranscriptionSync`: that module is the
    **real caller (suspect 3)** — fix it at the source per the cause (debounce the effect, add a
    proper dependency guard, or move the call into the shared hook) and keep Tasks 2-3 as defense.

- [ ] **Step 1.3: Revert the diagnostic before final commit.** The counter/trace is investigation
  scaffolding, not shipped code. Remove it once the source is confirmed. Do not commit Step 1.1.

---

## Task 2: Coalesce concurrent `transcription:getQueue` calls in the preload (defensive fix)

**Files:**
- Modify: `apps/electron/electron/preload/index.ts` (wrap the `getTranscriptionQueue` mapping)
- Test: `apps/electron/electron/preload/__tests__/getQueueCoalesce.test.ts` (new)

### Rationale
A single shared in-flight promise makes the channel storm-proof at the boundary: N synchronous or
near-synchronous callers within one tick collapse to ONE `ipcRenderer.invoke`. This is the minimal,
cause-agnostic mitigation — it neutralizes suspects 1-3 without changing any caller's semantics
(every caller still receives the same resolved array). It does NOT throttle the legitimate 5 s poll
(those calls are >5 s apart, so the in-flight promise has already settled).

### Steps

- [ ] **Step 2.1: Write the failing test (RED).**

Create `apps/electron/electron/preload/__tests__/getQueueCoalesce.test.ts`. The test imports the
coalescing helper (to be added in Step 2.2) and asserts that K concurrent calls resolve to the same
value but invoke the underlying fetch exactly once:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { coalesceInFlight } from '../getQueueCoalesce'

describe('coalesceInFlight — transcription:getQueue storm guard', () => {
  it('collapses concurrent calls into a single underlying invoke', async () => {
    let calls = 0
    const fetch = vi.fn(async () => { calls++; await Promise.resolve(); return [{ id: 'q-1' }] })
    const coalesced = coalesceInFlight(fetch)

    const results = await Promise.all(Array.from({ length: 580 }, () => coalesced()))

    expect(calls).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    results.forEach((r) => expect(r).toEqual([{ id: 'q-1' }]))
  })

  it('issues a fresh invoke once the prior call has settled', async () => {
    const fetch = vi.fn(async () => [])
    const coalesced = coalesceInFlight(fetch)
    await coalesced()
    await coalesced()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
```

Run: `cd apps/electron && npx vitest run electron/preload/__tests__/getQueueCoalesce.test.ts`
Expected RED: module `../getQueueCoalesce` does not exist (import error).

- [ ] **Step 2.2: Implement the helper minimally (GREEN).**

Create `apps/electron/electron/preload/getQueueCoalesce.ts`:

```typescript
/**
 * coalesceInFlight — wrap an async fetch so that all callers arriving while a call
 * is in flight share that single promise. Once it settles, the next call starts fresh.
 * Used to make transcription:getQueue storm-proof at the preload boundary without
 * changing caller semantics (every caller still receives the resolved value).
 */
export function coalesceInFlight<T>(fetch: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    if (inFlight) return inFlight
    inFlight = fetch().finally(() => { inFlight = null })
    return inFlight
  }
}
```

Run the same vitest command. Expected GREEN (both tests pass).

- [ ] **Step 2.3: Wire the helper into the preload mapping (GREEN, no new test logic).**

In `apps/electron/electron/preload/index.ts`, near the top add `import { coalesceInFlight } from './getQueueCoalesce'`
(match existing import grouping/EOL). Replace the line 593 mapping:

```typescript
getTranscriptionQueue: () => callIPC('transcription:getQueue'),
```
with a coalesced version (define the wrapped fetch once at module scope so the in-flight promise is
shared across all callers, not recreated per call):

```typescript
const getTranscriptionQueueCoalesced = coalesceInFlight(() => callIPC('transcription:getQueue'))
// ...inside recordings: { ... }
getTranscriptionQueue: () => getTranscriptionQueueCoalesced(),
```

Run: `cd apps/electron && npm run typecheck` — expected: clean (no new errors in touched files).
Run: `cd apps/electron && npx vitest run electron/preload/__tests__/getQueueCoalesce.test.ts` — GREEN.

- [ ] **Step 2.4: Commit.** `git add` ONLY `apps/electron/electron/preload/index.ts`,
  `apps/electron/electron/preload/getQueueCoalesce.ts`,
  `apps/electron/electron/preload/__tests__/getQueueCoalesce.test.ts`. Message e.g.
  `fix(electron): coalesce concurrent transcription:getQueue IPC calls`. Append exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## Task 3: Regression guard — `useTranscriptionSync` fires exactly once on mount

**Files:**
- Test: `apps/electron/src/hooks/__tests__/useTranscriptionSync.test.ts` (extend existing suite)

### Rationale
The hook is the legitimate caller; lock in its contract so a future refactor that re-introduces a
per-render fetch (the suspect-1 regression) is caught by a unit test. This test asserts the call
count on mount, independent of the preload coalescing, so it pins the renderer-side behavior directly.

### Steps

- [ ] **Step 3.1: Add the failing-if-regressed test (should be GREEN against current correct code).**

Append to `apps/electron/src/hooks/__tests__/useTranscriptionSync.test.ts` a case that mounts the
hook once and asserts the mock `getTranscriptionQueue` was called exactly once before any timer
advances (i.e. a single mount-hydration call, no loop):

```typescript
it('calls getTranscriptionQueue exactly once on mount (no storm)', async () => {
  const spy = vi.fn().mockResolvedValue([])
  ;(window.electronAPI.recordings.getTranscriptionQueue as any) = spy

  renderHook(() => useTranscriptionSync())
  await vi.advanceTimersByTimeAsync(0) // flush mount hydration .then()

  expect(spy).toHaveBeenCalledTimes(1)

  // One poll tick adds exactly one more call (not N).
  await vi.advanceTimersByTimeAsync(5000)
  expect(spy).toHaveBeenCalledTimes(2)
})
```

Run: `cd apps/electron && npx vitest run src/hooks/__tests__/useTranscriptionSync.test.ts`
Expected: GREEN on current code. If a future change makes it RED, the storm regressed — fix the
offending caller. (To prove the test has teeth during this task: temporarily duplicate the line 24
hydration call, confirm the test goes RED reporting 2 mount calls, then revert.)

- [ ] **Step 3.2: Commit.** `git add` ONLY
  `apps/electron/src/hooks/__tests__/useTranscriptionSync.test.ts`. Message e.g.
  `test(electron): guard useTranscriptionSync against getQueue mount storm`. Append exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## Task 4 (conditional): Fix the real caller if Task 1 identifies suspect 3

**Only if** Step 1.2 surfaced a renderer module other than `useTranscriptionSync` calling the channel.

**Files:** the offending module (TBD from the captured stack) + a co-located `__tests__` test.

### Steps

- [ ] **Step 4.1:** Read the offending module and grep its callers before editing.
- [ ] **Step 4.2:** Write a failing test reproducing the per-render/loop fetch (RED).
- [ ] **Step 4.3:** Apply the minimal cause-specific fix:
  - per-render call → move it behind a mount-only `useEffect` with the correct dependency array, or
    route it through the shared `useTranscriptionSync` instead of a second subscriber;
  - effect loop → fix the dependency array / add a value guard so the effect does not re-run each
    render;
  - event handler re-fetch → debounce or rely on the live `onTranscription*` events already wired in
    `useTranscriptionSync` (lines 48-118) instead of re-polling the queue.
- [ ] **Step 4.4:** Run the new test (GREEN) + `npm run typecheck`. Commit ONLY the changed files with
  the required trailer.

---

## Verification (before claiming done)

- [ ] `cd apps/electron && npm run typecheck` — clean for all touched files.
- [ ] `cd apps/electron && npx vitest run electron/preload/__tests__/getQueueCoalesce.test.ts` — GREEN.
- [ ] `cd apps/electron && npx vitest run src/hooks/__tests__/useTranscriptionSync.test.ts` — GREEN
      (existing 3 cases + the new storm guard).
- [ ] Task 1 diagnostic reverted / not committed.
- [ ] Each commit added ONLY its own changed files and ends with the required `Co-Authored-By` trailer.

## Notes / risks

- **Do NOT touch** `apps/electron/src/services/hidock-device.ts`,
  `apps/electron/electron/main/services/jensen.ts`, or anything calling `transferIn`/`startPoll`.
- The coalescing helper must hold the in-flight promise at **module scope** (Step 2.3) — if it is
  recreated inside the arrow on every call it provides zero coalescing.
- Coalescing intentionally does NOT add time-based throttling: the 5 s poll's calls are far enough
  apart that the in-flight promise has already settled, so legitimate polling is unaffected.
- If Task 1 proves the storm is purely a stale/HMR artifact (suspects 1-2), Tasks 2-3 are still the
  correct ship: they make the boundary storm-proof and prevent silent relapse.
