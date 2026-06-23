# Reassign in the By-Speaker View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move turn reassignment out of the SpeakersPanel "Turns" pane and onto each turn row of the By-Speaker transcript cards, backed by one atomic `speakers:reassignTurns` IPC handler that rewrites the scoped turns, mints/maps the target letter, cleans up an emptied source label, and invalidates embeddings so the matcher re-runs.

**Architecture:** A new `speakers:reassignTurns` handler is added inside `registerSpeakersHandlers()`, mirroring the existing `speakers:merge` handler's atomic load→rewrite→`updateTranscriptTurns`→invalidate→orphan-clean sequence and reusing the `speakers:assign` capture path when a reassign mints+maps a contact letter. A new shared `<SpeakerTargetPicker>` component (extracted from the SpeakersPanel Assign popover) supplies the existing-speaker / contact / new-speaker target choice. `TranscriptViewer` gains an optional reassign control on each By-Speaker turn row (gated on an `onReassign` prop, so Timeline and read-only usages are unchanged); `SourceReader` threads the recording id, speaker list, contacts, and an `onReassign` callback that calls `speakers.reassignTurns` then `refreshSpeakers()`. The old Turns pane and its per-turn reassign are deleted from `SpeakersPanel`.

**Tech Stack:** Electron 39 main process (Node.js), React 18 + TypeScript, sql.js (SQLite), zod (IPC validation), Vitest + @testing-library/react. 120-col TS/TSX.

## Global Constraints

- 120-column line length for all TS/TSX (project convention).
- Before claiming done, the FULL gate must pass: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`. `npm run typecheck` covers BOTH the node and web programs AND test files — running vitest alone is NOT sufficient.
- The new `speakers:reassignTurns` handler is atomic and mirrors `speakers:merge`: load turns → rewrite scoped turns → `updateTranscriptTurns` → invalidate embeddings → expire suggestions → carry/clean `recording_speakers`.
- Reassign scope is **source-speaker-scoped** (only turns whose `speaker === sourceLabel`) and **anchor-inclusive** for both bulk options (`before` = `i <= anchorIndex`, `after` = `i >= anchorIndex`, `one` = `i === anchorIndex`).
- Next letter = highest used label A–Z + 1 (gaps tolerated); if `Z` is in use, "New speaker" is disabled.
- A reassign that mints+maps a contact letter MUST reuse the `speakers:assign` path (the `upsertRecordingSpeaker` + `scheduleCaptureAndNotify` capture), NOT a bare `upsertRecordingSpeaker`, so voiceprint capture stays identical to roster Assign.
- Orphan cleanup: if `sourceLabel` ends with zero turns, `deleteRecordingSpeaker(recordingId, sourceLabel)`.
- Stale-anchor guard: if `turns[anchorIndex]?.startMs !== anchorStartMs || turns[anchorIndex]?.speaker !== sourceLabel`, reject with `VALIDATION_ERROR` and perform NO write.
- The reassign handler uses the SAME embedding-invalidation set as `speakers:merge`: `deleteLabelEmbeddingsForRecording` + `deleteWindowEmbeddingsForRecording` + `clearSuggestionsInFlight` + `expireSuggestionsForRecording`.
- The SpeakersPanel roster (assign/merge/suggestions/"this is me") stays untouched.
- Do NOT touch device/USB code.

---

### Task 1: `speakers:reassignTurns` handler + `nextUnusedLetter` helper + preload wiring

**Files:**
- Modify: `apps/electron/electron/main/ipc/speakers-handlers.ts` (add `nextUnusedLetter` helper near `parseTurns` ~126; add `ReassignTurnsSchema` near the other schemas ~84; add `ipcMain.handle('speakers:reassignTurns', …)` inside `registerSpeakersHandlers()` ~199, after the `speakers:merge` handler ends ~324)
- Modify: `apps/electron/electron/preload/index.ts` (type block: add `reassignTurns` to the `speakers` namespace after `getSuggestions` ~240; impl block: add `reassignTurns` after `getSuggestions` ~754)
- Test: `apps/electron/electron/main/ipc/__tests__/speakers-reassign.test.ts` (new)

**Interfaces:**
- Produces — the request type (used by Tasks 2 & 3):
  ```ts
  export type ReassignTarget =
    | { kind: 'existingLabel'; label: string }
    | { kind: 'contact'; contactId: string }
    | { kind: 'newSpeaker' }

  export interface ReassignTurnsRequest {
    recordingId: string
    sourceLabel: string
    anchorIndex: number
    anchorStartMs: number
    scope: 'one' | 'before' | 'after'
    target: ReassignTarget
  }
  ```
- Produces — handler success payload: `Result<{ recordingId: string; targetLabel: string; rewrittenCount: number }>`
- Produces — pure helper: `nextUnusedLetter(usedLabels: string[]): string | null` (highest A–Z + 1; `[]` → `'A'`; `'Z'` present → `null`)
- Produces — preload method: `speakers.reassignTurns: (request: ReassignTurnsRequest) => Promise<Result<{ recordingId: string; targetLabel: string; rewrittenCount: number }>>`
- Consumes (existing, verified): `getTranscriptByRecordingId`, `parseTurns` (local ~126), `updateTranscriptTurns(recordingId, turns)`, `getRecordingSpeakers(recordingId)` → rows `{ file_label, contact_id, … }`, `deleteRecordingSpeaker(recordingId, fileLabel)`, `getContactById(contactId)`, `upsertRecordingSpeaker({ recording_id, file_label, contact_id, source })`, `deleteLabelEmbeddingsForRecording`, `deleteWindowEmbeddingsForRecording`, `clearSuggestionsInFlight` (local ~65), `expireSuggestionsForRecording`, `scheduleCaptureAndNotify(recordingId, fileLabel, contactId, createdFrom)` (local ~164), `success`/`error`/`Result` (from `../types/api`), `Turn` (from `../services/asr/asr-provider`), `z` (zod).

- [ ] **Step 1: Write the failing test for `nextUnusedLetter` + the handler**

Create `apps/electron/electron/main/ipc/__tests__/speakers-reassign.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerSpeakersHandlers, nextUnusedLetter, setMainWindowForSpeakers } from '../speakers-handlers'
import type { ReassignTurnsRequest } from '../speakers-handlers'
import { ipcMain } from 'electron'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../services/database', () => ({
  upsertRecordingSpeaker: vi.fn(),
  getRecordingSpeaker: vi.fn(),
  getRecordingSpeakers: vi.fn(() => []),
  deleteRecordingSpeaker: vi.fn(),
  deleteVoiceprintsBySource: vi.fn(),
  getContactById: vi.fn(),
  getTranscriptByRecordingId: vi.fn(),
  updateTranscriptTurns: vi.fn(),
  getPendingSuggestions: vi.fn(),
  getSelfContactId: vi.fn(),
  deleteLabelEmbeddingsForRecording: vi.fn(),
  deleteWindowEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(),
  acceptSuggestion: vi.fn(),
  dismissSuggestion: vi.fn()
}))

vi.mock('../../services/voiceprint-service', () => ({
  captureVoiceprint: vi.fn(async () => ({ captured: true })),
  embedRecordingLabels: vi.fn(async () => undefined)
}))

vi.mock('../../services/voiceprint/speaker-matcher', () => ({
  runMatcher: vi.fn(async () => ({ summary: {}, diarizationRunId: 'drun_1' }))
}))

const TURNS = [
  { speaker: 'A', startMs: 0, endMs: 1000, text: 'a1' },
  { speaker: 'B', startMs: 1000, endMs: 2000, text: 'b1' },
  { speaker: 'A', startMs: 2000, endMs: 3000, text: 'a2' },
  { speaker: 'A', startMs: 3000, endMs: 4000, text: 'a3' }
]

// Single update point for handler requests: each test overrides only the fields it varies.
function makeReq(overrides: Partial<ReassignTurnsRequest> = {}): ReassignTurnsRequest {
  return {
    recordingId: 'rec-1',
    sourceLabel: 'A',
    anchorIndex: 0,
    anchorStartMs: 0,
    scope: 'one',
    target: { kind: 'existingLabel', label: 'B' },
    ...overrides
  }
}

// AC3 invariant: turns whose speaker !== sourceLabel must appear verbatim, in order, in the
// rewritten array. Survives fixture changes (a bulk-rewrite-everything bug would still produce
// the right array for a specific fixture, but would drop/alter a non-source turn here).
function expectOtherSpeakersTurnsUnchanged(original: any[], rewritten: any[], sourceLabel: string) {
  const expected = original.filter((t) => t.speaker !== sourceLabel)
  const actual = rewritten.filter((t) => t.speaker !== sourceLabel)
  expect(actual).toEqual(expected)
}

