# Auto-Pipeline P4 — Failure Taxonomy & Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase P4 of `docs/superpowers/specs/2026-06-11-auto-pipeline-model-choice-design.md` (§12; section §7 → AC5, AC9): 429 quota **parking** (Retry-After-aware, persisted, never burns retries), **key-fix re-pend** on Settings save, the **aggregate failure chip** ("N transcriptions failed — Retry all" — the single non-silent surface), and the remaining §7.1 taxonomy strings.

**Architecture:** All in `apps/electron`. **Depends on P2+P3** (typed `ProviderRateLimitError`/`ProviderAuthError` already thrown by both providers; `parked_until`/`first_parked_at` columns exist dormant since P1). New: `parkQueueItem`/`getRunnableQueueItems`/`rependFailedItems` DB fns, `transcription:retryAll` IPC, `FailureChip` in LibraryHeader, failed-row hydration fix. Modified: `transcription.ts` (catch taxonomy + parking + runnable selection), `config-handlers.ts` (key-diff re-pend), `useTranscriptionSync.ts` (hydrate failed rows), `LibraryHeader.tsx`/`Library.tsx`.

**Tech Stack:** sql.js, Vitest, existing Zustand stores.

---

## Environment / invariants

Same as P2/P3 (apps/electron; explicit RCs; `@vitest-environment node`; house real-DB fixture; EOL parity; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; spec authoritative — §7 especially). ⛔ USB untouched. Branch: `auto-pipeline-p4` off `main` (after P3 merges).

**Key §7.2 design (verbatim contract):** a parked item keeps **`status='pending'`** — no new status value, so dedupe (covers pending), startup recovery (resets processing only), and re-pend (targets failed) are all correct by construction. `parkQueueItem` must NOT touch `retry_count` (the generic `updateQueueItem(id,'pending')` transition INCREMENTS it — database.ts:2495-2497 — which is exactly why parking needs its own write). The poller's selection (not `getQueueItems` generally) excludes future-parked items. The 24 h cap originates at `first_parked_at` and is evaluated when the NEXT 429 arrives. Parking columns are cleared **on any successful stage completion** (spec §7.2) — not just full-job completion — so a Stage-1 park never poisons Stage-2's 24 h clock.

**⚠ TIMESTAMP FORMAT (load-bearing — a naive mix FAILS):** JS `toISOString()` produces `2026-06-11T18:30:00.000Z` while SQLite's `datetime('now')`/`CURRENT_TIMESTAMP` produce `2026-06-11 16:00:00` — lexicographic comparison between the two is WRONG (`'T' > ' '` at index 10 makes any same-day ISO value compare greater), and V8 parses the space format as LOCAL time (a 25 h-old `CURRENT_TIMESTAMP` value computes as ~20 h on UTC-5). Therefore: **all parking timestamps are stored in SQLite's space-separated UTC format and ALL comparisons happen in SQL** (`datetime(...)` normalizes both formats; age via `julianday`). No JS-side Date parsing of these columns anywhere. (Deviation note vs spec §7.2's "ISO" wording: the columns hold sortable absolute UTC timestamps, which is the spec's intent; the separator differs.)

## File structure