function getReassignHandler() {
  registerSpeakersHandlers()
  return vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === 'speakers:reassignTurns')?.[1]
}

async function seedTurns(turns = TURNS) {
  const db = await import('../../services/database')
  vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ recording_id: 'rec-1', turns: JSON.stringify(turns) } as any)
  return db
}

describe('nextUnusedLetter', () => {
  it('returns G when A–F are used (highest + 1)', () => {
    expect(nextUnusedLetter(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('G')
  })
  it('tolerates gaps and uses highest + 1', () => {
    expect(nextUnusedLetter(['B', 'D', 'F'])).toBe('G')
  })
  it('returns A when nothing is used', () => {
    expect(nextUnusedLetter([])).toBe('A')
  })
  it('returns B for a single A (gap-free, single-element)', () => {
    expect(nextUnusedLetter(['A'])).toBe('B')
  })
  it('returns null when Z is in use', () => {
    expect(nextUnusedLetter(['A', 'Z'])).toBeNull()
  })
  it('returns null when Z is the ONLY label (highest === Z; catches > vs >=)', () => {
    expect(nextUnusedLetter(['Z'])).toBeNull()
  })
})

describe('speakers:reassignTurns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setMainWindowForSpeakers(null as any)
  })

  it('registers speakers:reassignTurns', () => {
    registerSpeakersHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('speakers:reassignTurns', expect.any(Function))
  })

  it("scope 'one' rewrites exactly the anchor turn to an existing label, leaving others", async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 2, anchorStartMs: 2000, scope: 'one' })) as any
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ targetLabel: 'B', rewrittenCount: 1 })
    const rewritten = vi.mocked(db.updateTranscriptTurns).mock.calls[0][1]
    expect(rewritten).toEqual([
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'a1' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'b1' },
      { speaker: 'B', startMs: 2000, endMs: 3000, text: 'a2' },
      { speaker: 'A', startMs: 3000, endMs: 4000, text: 'a3' }
    ])
    expectOtherSpeakersTurnsUnchanged(TURNS, rewritten, 'A')
  })

  it("scope 'before' rewrites source turns at/earlier than anchor (anchor inclusive), other speakers untouched", async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 2, anchorStartMs: 2000, scope: 'before' })) as any
    expect(res.success).toBe(true)
    // A@0 and A@2000 (anchor) move to B; B@1000 untouched; A@3000 (after) stays A.
    const rewritten = vi.mocked(db.updateTranscriptTurns).mock.calls[0][1]
    expect(rewritten).toEqual([
      { speaker: 'B', startMs: 0, endMs: 1000, text: 'a1' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'b1' },
      { speaker: 'B', startMs: 2000, endMs: 3000, text: 'a2' },
      { speaker: 'A', startMs: 3000, endMs: 4000, text: 'a3' }
    ])
    // B@1000 must be byte-identical in the rewritten array (only A's turns may move).
    expectOtherSpeakersTurnsUnchanged(TURNS, rewritten, 'A')
    expect(res.data.rewrittenCount).toBe(2)
  })

  it("scope 'after' rewrites source turns at/later than anchor (anchor inclusive)", async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 2, anchorStartMs: 2000, scope: 'after' })) as any
    expect(res.success).toBe(true)
    const rewritten = vi.mocked(db.updateTranscriptTurns).mock.calls[0][1]
    expect(rewritten).toEqual([
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'a1' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'b1' },
      { speaker: 'B', startMs: 2000, endMs: 3000, text: 'a2' },
      { speaker: 'B', startMs: 3000, endMs: 4000, text: 'a3' }
    ])
    expectOtherSpeakersTurnsUnchanged(TURNS, rewritten, 'A')
    expect(res.data.rewrittenCount).toBe(2)
  })

  it("target 'newSpeaker' mints the next unused letter (A,B used -> C) with no mapping", async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ target: { kind: 'newSpeaker' } })) as any
    expect(res.success).toBe(true)
    expect(res.data.targetLabel).toBe('C')
    expect(db.upsertRecordingSpeaker).not.toHaveBeenCalled()
  })

  it("target 'contact' reuses an existing recording_speakers letter for that contact", async () => {
    const db = await seedTurns()
    vi.mocked(db.getContactById).mockReturnValue({ id: 'cB', name: 'Bob' } as any)
    vi.mocked(db.getRecordingSpeakers).mockReturnValue([
      { recording_id: 'rec-1', file_label: 'B', contact_id: 'cB', confidence: null, source: 'user', created_at: 't' }
    ] as any)
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ target: { kind: 'contact', contactId: 'cB' } })) as any
    expect(res.success).toBe(true)
    expect(res.data.targetLabel).toBe('B')
    // Reuses existing letter — no new upsert, no new capture.
    expect(db.upsertRecordingSpeaker).not.toHaveBeenCalled()
  })

  it("target 'contact' with no existing letter mints next letter AND schedules capture (assign path)", async () => {
    const db = await seedTurns()
    const voiceprint = await import('../../services/voiceprint-service')
    vi.mocked(db.getContactById).mockReturnValue({ id: 'cZ', name: 'Zoe' } as any)
    vi.mocked(db.getRecordingSpeakers).mockReturnValue([] as any)
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ target: { kind: 'contact', contactId: 'cZ' } })) as any
    expect(res.success).toBe(true)
    // A,B used -> mint C and map it to the contact via the assign path.
    expect(res.data.targetLabel).toBe('C')
    expect(db.upsertRecordingSpeaker).toHaveBeenCalledWith(
      expect.objectContaining({ recording_id: 'rec-1', file_label: 'C', contact_id: 'cZ', source: 'user' })
    )
    await new Promise((r) => setImmediate(r))
    expect(voiceprint.captureVoiceprint).toHaveBeenCalledWith('rec-1', 'C', 'cZ', 'manual')
  })

  it('deletes the source recording_speakers row when the source label is emptied', async () => {
    // Source A has ONLY turns; move every A turn away so A becomes orphaned.
    const onlyA = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'a1' },
      { speaker: 'A', startMs: 1000, endMs: 2000, text: 'a2' }
    ]
    const db = await seedTurns(onlyA)
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 1, anchorStartMs: 1000, scope: 'before' })) as any
    expect(res.success).toBe(true)
    expect(db.deleteRecordingSpeaker).toHaveBeenCalledWith('rec-1', 'A')
  })

  it('does NOT delete the source row when source still has turns (A survives in rewritten array)', async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    await handler?.({} as any, makeReq({ anchorIndex: 0, anchorStartMs: 0, scope: 'one' }))
    // Strengthen the absence-of-call assertion: prove A is still present so the precondition
    // ("source still has turns") is real, not vacuous.
    const rewritten = vi.mocked(db.updateTranscriptTurns).mock.calls[0][1]
    expect(rewritten.some((t: any) => t.speaker === 'A')).toBe(true)
    expect(db.deleteRecordingSpeaker).not.toHaveBeenCalledWith('rec-1', 'A')
  })

  it('invalidates the same embedding/suggestion set as merge', async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    await handler?.({} as any, makeReq({ anchorIndex: 0, anchorStartMs: 0, scope: 'one' }))
    expect(db.deleteLabelEmbeddingsForRecording).toHaveBeenCalledWith('rec-1')
    expect(db.deleteWindowEmbeddingsForRecording).toHaveBeenCalledWith('rec-1')
    expect(db.expireSuggestionsForRecording).toHaveBeenCalledWith('rec-1')
    // NOTE: clearSuggestionsInFlight is a LOCAL function in speakers-handlers.ts (line 65),
    // NOT a database export, so it cannot be spied/asserted via the db mock above. It is the
    // subtlest of the four invalidators; the handler MUST still call it (spec §4.4 step 6 +
    // Global Constraints). It is exercised indirectly by the SourceReader refresh test in
    // Task 3 (getSuggestions re-runs after reassign). Do NOT drop the call in a refactor.
  })

  it('rejects a stale anchor (startMs mismatch) with VALIDATION_ERROR and no write', async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 2, anchorStartMs: 9999, scope: 'one' })) as any
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('VALIDATION_ERROR')
    expect(db.updateTranscriptTurns).not.toHaveBeenCalled()
  })

  it('rejects a stale anchor (speaker mismatch) with VALIDATION_ERROR and no write', async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 1, anchorStartMs: 1000, scope: 'one' })) as any
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('VALIDATION_ERROR')
    expect(db.updateTranscriptTurns).not.toHaveBeenCalled()
  })

  it('rejects an out-of-bounds anchor (index past end -> turns[anchorIndex] undefined) with no write', async () => {
    // Simulates a stale index after a prior reassign deleted turns: turns[99] is undefined,
    // so the !anchor branch must fire BEFORE the startMs/speaker checks (which would crash on
    // a property access). VALIDATION_ERROR, no write.
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 99, anchorStartMs: 0, scope: 'one' })) as any
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('VALIDATION_ERROR')
    expect(db.updateTranscriptTurns).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-reassign.test.ts`
Expected: FAIL — `nextUnusedLetter` is not exported and no `speakers:reassignTurns` handler is registered (e.g. "nextUnusedLetter is not a function" / handler is `undefined`).

- [ ] **Step 3: Add `nextUnusedLetter` + `ReassignTurnsSchema` + the handler**

In `apps/electron/electron/main/ipc/speakers-handlers.ts`, add the pure helper right after `parseTurns` (~134):

```ts
/**
 * Next unused single uppercase letter for a recording's speaker labels: take the
 * HIGHEST letter A–Z currently used and return the next one (gaps are tolerated).
 * Returns 'A' when nothing is used, and null when 'Z' is already in use (≥26 speakers),
 * so the caller can disable "New speaker" rather than mint an invalid label.
 */
export function nextUnusedLetter(usedLabels: string[]): string | null {
  const A = 'A'.charCodeAt(0)
  const Z = 'Z'.charCodeAt(0)
  let highest = -1
  for (const raw of usedLabels) {
    const label = (raw ?? '').trim().toUpperCase()
    if (label.length !== 1) continue
    const code = label.charCodeAt(0)
    if (code < A || code > Z) continue
    if (code > highest) highest = code
  }
  if (highest === -1) return 'A'
  if (highest >= Z) return null
  return String.fromCharCode(highest + 1)
}
```

Add the schema near the other zod schemas (after `UnassignSpeakerSchema` ~123):

```ts
const ReassignTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existingLabel'), label: z.string().min(1) }),
  z.object({ kind: z.literal('contact'), contactId: z.string().min(1) }),
  z.object({ kind: z.literal('newSpeaker') })
])

const ReassignTurnsSchema = z.object({
  recordingId: z.string().min(1),
  sourceLabel: z.string().min(1),
  anchorIndex: z.number().int().min(0),
  anchorStartMs: z.number(),
  scope: z.enum(['one', 'before', 'after']),
  target: ReassignTargetSchema
})

export type ReassignTarget = z.infer<typeof ReassignTargetSchema>
export type ReassignTurnsRequest = z.infer<typeof ReassignTurnsSchema>
```

Add the handler inside `registerSpeakersHandlers()`, immediately after the `speakers:merge` handler's closing `)` (~324):

```ts
  /**
   * Reassign a scoped set of one speaker's turns to a target letter (existing label,
   * contact, or a freshly-minted new speaker). Atomic — mirrors speakers:merge:
   *   1. Load turns; reject a stale anchor (no write).
   *   2. Resolve the target letter (existingLabel as-is; contact -> existing mapped
   *      letter else mint+map via the SAME assign path that banks a voiceprint;
   *      newSpeaker -> mint, no mapping).
   *   3. Rewrite the source-scoped turns (scope: one/before/after, anchor inclusive).
   *   4. Persist via updateTranscriptTurns; invalidate embeddings + expire suggestions.
   *   5. Delete the source recording_speakers row if the source label is now empty.
   */
  ipcMain.handle(
    'speakers:reassignTurns',
    async (
      _,
      request: unknown
    ): Promise<Result<{ recordingId: string; targetLabel: string; rewrittenCount: number }>> => {
      try {
        const parsed = ReassignTurnsSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid reassign request', parsed.error.format())
        }

        const { recordingId, sourceLabel, anchorIndex, anchorStartMs, scope, target } = parsed.data

        const transcript = getTranscriptByRecordingId(recordingId)
        const turns = parseTurns(transcript?.turns)
        if (turns.length === 0) {
          return error('NOT_FOUND', `No diarized turns found for recording ${recordingId}`)
        }

        // 1. Stale-anchor guard: the anchor must still be the source label at the same
        //    start time. If the turns changed underneath, reject with NO write.
        const anchor = turns[anchorIndex]
        if (!anchor || anchor.startMs !== anchorStartMs || anchor.speaker !== sourceLabel) {
          return error('VALIDATION_ERROR', 'stale turns; refresh and retry')
        }

        // 2. Resolve the target letter.
        const rows = getRecordingSpeakers(recordingId)
        const usedLabels = [...new Set([...turns.map((t) => t.speaker), ...rows.map((r) => r.file_label)])]
        let targetLabel: string
        if (target.kind === 'existingLabel') {
          targetLabel = target.label
        } else if (target.kind === 'contact') {
          const contact = getContactById(target.contactId)
          if (!contact) return error('NOT_FOUND', `Contact with ID ${target.contactId} not found`)
          const existing = rows.find((r) => r.contact_id === target.contactId)
          if (existing) {
            targetLabel = existing.file_label
          } else {
            const minted = nextUnusedLetter(usedLabels)
            if (!minted) return error('VALIDATION_ERROR', 'No unused speaker letters remain (Z in use)')
            targetLabel = minted
            // Reuse the assign path: upsert the mapping AND schedule the voiceprint capture,
            // identical to roster Assign (no bare upsert).
            upsertRecordingSpeaker({
              recording_id: recordingId,
              file_label: targetLabel,
              contact_id: target.contactId,
              source: 'user'
            })
            scheduleCaptureAndNotify(recordingId, targetLabel, target.contactId, 'manual')
          }
        } else {
          const minted = nextUnusedLetter(usedLabels)
          if (!minted) return error('VALIDATION_ERROR', 'No unused speaker letters remain (Z in use)')
          targetLabel = minted
        }

        // 3. Rewrite the source-scoped turns (anchor inclusive for before/after).
        let rewrittenCount = 0
        const rewritten = turns.map((t, i) => {
          if (t.speaker !== sourceLabel) return t
          const inScope =
            scope === 'one' ? i === anchorIndex : scope === 'before' ? i <= anchorIndex : i >= anchorIndex
          if (!inScope) return t
          rewrittenCount += 1
          return { ...t, speaker: targetLabel }
        })

        // 4. Persist + invalidate (same set merge uses).
        updateTranscriptTurns(recordingId, rewritten)
        deleteLabelEmbeddingsForRecording(recordingId)
        deleteWindowEmbeddingsForRecording(recordingId)
        clearSuggestionsInFlight(recordingId)
        expireSuggestionsForRecording(recordingId)

        // 5. Orphan cleanup: drop the source mapping if it has no turns left.
        const sourceStillUsed = rewritten.some((t) => t.speaker === sourceLabel)
        if (!sourceStillUsed) {
          deleteRecordingSpeaker(recordingId, sourceLabel)
        }

        return success({ recordingId, targetLabel, rewrittenCount })
      } catch (err) {
        console.error('speakers:reassignTurns error:', err)
        return error('DATABASE_ERROR', 'Failed to reassign turns', err)
      }
    }
  )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-reassign.test.ts`
Expected: PASS (all `nextUnusedLetter` and `speakers:reassignTurns` cases green).

- [ ] **Step 5: Wire the preload type + impl**

In `apps/electron/electron/preload/index.ts`, add to the `speakers` type block right after the `getSuggestions` line (~240):

```ts
    reassignTurns: (request: { recordingId: string; sourceLabel: string; anchorIndex: number; anchorStartMs: number; scope: 'one' | 'before' | 'after'; target: { kind: 'existingLabel'; label: string } | { kind: 'contact'; contactId: string } | { kind: 'newSpeaker' } }) => Promise<Result<{ recordingId: string; targetLabel: string; rewrittenCount: number }>>
```

And in the `speakers` impl block right after the `getSuggestions` line (~754):

```ts
    reassignTurns: (request) => callIPC('speakers:reassignTurns', request),
```

- [ ] **Step 6: Run the focused test + full typecheck to verify preload wiring**

Run: `cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-reassign.test.ts && npm run typecheck`
Expected: vitest PASS; `npm run typecheck` (node + web + tests) PASS with no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/electron/electron/main/ipc/speakers-handlers.ts apps/electron/electron/preload/index.ts apps/electron/electron/main/ipc/__tests__/speakers-reassign.test.ts
git commit -m "feat(electron): add atomic speakers:reassignTurns handler + nextUnusedLetter + preload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9"
```

---

### Task 2: `<SpeakerTargetPicker>` shared component

**Files:**
- Create: `apps/electron/src/features/library/components/SpeakerTargetPicker.tsx`
- Test: `apps/electron/src/features/library/components/__tests__/SpeakerTargetPicker.test.tsx` (new)