| File | Responsibility |
|---|---|
| `electron/main/services/database.ts` (modify) | `parkQueueItem`, `getRunnableQueueItems`, `rependFailedItems(markers)`, clear-parking-on-success |
| `electron/main/services/transcription.ts` (modify) | catch-block taxonomy (RateLimit→park/24h-terminal; Auth→failed), runnable selection, parking-clear on success, +quota strings to NON_RETRYABLE |
| `electron/main/ipc/config-handlers.ts` (modify) | key-diff → re-pend in `config:update-section` |
| `electron/main/ipc/recording-handlers.ts` + `electron/preload/index.ts` (modify) | `transcription:retryAll` |
| `src/hooks/useTranscriptionSync.ts` (modify) | hydrate failed DB rows into the store on mount (today they're skipped — chip needs them) |
| `src/features/library/components/LibraryHeader.tsx` + `src/pages/Library.tsx` (modify) | failure chip + Retry-all |
| Tests | extend `database-v25.test.ts` (parking fns), new `__tests__/parking-taxonomy.test.ts` (worker), config-handlers + chip component tests |

---

### Task 1: Parking DB primitives

**Files:** `database.ts`; extend `__tests__/database-v25.test.ts`

- [ ] **Step 0: Branch.** `git checkout main && git checkout -b auto-pipeline-p4 && cd apps/electron`
- [ ] **Step 1: Failing tests** (all timestamp assertions via SQL comparisons — never `new Date(column)` in test code; see the TIMESTAMP FORMAT note):
  1. `parkQueueItem(id, delayMs)`: after `parkQueueItem(id, 120000)`, the row has `status='pending'`; `SELECT datetime(parked_until) > datetime('now') AND datetime(parked_until) <= datetime('now', '+121 seconds')` is true; `first_parked_at` set (to ~now) — and **`retry_count` UNCHANGED** (seed a row with retry_count=2 via the generic transitions first, then park, then assert still 2). A second park updates `parked_until` but **keeps the original `first_parked_at`** (COALESCE).
  2. `getRunnableQueueItems()`: returns pending rows whose `parked_until` is NULL or past; a row parked into the future (`parkQueueItem(id, 60_000)`) is EXCLUDED **on the same day it was parked** (this is the lexicographic-format regression test); a row parked in the past (seed via raw SQL `UPDATE ... SET parked_until = datetime('now', '-10 seconds')`) IS returned (park expiry = runnable again, no extra transition). Same ordering as `getQueueItems`.
  3. `clearParking(id)`: nulls both columns (used on successful STAGE completion — see Task 2).
  3b. `getQueueItemParkedHours(id)`: NULL when never parked; ≈25 when `first_parked_at` is seeded via raw SQL to `datetime('now', '-25 hours')` — **run this test with a non-UTC TZ env if feasible** (the V8 local-parse bug this guards against only shows off-UTC; at minimum assert ≈25 not ≈25±tz-offset).
  4. `rependFailedItems(['OpenAI', 'Gemini API key'])`: failed rows whose `error_message` contains ANY marker become `status='pending', retry_count=0, parked_until=NULL, first_parked_at=NULL`; failed rows with non-matching errors (e.g. `'Recording file not found: x'`) are untouched; returns the count. LIKE-injection safety: markers are escaped via the existing `escapeLikePattern` helper (database.ts exports it).
- [ ] **Step 2: Implement** (below the queue functions, ~database.ts:2500):
```ts
/** Quota parking (spec §7.2): keep status='pending' (no new status — dedupe/startup
 *  recovery/re-pend stay correct by construction) and deliberately BYPASS the
 *  generic 'pending' transition, which increments retry_count (see updateQueueItem).
 *  first_parked_at anchors the 24h terminal cap and survives re-parks via COALESCE.
 *  delayMs is converted to a timestamp IN SQL so the stored format matches
 *  CURRENT_TIMESTAMP (space-separated UTC) — see the plan's TIMESTAMP FORMAT note. */
export function parkQueueItem(id: string, delayMs: number): void {
  const delaySeconds = Math.max(1, Math.round(delayMs / 1000))
  run(
    `UPDATE transcription_queue
     SET status = 'pending',
         parked_until = datetime('now', '+' || ? || ' seconds'),
         first_parked_at = COALESCE(first_parked_at, CURRENT_TIMESTAMP),
         progress = 0
     WHERE id = ?`,
    [String(delaySeconds), id]
  )
}

/** Poller selection (spec §7.2): pending items not parked into the future.
 *  datetime() on both sides normalizes any format drift. Everything else keeps
 *  using getQueueItems unchanged. */
export function getRunnableQueueItems(): (QueueItem & { filename?: string })[] {
  return queryAll<QueueItem & { filename?: string }>(`
    SELECT tq.*, r.filename
    FROM transcription_queue tq
    LEFT JOIN recordings r ON tq.recording_id = r.id
    WHERE tq.status = 'pending' AND (tq.parked_until IS NULL OR datetime(tq.parked_until) <= datetime('now'))
    ORDER BY tq.retry_count ASC, tq.created_at ASC`)
}

/** 24h-cap check (spec §7.2) — computed entirely in SQL (julianday) so the
 *  space-format first_parked_at is never parsed by V8 (which would read it as
 *  LOCAL time and skew the age by the UTC offset). */
export function getQueueItemParkedHours(id: string): number | null {
  const row = queryOne<{ hours: number | null }>(
    `SELECT CASE WHEN first_parked_at IS NULL THEN NULL
                 ELSE (julianday('now') - julianday(first_parked_at)) * 24.0 END AS hours
     FROM transcription_queue WHERE id = ?`,
    [id]
  )
  return row?.hours ?? null
}

export function clearParking(id: string): void {
  run('UPDATE transcription_queue SET parked_until = NULL, first_parked_at = NULL WHERE id = ?', [id])
}

/** Key-fix / Retry-all re-pend (spec §7.3). Markers are LIKE-escaped. Returns count. */
export function rependFailedItems(markers: string[]): number {
  let total = 0
  for (const marker of markers) {
    const escaped = escapeLikePattern(marker)
    run(
      `UPDATE transcription_queue
       SET status = 'pending', retry_count = 0, parked_until = NULL, first_parked_at = NULL
       WHERE status = 'failed' AND error_message LIKE ? ESCAPE '\\'`,
      [`%${escaped}%`]
    )
    total += getDatabase().getRowsModified ? 0 : 0 // see NOTE below
  }
  return total
}
```
  **NOTE (P1 lesson, do not repeat the bug):** `run()` auto-persists and resets sql.js's `getRowsModified()` — counting via it FALSE-ZEROES. Count with a SELECT first instead:
```ts
export function rependFailedItems(markers: string[]): number {
  if (markers.length === 0) return 0
  const likeClauses = markers.map(() => `error_message LIKE ? ESCAPE '\\'`).join(' OR ')
  const params = markers.map((m) => `%${escapeLikePattern(m)}%`)
  const matching = queryAll<{ id: string }>(
    `SELECT id FROM transcription_queue WHERE status = 'failed' AND (${likeClauses})`, params)
  if (matching.length === 0) return 0
  run(
    `UPDATE transcription_queue SET status = 'pending', retry_count = 0, parked_until = NULL, first_parked_at = NULL
     WHERE status = 'failed' AND (${likeClauses})`, params)
  return matching.length
}
```
  Use THIS version (the first sketch is shown only to flag the trap). Also reset the linked recordings' status so the UI shows retrying: after the UPDATE, loop `matching` → `updateRecordingTranscriptionStatus(row.recording_id, 'pending')` (SELECT must then include `recording_id`).
- [ ] **Step 3: Tests PASS, RCs 0, commit.** `feat(electron): parking DB primitives — parkQueueItem/getRunnableQueueItems/clearParking/rependFailedItems (auto-pipeline P4)`

---

### Task 2: Worker taxonomy — park on 429, 24 h cap, auth terminal, parking-clear

**Files:** `transcription.ts`; create `__tests__/parking-taxonomy.test.ts`

- [ ] **Step 1: Failing tests** (house fixture; drive via `processQueueManually` with mocked providers — patch the provider factories or the Gemini mock to throw the typed errors):
  1. Worker hits `ProviderRateLimitError('Ollama Cloud', 120000)` → item ends `status='pending'` with `parked_until` ≈ now+120 s, `first_parked_at` set, `retry_count` unchanged, recording status NOT set to 'error' (stays 'processing'→reset to 'pending'), `transcription:failed` NOT emitted (parking is silent — spec: the chip counts FAILED rows only); an activity-log/console line notes the parking.
  2. RateLimit with NO retryAfter → parked_until ≈ now+30 min (spec §7.2 default).
  3. Parked item is invisible to the next `processQueue` tick (poller uses runnable selection) but runs once `parked_until` passes (simulate by parking into the past).
  4. 429 arriving when `first_parked_at` is older than 24 h (seed it directly via SQL) → terminal `status='failed'` with message containing `quota still exhausted after 24h` (§7.1: `<Provider> quota still exhausted after 24h — check your plan, then Retry all`).
  5. `ProviderAuthError` → terminal failed immediately (message `API key was rejected` is in NON_RETRYABLE from P2) — no retries burned beyond the failure itself.
  6. Parking clears on STAGE completion (spec §7.2): park into past → Stage 1 succeeds but Stage 2 throws a 429 → the NEW park has a FRESH `first_parked_at` (the stage-boundary clear at the `'analyzing'` transition wiped the Stage-1 history). Plus the simple case: park into past → full success → both columns NULL.
  7. Restart persistence: park → close/reopen the DB (the fixture's re-init idiom from the migration test) → columns survive and the runnable filter still honors them (AC9).
- [ ] **Step 2: Implement in `transcription.ts`.**
  (a) Import `ProviderRateLimitError` (`provider-errors.ts`), `parkQueueItem`, `getRunnableQueueItems`, `clearParking`.
  (b) Poller selection: `const pendingItems = getQueueItems('pending')` (at ~:153) → `const pendingItems = getRunnableQueueItems()`.
  (c) The item-loop catch (verbatim anchor at ~:216: `} catch (error) {` ... `updateQueueItem(item.id, 'failed', errorMessage)`) gains the taxonomy BEFORE the generic failure path:
```ts
      } catch (error) {
        if (error instanceof ProviderRateLimitError) {
          // Quota parking (spec §7.2): hours-long quota windows vs a ~4-minute
          // retry budget — park without burning retry_count. The 24h age is
          // computed in SQL (getQueueItemParkedHours) — never Date-parse the column.
          const parkedHours = getQueueItemParkedHours(item.id)
          if (parkedHours !== null && parkedHours > 24) {
            const msg = `${error.provider} quota still exhausted after 24h — check your plan, then Retry all` // §7.1
            updateQueueItem(item.id, 'failed', msg)
            updateRecordingTranscriptionStatus(item.recording_id, 'error')
            notifyRenderer('transcription:failed', { queueItemId: item.id, recordingId: item.recording_id, error: msg })
          } else {
            const delayMs = error.retryAfterMs ?? 30 * 60 * 1000 // Retry-After else 30 min (spec §7.2)
            parkQueueItem(item.id, delayMs)
            updateRecordingTranscriptionStatus(item.recording_id, 'pending')
            console.log(`[Transcription] Parked ${item.id} for ${Math.round(delayMs / 1000)}s (${error.provider} 429)`)
          }
          continue
        }
        // ... existing generic failure path unchanged ...
```
  (d) **Parking clears on any successful STAGE completion (spec §7.2 verbatim), not just job completion.** Two clear points: (1) right after `updateQueueItem(item.id, 'completed')` (transcription.ts:211) add `clearParking(item.id)`; (2) in processQueue's `progressCallback` wrapper (the existing closure that forwards stage/progress to the renderer), when the reported stage transitions to `'analyzing'` — which fires exactly once Stage 1 has completed (or a resume starts) — call `clearParking(item.id)`. This way a Whisper (Stage-1) park history can never poison the 24 h clock of a later Ollama (Stage-2) 429.
  (e) NON_RETRYABLE addition: `'quota still exhausted after 24h',` (the 24h-terminal message). The OpenAI `insufficient_quota` mapping and its `'quota exhausted'` NON_RETRYABLE string already landed in **P2** (whisper-asr's 429 branch inspects the body — quota-429s never reach the parking path); verify both exist rather than re-adding.
- [ ] **Step 3: Tests PASS** (new + ALL transcription/worker suites — the parking must not disturb the generic path), RCs 0. Commit: `feat(electron): 429 quota parking with 24h cap + auth/quota taxonomy in the queue worker (auto-pipeline P4)`

---

### Task 3: Key-fix re-pend in config:update-section

**Files:** `electron/main/ipc/config-handlers.ts`; new `__tests__/config-handlers-repend.test.ts` (or extend existing config-handlers tests if present)

- [ ] **Step 1: Failing tests:** saving `transcription` section with a CHANGED `openaiApiKey` triggers `rependFailedItems(['OpenAI'])` + `processQueueManually`; changed `geminiApiKey` → marker `'Gemini API key'`; changed `summarization.ollamaCloudApiKey` → `'Ollama Cloud'`; an update that does NOT change any key field triggers nothing; the re-pend failing must NOT fail the config save (wrapped, logged).
- [ ] **Step 2: Implement.** In `config-handlers.ts`'s `config:update-section` handler (verbatim anchor :39-56), before `await updateConfig(section, values)` capture the old keys, after success diff and re-pend:
```ts
      try {
        const before = getConfig()
        const oldKeys = {
          openai: before.transcription.openaiApiKey,
          gemini: before.transcription.geminiApiKey,
          ollama: before.summarization.ollamaCloudApiKey
        }
        await updateConfig(section, values)
        // Key-fix re-pend (spec §7.3): a saved provider key re-pends that provider's
        // terminal failures. Marker map per spec: openaiApiKey→'OpenAI',
        // ollamaCloudApiKey→'Ollama Cloud', geminiApiKey→'Gemini API key'.
        try {
          const after = getConfig()
          const markers: string[] = []
          if (after.transcription.openaiApiKey !== oldKeys.openai && after.transcription.openaiApiKey.trim()) markers.push('OpenAI')
          if (after.transcription.geminiApiKey !== oldKeys.gemini && after.transcription.geminiApiKey.trim()) markers.push('Gemini API key')
          if (after.summarization.ollamaCloudApiKey !== oldKeys.ollama && after.summarization.ollamaCloudApiKey.trim()) markers.push('Ollama Cloud')
          if (markers.length > 0) {
            const { rependFailedItems } = await import('../services/database')
            const count = rependFailedItems(markers)
            if (count > 0) {
              emitActivityLog('info', `Re-queued ${count} failed transcription${count === 1 ? '' : 's'} after key update`)
              const { processQueueManually } = await import('../services/transcription')
              void processQueueManually()
            }
          }
        } catch (rependErr) {
          console.error('[config:update-section] re-pend after key save failed:', rependErr)
        }
        emitActivityLog('info', `Settings updated: ${String(section)}`)
        return success(getConfig())
```
  (Match the file's import style — it already imports `getConfig`/`updateConfig` statically at :2; use static imports if no cycle arises; the dynamic imports above are the cycle-safe default since transcription.ts imports config.ts.)
- [ ] **Step 3: Tests PASS, RCs 0, commit.** `feat(electron): key-fix re-pend — saving a provider key re-queues its failed transcriptions (auto-pipeline P4)`

---

### Task 4: Failed-row hydration + failure chip + Retry-all

**Files:** `src/hooks/useTranscriptionSync.ts`, `src/features/library/components/LibraryHeader.tsx`, `src/pages/Library.tsx`, `electron/main/ipc/recording-handlers.ts` + `preload/index.ts` (retryAll IPC); component test for the chip; handler test for retryAll

- [ ] **Step 1: `transcription:retryAll` IPC.** Failing handler test: calls `rependFailedItems` with ALL THREE provider markers (`['OpenAI', 'Ollama Cloud', 'Gemini API key']` — provider-scoped per spec §7.3; deterministic failures like `Recording file not found`/disk-space/ffmpeg are excluded BY CONSTRUCTION since their messages match no marker) and triggers `processQueueManually`; returns `{ success: true, count }`. Implement next to `transcription:cancelAll` (:307-316 idiom); preload type `retryAllFailed: () => Promise<{ success: boolean; count: number }>` + impl `retryAllFailed: () => callIPC('transcription:retryAll'),`; add channel to the registry test list.
- [ ] **Step 2: Hydration fix.** `useTranscriptionSync.ts:22-35` hydrates only `'pending'`/`'processing'` rows on mount (fact: failed DB rows never reach the store unless live events arrive — the chip would show 0 after an app restart). Change the hydrate loop to ALSO add `'failed'` rows: `store.addToQueue(item.id, item.recording_id, item.filename)` then `store.markFailed(item.id, item.error_message || 'Unknown error')` (read the store API — `markFailed` exists per the :133-136 poll branch). Mirror the same in the 5 s poll's failed branch (:133-136): currently `if (store.queue.has(item.id))` guards it — drop the guard so newly-failed rows appear (add-then-mark).
- [ ] **Step 3: Failing chip test** (component): renders nothing at 0 failed; with 3 failed store items shows `3 transcriptions failed` and a `Retry all` button that calls `retryAllFailed` and toasts the returned count.
- [ ] **Step 4: Implement the chip.** In `LibraryHeader.tsx`, the subtitle `<p>` (:50-60) already renders conditional spans — add after the existing unsynced span:
```tsx
          {failedCount > 0 && (
            <span className="ml-2 text-red-600 dark:text-red-400">
              ({failedCount} transcription{failedCount === 1 ? '' : 's'} failed —{' '}
              <button type="button" onClick={onRetryAllFailed} className="underline underline-offset-2 hover:text-red-700">
                Retry all
              </button>
              )
            </span>
          )}
```
  Props: `failedCount: number` + `onRetryAllFailed: () => void` added to `LibraryHeaderProps` (:4-27). In `Library.tsx`: `const failedTranscriptions = useFailedTranscriptions()` (existing selector, `useTranscriptionStore.ts:267-277`), pass `failedCount={failedTranscriptions.length}` and an `onRetryAllFailed` calling `window.electronAPI.recordings.retryAllFailed()` then toasting `Re-queued N transcriptions` and `refresh(false)` — wire into the LibraryHeader mount (:813-828).
- [ ] **Step 5: All green (chip + sync + handler + full suites), RCs 0, commit.** `feat(electron): aggregate failure chip with Retry-all + failed-row hydration (auto-pipeline P4)`

---

### Task 5: Full gates + AC5/AC9 evidence

- [ ] **Step 1:** typecheck / lint / `npm run test:run` — RCs 0.
- [ ] **Step 2: AC5 evidence:** the per-stage key checks (**P1**, spec §5.3 — P2 only added the renderer preflight) + key-fix re-pend (Task 3) + Stage-2 resume (P1) chain — name the tests proving: mid-queue LLM-key removal → items persist `full_text` then terminal-fail with the §7.1 message (**P3's two-stage-worker AC5-seam test** — gemini ASR + missing ollama key); key save re-pends them (Task 3 tests); they complete WITHOUT re-running ASR (P1's stage-resume test + P3's resummarize test); chip showed the count (Task 4 test).
- [ ] **Step 3: AC9 evidence:** parking tests 1/3/7 from Task 2 (status pending + parked_until + retry_count untouched; poller skip; restart persistence) + test 4 (24 h terminal).
- [ ] **Step 4: Report** with citations; flag any DONE_WITH_CONCERNS.

## Done criteria (spec §12 P4 → AC5, AC9)
- [ ] 429 → parked (pending + parked_until + first_parked_at, retry_count untouched), Retry-After honored else 30 min, 24 h terminal cap, restart-safe.
- [ ] Auth/quota/model-404 failures terminal with §7.1 verbatim messages; no retry storms.
- [ ] Key save re-pends matching failures + kicks the queue; Retry-all does the same provider-scoped.
- [ ] Chip = the single non-silent surface, counts failed queue rows (incl. after restart via hydration fix).
- [ ] Gates green; no behavior change for items that never hit a 429/auth failure.

## Explicitly NOT in P4
- Baseline snapshot / ensure-baseline / auto-sync changes / 100-file cap (P5).
- Integration e2e variant + the physical AC1 plug-in (P6).
- Per-chunk Whisper checkpointing across retries (spec §10 deferred).
- Desktop notifications (chip only — user chose silent).