**Interfaces:**
- Consumes (from Task 1): `ReassignTarget` shape `{ kind: 'existingLabel'; label } | { kind: 'contact'; contactId } | { kind: 'newSpeaker' }`. The picker reproduces this union locally as its `onPick` argument type (the renderer cannot import the node-main type across the web/node program boundary — see `types/turns.ts` header note).
- Produces — the component (used by Task 3):
  ```ts
  export interface SpeakerOption { label: string; name: string | null } // name null = unnamed → "Speaker X"
  export type PickedTarget =
    | { kind: 'existingLabel'; label: string }
    | { kind: 'contact'; contactId: string }
    | { kind: 'newSpeaker' }
  export interface SpeakerTargetPickerProps {
    sourceLabel: string                 // excluded from the existing-speaker list
    speakers: SpeakerOption[]           // all labels in the recording (incl. source; source filtered out internally)
    meetingId?: string                  // attendees source for contact search
    canMintNew: boolean                 // false when Z is in use → "New speaker" disabled
    onPick: (target: PickedTarget) => void
    disabled?: boolean
  }
  export function SpeakerTargetPicker(props: SpeakerTargetPickerProps): JSX.Element
  ```
- Consumes (existing, verified): `window.electronAPI.contacts.getForMeeting(meetingId)` → `Result<Contact[]>`; `window.electronAPI.contacts.getAll({})` → `Result<{ contacts: Person[] }>`; `window.electronAPI.contacts.create({ name })` → `Result<Person>` (`.data.id`). UI primitives `Input` (`@/components/ui/input`), `Button`, `Badge`, `PersonAvatar` (`@/components/harbor/PersonAvatar`).

- [ ] **Step 1: Write the failing test**

Create `apps/electron/src/features/library/components/__tests__/SpeakerTargetPicker.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SpeakerTargetPicker } from '../SpeakerTargetPicker'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

function stubApi() {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      contacts: {
        getForMeeting: vi.fn().mockResolvedValue({ success: true, data: [{ id: 'cA', name: 'Alice', email: null }] }),
        getAll: vi.fn().mockResolvedValue({ success: true, data: { contacts: [{ id: 'cZ', name: 'Zoe', email: null }], total: 1 } }),
        create: vi.fn().mockResolvedValue({ success: true, data: { id: 'c-new', name: 'Newbie' } }),
      },
    },
    writable: true,
    configurable: true,
  })
}

const SPEAKERS = [
  { label: 'A', name: 'Alice' },
  { label: 'B', name: null },
]

beforeEach(() => {
  vi.clearAllMocks()
  stubApi()
})

describe('SpeakerTargetPicker', () => {
  it('lists existing speakers excluding the source, named and unnamed', async () => {
    const onPick = vi.fn()
    render(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} canMintNew onPick={onPick} />)
    // Source A is excluded; B shows as "Speaker B". Exclusion is by LABEL, not name — assert
    // both the name path (Alice) and the label path (A) are absent.
    expect(screen.queryByRole('button', { name: /reassign to alice/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reassign to speaker a/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /reassign to speaker b/i })).toBeInTheDocument()
  })

  it('excludes the source by LABEL even when the source is unnamed (sourceLabel=B)', async () => {
    const onPick = vi.fn()
    // B is the source here and is unnamed; A (named Alice) is the only other speaker.
    render(<SpeakerTargetPicker sourceLabel="B" speakers={SPEAKERS} canMintNew onPick={onPick} />)
    expect(screen.queryByRole('button', { name: /reassign to speaker b/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /reassign to alice/i })).toBeInTheDocument()
  })

  it('picking an existing speaker emits an existingLabel target', async () => {
    const onPick = vi.fn()
    render(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} canMintNew onPick={onPick} />)
    fireEvent.click(await screen.findByRole('button', { name: /reassign to speaker b/i }))
    expect(onPick).toHaveBeenCalledWith({ kind: 'existingLabel', label: 'B' })
  })

  it('contact search filters and picking a contact emits a contact target', async () => {
    const onPick = vi.fn()
    render(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} meetingId="m1" canMintNew onPick={onPick} />)
    const search = await screen.findByLabelText(/search or add a contact/i)
    fireEvent.change(search, { target: { value: 'Zoe' } })
    fireEvent.click(await screen.findByRole('button', { name: /^zoe/i }))
    expect(onPick).toHaveBeenCalledWith({ kind: 'contact', contactId: 'cZ' })
  })

  it('quick-add creates a contact and emits a contact target with the new id', async () => {
    const onPick = vi.fn()
    render(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} canMintNew onPick={onPick} />)
    const search = await screen.findByLabelText(/search or add a contact/i)
    fireEvent.change(search, { target: { value: 'Newbie' } })
    fireEvent.click(await screen.findByRole('button', { name: /create contact "newbie"/i }))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ kind: 'contact', contactId: 'c-new' }))
  })

  it('offers New speaker when canMintNew, disables it otherwise', async () => {
    const onPick = vi.fn()
    const { rerender } = render(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} canMintNew onPick={onPick} />)
    const newBtn = await screen.findByRole('button', { name: /new speaker/i })
    expect(newBtn).not.toBeDisabled()
    fireEvent.click(newBtn)
    expect(onPick).toHaveBeenCalledWith({ kind: 'newSpeaker' })

    rerender(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} canMintNew={false} onPick={onPick} />)
    expect(screen.getByRole('button', { name: /new speaker/i })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakerTargetPicker.test.tsx`
Expected: FAIL — `Failed to resolve import "../SpeakerTargetPicker"` (file does not exist yet).

- [ ] **Step 3: Write the component**

Create `apps/electron/src/features/library/components/SpeakerTargetPicker.tsx`:

```tsx
/**
 * SpeakerTargetPicker
 *
 * Assign-style target chooser shared by the By-Speaker reassign control. Lists the
 * recording's existing speakers (by assigned name or "Speaker X", excluding the source),
 * a contact search (meeting attendees first, then all contacts) with a Create-contact
 * quick-add, and a "New speaker" option. Emits the chosen target via onPick; the caller
 * (TranscriptViewer reassign control) translates that into a speakers:reassignTurns request.
 */

import { useEffect, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { PersonAvatar } from '@/components/harbor/PersonAvatar'
import { toast } from '@/components/ui/toaster'

export interface SpeakerOption {
  label: string
  name: string | null
}

export type PickedTarget =
  | { kind: 'existingLabel'; label: string }
  | { kind: 'contact'; contactId: string }
  | { kind: 'newSpeaker' }

export interface SpeakerTargetPickerProps {
  sourceLabel: string
  speakers: SpeakerOption[]
  meetingId?: string
  canMintNew: boolean
  onPick: (target: PickedTarget) => void
  disabled?: boolean
}

interface PickContact {
  id: string
  name: string
  email: string | null
}

export function SpeakerTargetPicker({
  sourceLabel,
  speakers,
  meetingId,
  canMintNew,
  onPick,
  disabled = false,
}: SpeakerTargetPickerProps) {
  const [attendees, setAttendees] = useState<PickContact[]>([])
  const [allContacts, setAllContacts] = useState<PickContact[]>([])
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const api = (window as any).electronAPI
      if (meetingId) {
        const res = await api.contacts.getForMeeting(meetingId)
        if (!cancelled && res?.success) setAttendees(res.data ?? [])
      }
      const all = await api.contacts.getAll({})
      if (!cancelled && all?.success) setAllContacts(all.data?.contacts ?? [])
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [meetingId])

  const otherSpeakers = useMemo(
    () => speakers.filter((s) => s.label !== sourceLabel),
    [speakers, sourceLabel]
  )

  const pickList = useMemo(() => {
    const seen = new Set(attendees.map((a) => a.id))
    const rest = allContacts.filter((c) => !seen.has(c.id))
    const merged = [...attendees, ...rest]
    const q = search.trim().toLowerCase()
    if (!q) return merged
    return merged.filter((c) => c.name.toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q))
  }, [attendees, allContacts, search])

  const exactNameMatch = useMemo(
    () => pickList.some((c) => c.name.trim().toLowerCase() === search.trim().toLowerCase()),
    [pickList, search]
  )

  async function createAndPick(name: string) {
    setBusy(true)
    try {
      const res = await (window as any).electronAPI.contacts.create({ name: name.trim() })
      if (res?.success && res.data?.id) {
        onPick({ kind: 'contact', contactId: res.data.id })
      } else {
        toast.error('Could not create contact', res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-[308px] space-y-2.5 p-3.5">
      <div className="space-y-0.5">
        {otherSpeakers.map((s) => (
          <button
            key={s.label}
            className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover disabled:opacity-50"
            aria-label={s.name ? `Reassign to ${s.name} (${s.label})` : `Reassign to Speaker ${s.label}`}
            onClick={() => onPick({ kind: 'existingLabel', label: s.label })}
            disabled={disabled || busy}
          >
            <PersonAvatar name={s.name ?? s.label} size={24} />
            <span className="min-w-0 flex-1 truncate font-medium text-ink">
              {s.name ?? `Speaker ${s.label}`}
            </span>
            {s.name && <span className="font-mono text-[11px] text-ink-muted">{s.label}</span>}
          </button>
        ))}
      </div>

      <Input
        aria-label="Search or add a contact"
        placeholder="Search or add a contact..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        disabled={disabled || busy}
      />
      <div className="max-h-44 space-y-0.5 overflow-y-auto">
        {pickList.map((c) => {
          const isAttendee = attendees.some((a) => a.id === c.id)
          return (
            <button
              key={c.id}
              className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover disabled:opacity-50"
              aria-label={c.name}
              onClick={() => onPick({ kind: 'contact', contactId: c.id })}
              disabled={disabled || busy}
            >
              <PersonAvatar name={c.name} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{c.name}</span>
                {c.email && <span className="block truncate text-[11px] text-ink-muted">{c.email}</span>}
              </span>
              {isAttendee && (
                <Badge variant="accent" size="sm">
                  Attendee
                </Badge>
              )}
            </button>
          )
        })}
        {search.trim() && !exactNameMatch && (
          <button
            className="flex w-full items-center gap-2.5 rounded-md border border-dashed border-border-strong px-2 py-2 text-left text-sm text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
            aria-label={`Create contact "${search.trim()}"`}
            onClick={() => createAndPick(search)}
            disabled={disabled || busy}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-strong-soft text-base leading-none text-accent-strong">
              +
            </span>
            <span className="font-medium">Create contact &quot;{search.trim()}&quot;</span>
          </button>
        )}
      </div>

      <button
        className="block w-full rounded-sm px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="New speaker"
        title={canMintNew ? 'Move to a brand-new speaker' : 'All 26 speaker letters are in use'}
        onClick={() => onPick({ kind: 'newSpeaker' })}
        disabled={disabled || busy || !canMintNew}
      >
        New speaker
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakerTargetPicker.test.tsx`
Expected: PASS (all cases green — existing-speaker listing/exclusion by label, pick existing, contact search + pick, quick-add create, New speaker enabled/disabled).

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/features/library/components/SpeakerTargetPicker.tsx apps/electron/src/features/library/components/__tests__/SpeakerTargetPicker.test.tsx
git commit -m "feat(electron): add SpeakerTargetPicker shared target chooser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9"
```

---

### Task 3: Reassign control in `TranscriptViewer` By-Speaker rows + `SourceReader` wiring

**Files:**
- Modify: `apps/electron/src/features/library/components/TranscriptViewer.tsx` (add the `anchorIndex` to the by-speaker segment data ~159-198, add the new props ~18-26 + ~136-144, render a Reassign control on each by-speaker turn row ~449-461)
- Modify: `apps/electron/src/features/library/components/SourceReader.tsx` (build the `onReassign` callback + pass new props to `TranscriptViewer` ~995-1003)
- Test: `apps/electron/src/features/library/components/__tests__/TranscriptViewer.reassign.test.tsx` (new)
- Test: `apps/electron/src/features/library/components/__tests__/SourceReader.reassign.test.tsx` (new)

**Interfaces:**
- Consumes (from Task 2): `SpeakerTargetPicker`, `SpeakerOption`, `PickedTarget`.
- Consumes (from Task 1, via preload): `window.electronAPI.speakers.reassignTurns(request)` where `request = { recordingId, sourceLabel, anchorIndex, anchorStartMs, scope, target }`.
- Produces — `TranscriptViewer` new props (additive, all optional so existing callers are unchanged):
  ```ts
  // appended to TranscriptViewerProps
  meetingId?: string
  onReassign?: (request: {
    sourceLabel: string
    anchorIndex: number
    anchorStartMs: number
    scope: 'one' | 'before' | 'after'
    target: PickedTarget
  }) => void
  canMintNewSpeaker?: boolean   // false → "New speaker" disabled in the picker (Z in use)
  ```
- Produces — internal: the by-speaker segment now carries `anchorIndex` (its index in the FULL ordered `segments`/`turns` array), so the row knows the global index to send.

- [ ] **Step 1: Write the failing TranscriptViewer test**

Create `apps/electron/src/features/library/components/__tests__/TranscriptViewer.reassign.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TranscriptViewer } from '../TranscriptViewer'
import { makeTwoSpeakerTurns, switchToBySpeaker } from './transcriptViewerTestUtils'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'electronAPI', {
    value: {
      contacts: {
        getForMeeting: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getAll: vi.fn().mockResolvedValue({ success: true, data: { contacts: [], total: 0 } }),
        create: vi.fn(),
      },
    },
    writable: true,
    configurable: true,
  })
})

describe('TranscriptViewer — by-speaker reassign control', () => {
  it('does NOT render a reassign control when no onReassign handler is provided', () => {
    render(<TranscriptViewer transcript="" turns={makeTwoSpeakerTurns()} onSeek={vi.fn()} />)
    switchToBySpeaker()
    expect(screen.queryByRole('button', { name: /^reassign turn/i })).not.toBeInTheDocument()
  })

  it('renders the three scope options on a turn row when onReassign is provided', async () => {
    render(
      <TranscriptViewer
        transcript=""
        turns={makeTwoSpeakerTurns()}
        onSeek={vi.fn()}
        onReassign={vi.fn()}
        canMintNewSpeaker
      />
    )
    switchToBySpeaker()
    // Open the menu on the FIRST Alpha turn (global index 0).
    fireEvent.click(screen.getAllByRole('button', { name: /^reassign turn/i })[0])
    expect(await screen.findByRole('button', { name: /^reassign$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reassign all before/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reassign all after/i })).toBeInTheDocument()
  })

  it('picking a scope then a target calls onReassign with the correct global anchorIndex, scope, and target', async () => {
    const onReassign = vi.fn()
    render(
      <TranscriptViewer
        transcript=""
        turns={makeTwoSpeakerTurns()}
        speakerNames={{ A: 'Alice' }}
        onSeek={vi.fn()}
        onReassign={onReassign}
        canMintNewSpeaker
      />
    )
    switchToBySpeaker()
    // makeTwoSpeakerTurns(): [A@0, B@4000, A@9000]. The SECOND Alpha turn is global index 2.
    // It is the 2nd reassign control inside speaker A's card.
    fireEvent.click(screen.getByText('Alpha second line.').closest('[data-testid="by-speaker-turn"]')!
      .querySelector('button[aria-label^="Reassign turn"]')! as HTMLElement)
    fireEvent.click(await screen.findByRole('button', { name: /reassign all after/i }))
    // Target picker opens: pick existing speaker B ("Speaker B" since B is unnamed).
    fireEvent.click(await screen.findByRole('button', { name: /reassign to speaker b/i }))
    expect(onReassign).toHaveBeenCalledWith({
      sourceLabel: 'A',
      anchorIndex: 2,
      anchorStartMs: 9000,
      scope: 'after',
      target: { kind: 'existingLabel', label: 'B' },
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.reassign.test.tsx`
Expected: FAIL — `onReassign` prop not accepted and no reassign control / `data-testid="by-speaker-turn"` is rendered.

- [ ] **Step 3: Add the props, the global anchorIndex, and the reassign control to TranscriptViewer**

In `apps/electron/src/features/library/components/TranscriptViewer.tsx`:

3a. Add imports after the `formatTimestamp` import (~15):

```tsx
import { SpeakerTargetPicker, type PickedTarget } from './SpeakerTargetPicker'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
```

3b. Extend `TranscriptViewerProps` (after `actionItems?: string[]` ~25):

```tsx
  meetingId?: string
  onReassign?: (request: {
    sourceLabel: string
    anchorIndex: number
    anchorStartMs: number
    scope: 'one' | 'before' | 'after'
    target: PickedTarget
  }) => void
  canMintNewSpeaker?: boolean
```

3c. Destructure them in the component signature (after `actionItems` ~143):

```tsx
  meetingId,
  onReassign,
  canMintNewSpeaker = true,
```

3d. Carry the global index on each segment. Change the `segments` memo (~157-167) so each entry includes its global index:

```tsx
  const segments = useMemo(() => {
    if (hasStructuredTurns) {
      return turns!.map((t, i) => ({
        startMs: t.startMs,
        endMs: t.endMs,
        text: t.text,
        speaker: t.speaker,
        anchorIndex: i
      }))
    }
    return parseTranscriptSegments(transcript).map((s, i) => ({ ...s, anchorIndex: i }))
  }, [hasStructuredTurns, turns, transcript])
```

Add `anchorIndex` to the `TranscriptSegment` interface (~28-33):

```tsx
interface TranscriptSegment {
  startMs: number
  endMs?: number
  text: string
  speaker?: string
  anchorIndex?: number
}
```

**CRITICAL — `anchorIndex` must survive the by-speaker grouping.** The existing `speakerGroups`
memo groups `segments` by speaker into `groups[].segments[]`. It MUST push the FULL segment object
through (spread or reference) so `anchorIndex` rides along — do NOT reconstruct group segments from
only `{ startMs, endMs, text, speaker }`. If the grouping drops `anchorIndex`, every by-speaker row
gets `anchorIndex === undefined`, the `ReassignControl` render guard (`seg.anchorIndex !== undefined`)
suppresses the control, and any reassign that did fire would trip the server stale-anchor guard. Verify
the grouping step preserves the field; the Task 3 TranscriptViewer test (asserting `anchorIndex: 2` for
the second Alpha turn) and the SourceReader non-zero-index test both fail loudly if it is dropped.

3e. Build the `SpeakerOption[]` list for the picker, after `speakerGroups` (~215):

```tsx
  // Existing speakers for the reassign target picker: label -> display name (null if unnamed).
  const speakerOptions = useMemo(
    () => speakerGroups.groups.map((g) => ({ label: g.key, name: speakerNames?.[g.key] ?? null })),
    [speakerGroups, speakerNames]
  )
```

3f. In the by-speaker per-segment row (~449-461), wrap the existing row in a tagged container and add the reassign control. Replace:

```tsx
                                {g.segments.map((seg, j) => (
                                  <div key={j} className="flex gap-3 rounded-md px-2 py-1 transition-colors hover:bg-surface-hover">
                                    <TimeAnchor
                                      startMs={seg.startMs}
                                      endMs={seg.endMs}
                                      onSeek={onSeek}
                                      className="w-11 flex-none px-0 text-[11px] no-underline hover:underline"
                                    >
                                      {null}
                                    </TimeAnchor>
                                    <div className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-foreground">{seg.text}</div>
                                  </div>
                                ))}
```

with:

```tsx
                                {g.segments.map((seg, j) => (
                                  <div
                                    key={j}
                                    data-testid="by-speaker-turn"
                                    className="flex items-start gap-3 rounded-md px-2 py-1 transition-colors hover:bg-surface-hover"
                                  >
                                    <TimeAnchor
                                      startMs={seg.startMs}
                                      endMs={seg.endMs}
                                      onSeek={onSeek}
                                      className="w-11 flex-none px-0 text-[11px] no-underline hover:underline"
                                    >
                                      {null}
                                    </TimeAnchor>
                                    <div className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-foreground">{seg.text}</div>
                                    {onReassign && seg.speaker && seg.anchorIndex !== undefined && (
                                      <ReassignControl
                                        sourceLabel={seg.speaker}
                                        anchorIndex={seg.anchorIndex}
                                        anchorStartMs={seg.startMs}
                                        speakers={speakerOptions}
                                        meetingId={meetingId}
                                        canMintNew={canMintNewSpeaker}
                                        onReassign={onReassign}
                                      />
                                    )}
                                  </div>
                                ))}
```

3g. Add the `ReassignControl` sub-component above `TranscriptViewer` (after `RETURN_TO_TOP_THRESHOLD` ~134):

```tsx
interface ReassignControlProps {
  sourceLabel: string
  anchorIndex: number
  anchorStartMs: number
  speakers: Array<{ label: string; name: string | null }>
  meetingId?: string
  canMintNew: boolean
  onReassign: (request: {
    sourceLabel: string
    anchorIndex: number
    anchorStartMs: number
    scope: 'one' | 'before' | 'after'
    target: PickedTarget
  }) => void
}

function ReassignControl({
  sourceLabel,
  anchorIndex,
  anchorStartMs,
  speakers,
  meetingId,
  canMintNew,
  onReassign,
}: ReassignControlProps) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<'one' | 'before' | 'after' | null>(null)

  function choose(target: PickedTarget) {
    if (!scope) return
    onReassign({ sourceLabel, anchorIndex, anchorStartMs, scope, target })
    setScope(null)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setScope(null)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2 text-xs"
          aria-label={`Reassign turn at ${anchorStartMs}`}
        >
          Reassign
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-0">
        {scope === null ? (
          <div className="space-y-0.5 p-2">
            <button
              className="block w-full rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover"
              aria-label="Reassign"
              onClick={() => setScope('one')}
            >
              Reassign
            </button>
            <button
              className="block w-full rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover"
              aria-label="Reassign all before"
              onClick={() => setScope('before')}
            >
              Reassign All Before
            </button>
            <button
              className="block w-full rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover"
              aria-label="Reassign all after"
              onClick={() => setScope('after')}
            >
              Reassign All After
            </button>
          </div>
        ) : (
          <SpeakerTargetPicker
            sourceLabel={sourceLabel}
            speakers={speakers}
            meetingId={meetingId}
            canMintNew={canMintNew}
            onPick={choose}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}
```

- [ ] **Step 4: Run the TranscriptViewer test to verify it passes**

Run: `cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.reassign.test.tsx`
Expected: PASS (all 3 cases green).

- [ ] **Step 5: Write the failing SourceReader wiring test**

Create `apps/electron/src/features/library/components/__tests__/SourceReader.reassign.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SourceReader } from '../SourceReader'
import { useConfigStore } from '@/store/domain/useConfigStore'
import type { UnifiedRecording } from '@/types/unified-recording'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))
vi.mock('@/components/AudioPlayer', () => ({ AudioPlayer: () => null }))

const TURNS = [
  { speaker: 'A', startMs: 0, endMs: 4000, text: 'Alpha one.' },
  { speaker: 'B', startMs: 4000, endMs: 8000, text: 'Bravo one.' },
  { speaker: 'A', startMs: 8000, endMs: 12000, text: 'Alpha two.' },
]

const reassignTurns = vi.fn().mockResolvedValue({ success: true, data: { recordingId: 'rec-1', targetLabel: 'B', rewrittenCount: 1 } })
const getSuggestions = vi.fn().mockResolvedValue({ success: true, data: [] })

function recording(): UnifiedRecording {
  return {
    id: 'rec-1', filename: 'r.wav', title: 'R', location: 'local', transcriptionStatus: 'complete',
    dateRecorded: new Date().toISOString(),
  } as unknown as UnifiedRecording
}

beforeEach(() => {
  vi.clearAllMocks()
  useConfigStore.setState({
    config: { privacy: { enableVoiceprintCapture: false } } as unknown as import('@/types').AppConfig,
  })
  Object.defineProperty(window, 'electronAPI', {
    value: {
      transcripts: { getByRecordingId: vi.fn().mockResolvedValue({ turns: JSON.stringify(TURNS), full_text: 'x' }) },
      speakers: { getForRecording: vi.fn().mockResolvedValue({ success: true, data: {} }), getSuggestions, reassignTurns },
      contacts: {
        getForMeeting: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getAll: vi.fn().mockResolvedValue({ success: true, data: { contacts: [], total: 0 } }),
        create: vi.fn(),
      },
      recordings: { isSummaryStale: vi.fn().mockResolvedValue(false) },
      summarizationTemplates: { latestRun: vi.fn().mockResolvedValue({ success: false }), list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
      onVoiceprintCaptured: vi.fn(() => vi.fn()),
    },
    writable: true,
    configurable: true,
  })
})

describe('SourceReader — reassign wiring', () => {
  it('reassigning a by-speaker turn calls speakers.reassignTurns then refreshes (getSuggestions runs again)', async () => {
    render(
      <SourceReader
        recording={recording()}
        transcript={{ full_text: 'x', turns: JSON.stringify(TURNS) } as any}
        onSeek={vi.fn()}
      />
    )
    // Switch the transcript to By-speaker and open the reassign menu on the first A turn.
    fireEvent.click(await screen.findByRole('tab', { name: /by speaker/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /^reassign turn/i })[0])
    fireEvent.click(await screen.findByRole('button', { name: /^reassign$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reassign to speaker b/i }))

    await waitFor(() =>
      expect(reassignTurns).toHaveBeenCalledWith({
        recordingId: 'rec-1',
        sourceLabel: 'A',
        anchorIndex: 0,
        anchorStartMs: 0,
        scope: 'one',
        target: { kind: 'existingLabel', label: 'B' },
      })
    )
    // refreshSpeakers re-runs getSuggestions (initial mount call + post-reassign call).
    await waitFor(() => expect(getSuggestions.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('reassigning the SECOND A turn threads the correct NON-ZERO global anchorIndex/startMs', async () => {
    // TURNS: A@0 (idx 0), B@4000 (idx 1), A@8000 (idx 2). The second A turn is global index 2.
    // This guards against passing the within-speaker-group index (j=1) instead of the global
    // turns index (i=2) — a bug the index-0 test above cannot catch.
    render(
      <SourceReader
        recording={recording()}
        transcript={{ full_text: 'x', turns: JSON.stringify(TURNS) } as any}
        onSeek={vi.fn()}
      />
    )
    fireEvent.click(await screen.findByRole('tab', { name: /by speaker/i }))
    // The second A turn lives in speaker A's card; open its reassign menu via the turn row.
    fireEvent.click(
      screen
        .getByText('Alpha two.')
        .closest('[data-testid="by-speaker-turn"]')!
        .querySelector('button[aria-label^="Reassign turn"]')! as HTMLElement
    )
    fireEvent.click(await screen.findByRole('button', { name: /reassign all before/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reassign to speaker b/i }))

    await waitFor(() =>
      expect(reassignTurns).toHaveBeenCalledWith({
        recordingId: 'rec-1',
        sourceLabel: 'A',
        anchorIndex: 2,
        anchorStartMs: 8000,
        scope: 'before',
        target: { kind: 'existingLabel', label: 'B' },
      })
    )
  })
})
```

- [ ] **Step 6: Run the SourceReader test to verify it fails**

Run: `cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReader.reassign.test.tsx`
Expected: FAIL — `reassignTurns` is never called (SourceReader does not yet pass `onReassign`/`meetingId`/`canMintNewSpeaker` to `TranscriptViewer`).

- [ ] **Step 7: Wire SourceReader → TranscriptViewer**

In `apps/electron/src/features/library/components/SourceReader.tsx`, add a `handleReassign` callback near `refreshSpeakers` (after the `refreshSpeakers` `useCallback` block ~304):

```tsx
  // Compute whether a new speaker letter can still be minted (Z not in use). Mirrors the
  // handler's nextUnusedLetter Z-guard so the picker disables "New speaker" when full.
  //
  // INTENTIONAL ASYMMETRY — do NOT "unify" this with nextUnusedLetter. The renderer only needs
  // "is Z already in use?" (spec §4.6: if Z is in use, New speaker is disabled). The handler runs
  // the full nextUnusedLetter over the union of turn labels + recording_speakers rows and may
  // return null for the same condition. A recording whose ONLY label is 'Z' correctly disables
  // New speaker in BOTH paths (renderer: Z present → false; handler: highest === Z → null).
  // nextUnusedLetter is a node-main export; importing it into this renderer would cross the
  // web/node program boundary and break typecheck — keep this simple local check.
  const canMintNewSpeaker = !turns.some((t) => (t.speaker ?? '').trim().toUpperCase() === 'Z')

  const handleReassign = useCallback(
    async (request: {
      sourceLabel: string
      anchorIndex: number
      anchorStartMs: number
      scope: 'one' | 'before' | 'after'
      target: { kind: 'existingLabel'; label: string } | { kind: 'contact'; contactId: string } | { kind: 'newSpeaker' }
    }) => {
      if (!recordingId) return
      try {
        const res = await window.electronAPI.speakers.reassignTurns({ recordingId, ...request })
        if (res?.success) {
          refreshSpeakers().catch(() => {})
        } else {
          toast.error('Could not reassign turn', res?.error?.message)
        }
      } catch (err) {
        toast.error('Could not reassign turn', err instanceof Error ? err.message : String(err))
      }
    },
    [recordingId, refreshSpeakers]
  )
```

Then update the `<TranscriptViewer …>` usage (~995-1003) to thread the new props:

```tsx
            <TranscriptViewer
              transcript={transcript.full_text}
              turns={hasStructuredTurns ? turns : undefined}
              speakerNames={speakerNames}
              meetingId={meeting?.id}
              onReassign={handleReassign}
              canMintNewSpeaker={canMintNewSpeaker}
              currentTimeMs={currentTimeMs}
              onSeek={onSeek || (() => {})}
              showActionItems={true}
              actionItems={parseJsonArray<string>(transcript.action_items)}
            />
```

- [ ] **Step 8: Run both new tests to verify they pass**

Run: `cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.reassign.test.tsx src/features/library/components/__tests__/SourceReader.reassign.test.tsx`
Expected: PASS (both files green).

- [ ] **Step 9: Commit**

```bash
git add apps/electron/src/features/library/components/TranscriptViewer.tsx apps/electron/src/features/library/components/SourceReader.tsx apps/electron/src/features/library/components/__tests__/TranscriptViewer.reassign.test.tsx apps/electron/src/features/library/components/__tests__/SourceReader.reassign.test.tsx
git commit -m "feat(electron): reassign control on by-speaker turn rows + SourceReader wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9"
```

---

### Task 4: Remove the SpeakersPanel Turns pane

> **Red-green order is INVERTED for this task (test update precedes code deletion) — follow steps in order.** During Tasks 1–3 the old SpeakersPanel Turns-pane tests (`reassign a single turn …`, `collapsed by default`, `single-speaker recording also hides per-turn reassign`) still PASS, because the pane still exists. Step 1 converts those tests to the new "pane is gone" assertion (which then FAILS, Step 2), and only Step 3 deletes the pane (making it PASS, Step 4). Do NOT delete the pane before updating the test, and do NOT skip the intermediate Step-2 failure — running `npm run test:run` mid-flight will otherwise show a passing-but-doomed test and mask an incomplete deletion.

**Files:**
- Modify: `apps/electron/src/features/library/components/SpeakersPanel.tsx` (delete `openReassignTurn` state ~132, `turnsExpanded` state ~134, `reassignTurn` ~382-400, and the Turns collapsible JSX ~835-903; remove now-unused imports if any)
- Modify: `apps/electron/src/features/library/components/__tests__/SpeakersPanel.test.tsx` (delete the three Turns-pane tests BY TITLE — see Step 1 — plus the orphaned `mockUpdateTurns` helper and its `transcripts.updateTurns` stub)

**Interfaces:**
- Consumes: none new. This task only deletes; the roster (assign/merge/suggestions/"this is me") and props are unchanged.
- Produces: none. After this task, `grep -n "turnsExpanded\|openReassignTurn\|reassignTurn\|mockUpdateTurns" SpeakersPanel.tsx SpeakersPanel.test.tsx` returns nothing.

- [ ] **Step 1: Update the SpeakersPanel test to assert the Turns pane is GONE**

In `apps/electron/src/features/library/components/__tests__/SpeakersPanel.test.tsx`, delete the three Turns-pane tests **by their `it(...)` titles**, NOT by line range — they are non-contiguous (~130, ~160, ~200) and two ROSTER tests fall between them (`talk-time merges overlapping intervals …` ~177 and `single-speaker recording renders read-only (no merge control)` ~193) that MUST survive. Delete ONLY these three `it` blocks:
  - `reassign a single turn …` (~130)
  - `collapsed by default …` (~160)
  - `single-speaker recording also hides per-turn reassign` (~200)

Do NOT touch the tests at ~177 and ~193. Replace the three deleted tests with a single assertion that the pane no longer exists. Add this test inside the same top-level describe block:

```tsx
  it('no longer renders a Turns pane or any per-turn reassign control (moved to By-Speaker view)', async () => {
    const turns: Turn[] = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'first' },
      { speaker: 'A', startMs: 1000, endMs: 2000, text: 'second' },
      { speaker: 'B', startMs: 2000, endMs: 3000, text: 'third' },
    ]
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={turns} onChanged={vi.fn()} />)
    // The roster still renders (assign control present) ...
    expect(await screen.findByRole('button', { name: /assign contact to a/i })).toBeInTheDocument()
    // ... but the Turns pane toggle and per-turn reassign controls are gone.
    expect(screen.queryByRole('button', { name: /turns \(\d+\)/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reassign turn/i })).not.toBeInTheDocument()
  })
```

**Also clean up the now-orphaned `updateTurns` mock.** Deleting the `reassign a single turn …` test removes the ONLY use of the `mockUpdateTurns` helper. eslint `no-unused-vars` is set to **error**, so the leftover const is a hard LINT failure in the Task 5 gate (and the Step 5 grep does not catch it — it only greps `turnsExpanded`/`openReassignTurn`/`reassignTurn`). In the SAME test-file edit:
  - Delete the `const mockUpdateTurns = vi.fn().mockResolvedValue({ success: true })` line (~18).
  - Delete the `transcripts: { updateTurns: mockUpdateTurns },` entry from the `electronAPI` stub in `beforeEach` (~56).
  - Confirm: `grep -n "mockUpdateTurns" SpeakersPanel.test.tsx` returns nothing.

- [ ] **Step 2: Run the updated test to verify it fails**

Run: `cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.test.tsx`
Expected: FAIL on the new assertion — the Turns pane toggle (`Turns (3)`) and `reassign turn` controls are still rendered by the current SpeakersPanel.

- [ ] **Step 3: Delete the Turns pane from SpeakersPanel**

In `apps/electron/src/features/library/components/SpeakersPanel.tsx`:

3a. Delete the `openReassignTurn` state line (~132):

```tsx
  const [openReassignTurn, setOpenReassignTurn] = useState<number | null>(null)
```

3b. Delete the `turnsExpanded` state + its comment (~133-134):

```tsx
  // The per-turn reassign list can be long; collapsed by default.
  const [turnsExpanded, setTurnsExpanded] = useState(false)
```

3c. Delete the entire `reassignTurn` function (~382-400):

```tsx
  /** Reassign a single turn (by index) to a different existing label, then persist. */
  async function reassignTurn(turnIndex: number, toLabel: string) {
    setBusy(true)
    try {
      const updated = turns.map((t, i) => (i === turnIndex ? { ...t, speaker: toLabel } : t))
      const res = await (window as any).electronAPI.transcripts.updateTurns({
        recordingId,
        turns: updated,
      })
      if (res?.success) {
        setOpenReassignTurn(null)
        onChanged()
      } else {
        toast.error('Could not reassign turn', res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }
```

3d. Delete the entire Turns collapsible JSX block (~835-903) — the comment `{/* Per-turn reassign (AC3) … */}` through the closing of `{!readOnly && turns.length > 0 && ( … )}`:

```tsx
      {/* Per-turn reassign (AC3): change one turn's speaker to another existing label.
          Collapsible — the list is long on real recordings. */}
      {!readOnly && turns.length > 0 && (
        <div className="space-y-1.5">
          {/* ... entire Turns pane through its closing tags ... */}
        </div>
      )}
```

(Delete the whole conditional; leave the surrounding `</>` / `)` for the `panelExpanded` fragment intact.)

- [ ] **Step 4: Run the SpeakersPanel test to verify it passes**

Run: `cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.test.tsx`
Expected: PASS (roster tests still green; the new "no Turns pane" assertion passes).

- [ ] **Step 5: Verify no dangling references remain**

Run: `cd apps/electron && npx tsc -p tsconfig.web.json --noEmit 2>&1 | grep -i "turnsExpanded\|openReassignTurn\|reassignTurn" || echo "no dangling refs"`
Expected: `no dangling refs` (compiler finds no leftover identifiers; any leftover JSX referencing the deleted state would have errored).

Also confirm the orphaned test-file mock is gone (the lint gate would otherwise fail on it):

Run: `cd apps/electron && grep -rn "mockUpdateTurns" src/features/library/components/__tests__/SpeakersPanel.test.tsx || echo "no orphaned mockUpdateTurns"`
Expected: `no orphaned mockUpdateTurns`.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/features/library/components/SpeakersPanel.tsx apps/electron/src/features/library/components/__tests__/SpeakersPanel.test.tsx
git commit -m "refactor(electron): remove SpeakersPanel Turns pane (reassign now in By-Speaker view)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9"
```

---

### Task 5: Full quality gate

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a clean gate establishing the feature is complete.

- [ ] **Step 1: Run typecheck (node + web + tests)**

Run: `cd apps/electron && npm run typecheck`
Expected: PASS with no type errors in either program.

- [ ] **Step 2: Run lint**

Run: `cd apps/electron && npm run lint`
Expected: PASS with no errors (≤120 col; no unused imports/vars left over from the Turns-pane deletion — in particular the orphaned `mockUpdateTurns` const + `transcripts.updateTurns` stub must be gone, since `no-unused-vars` is an error).

- [ ] **Step 3: Run the full test suite**

Run: `cd apps/electron && npm run test:run`
Expected: PASS — all suites green, including the new `speakers-reassign.test.ts`, `SpeakerTargetPicker.test.tsx`, `TranscriptViewer.reassign.test.tsx`, `SourceReader.reassign.test.tsx`, and the updated `SpeakersPanel.test.tsx`.

- [ ] **Step 4: Commit (only if any lint/format autofixes were applied)**

```bash
git add -A
git commit -m "chore(electron): quality-gate fixes for reassign-by-speaker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9"
```

---

## Self-Review

**Spec coverage (§ → task):**
- §4.1 remove Turns pane → Task 4.
- §4.2 reassign control + 3 scope options, gated on handler → Task 3.
- §4.3 target picker (existing speakers excl. source, contact search attendees-first, create-contact, new speaker) → Task 2.
- §4.4 atomic `speakers:reassignTurns` (stale guard, scope selection, target resolution incl. assign-path capture, rewrite, invalidate, orphan clean) → Task 1.
- §4.5 SourceReader prop threading + onReassign→reassignTurns→refreshSpeakers → Task 3.
- §4.6 next-unused-letter (highest+1, gaps, none→A, Z→null) → Task 1 (`nextUnusedLetter`) + Task 3 (`canMintNewSpeaker` disables "New speaker").
- §5 source-scoped + anchor-inclusive semantics → Task 1 scope math + tests.
- §6 re-voiceprinting via invalidation set + refresh → Task 1 invalidation (incl. `clearSuggestionsInFlight`, a LOCAL function not assertable via the db mock — its presence is documented in the invalidation test NOTE and exercised indirectly by the Task 3 refresh re-running `getSuggestions`); Task 3 refresh; SourceReader test asserts `getSuggestions` re-runs.
- §7 edge cases: stale anchor (Task 1 guard + 3 tests: startMs mismatch, speaker mismatch, AND out-of-bounds index → `turns[anchorIndex]` undefined → `!anchor` branch fires first, no write); emptied source (Task 1 orphan delete + test; the "not deleted when source survives" test now also asserts A is present in the rewritten array, so the precondition is non-vacuous); all-26 used (Task 1 `null` + Task 3 disable; `nextUnusedLetter` suite covers `['Z']`-only and `['A','Z']` for the `>=` Z-guard, plus single `['A']`); reassign-all to present contact reuses letter (Task 1 test); AC3 non-source turns untouched (Task 1 `expectOtherSpeakersTurnsUnchanged` cross-check in the one/before/after tests); index shift not cached across calls (anchorIndex recomputed each render in Task 3); no transcript/no turns (existing `hasStructuredTurns`/`canGroupBySpeaker` guards unchanged).
- §8/§9 ACs 1-8 → covered by Tasks 1-4 tests; AC8 (typecheck+lint+tests) → Task 5.

**Placeholder scan:** No TBD/TODO/"similar to"/"handle edge cases" — every code and test step shows complete TS/TSX with real assertions and the exact scope index math and `nextUnusedLetter` body.

**Type/name consistency:** `ReassignTurnsRequest`/`ReassignTarget` (Task 1) match the preload method signature (Task 1 Step 5), the `onReassign` request shape (Task 3 props), and the `handleReassign` argument (Task 3 SourceReader). `nextUnusedLetter(usedLabels: string[]): string | null` is used identically in Task 1 handler and tests. `SpeakerTargetPicker`/`SpeakerOption`/`PickedTarget` (Task 2) are consumed verbatim in Task 3. `data-testid="by-speaker-turn"` (Task 3 markup) matches the Task 3 test selector. The handler success payload `{ recordingId, targetLabel, rewrittenCount }` is consistent across handler, preload type, and tests.

**Global-index availability (critical):** TranscriptViewer's by-speaker `segments` did NOT preserve the global turns index — Task 3 Step 3d adds `anchorIndex: i` to each segment at the `turns.map((t, i) => …)` source AND requires the `speakerGroups` grouping to pass the full segment object through (explicit CRITICAL callout at Step 3d), so each by-speaker row sends the correct full-array index. This is verified at TWO indices: the Task 3 TranscriptViewer test asserts `anchorIndex: 2` for the second Alpha turn, and the Task 3 SourceReader non-zero-index test independently asserts `anchorIndex: 2, anchorStartMs: 8000` for the second A turn under a real SourceReader render — so a bug passing the within-group index `j` instead of the global `i` fails loudly (the index-0 test alone could not catch it). Anchor staleness is guarded server-side by `(startMs, speaker)` plus the out-of-bounds `!anchor` check (Task 1, 3 tests), so a concurrent edit cannot silently mis-target.
