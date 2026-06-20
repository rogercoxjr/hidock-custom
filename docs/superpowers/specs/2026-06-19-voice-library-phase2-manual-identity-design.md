# Voice Library — Phase 2: Manual Identity Assignment + Voiceprint Hygiene + Privacy Controls

**Date:** 2026-06-19
**App:** `apps/electron` (universal knowledge hub)
**Status:** Implementation-level design (sub-project A of rev-2). Derived from and subordinate to the approved design spec rev 2 (`docs/superpowers/specs/2026-06-19-voice-library-speaker-identity-design.md`); honors its §15 conflict hierarchy, §16 conceptual model, §17 non-goals.
**Builds on:** the SHIPPED Phase-1 foundation (`docs/superpowers/plans/2026-06-19-voice-library-foundation.md`) — ERes2Net model swap, v27 DB schema, off-thread `utilityProcess` embedding, the `privacy` config section, and the v27 DB helpers.
**Maps to rev-2 ACs:** AC5 (banking discipline — non-matcher part), AC6 (self suggested-not-applied + "mark me"), AC12 (undo & delete, un-bank a wrong print, `deleteVoiceprint` reachable from UI), AC13 (per-contact delete + disable-recognition toggle + exclude-from-backup). Touches rev-2 §4, §8, §10, §12, §14, §15, §16.

---

## 1. Problem & scope

Phase 1 shipped the entire **plumbing** for the voice library but **nothing in the renderer surfaces it, and there is no read/manage IPC**. Today:

- `captureVoiceprint` fires on `speakers:assign` (deferred via `setImmediate` in `speakers-handlers.ts`) and writes a `voiceprints` row — but the user **cannot see, audit, disable, or delete** any voiceprint. There is no IPC that lists voiceprints, and `deleteVoiceprint`/`disableVoiceprint` exist in `database.ts` but are **unreachable from the UI** (rev-2 §12 demands a delete path; AC12 demands it be reachable).
- The `privacy` config section (`enableVoiceprintCapture`, `excludeVoiceprintsFromBackup`) exists and `captureVoiceprint`/`embedRecordingLabels` already gate on `enableVoiceprintCapture` — but **there is no Settings UI** to toggle it, and the renderer `AppConfig` type (`src/types/index.ts`) **does not even include a `privacy` section**, so the renderer cannot read or write it (AC13).
- There is no "this is me" control. `setSelfContact`/`getSelfContactId` exist; `is_self` is a `contacts` column; but no IPC exposes it and `mapToPerson` doesn't surface it (AC6).
- `captureVoiceprint` writes a voiceprint with **no provenance** (`insertVoiceprint` only writes `id, contact_id, model_id, dim, embedding, created_at`; the v27 provenance columns `source_recording_id`, `source_label`, `clean_speech_ms`, `quality_score`, `created_from` are left NULL). Without provenance the Voices tab can't show "from which recording / when / how clean" and the wrong-match un-bank (AC12) can't find the specific print(s) an assignment produced.
- **Reassigning a label to a *different* contact strands a wrong-attribution print.** `speakers:assign` calls `upsertRecordingSpeaker`, whose conflict clause `DO UPDATE SET contact_id = excluded.contact_id` (verified `database.ts:2481`) overwrites the mapping in place, and the deferred `captureVoiceprint` (verified `speakers-handlers.ts:105-111`) fires unconditionally for the new contact — so reassigning label A from X to Y banks a new print for Y while X's earlier print for that exact provenance **survives in the library**. This is the most common AC12 wrong-match correction, and Phase 2 must make it leak-free (§3.6).
- `deleteContact` cascades only `meeting_contacts` — it leaves orphan `voiceprints` and `recording_speakers` rows (a biometric-data leak; AC13's "per-contact delete" intent is that deleting the person erases their prints).
- Banking is unconditional: **every** assign with ≥10 s clean speech banks a print, even for a fabricated/over-split label or a re-assignment correction. Rev-2 AC5/§10 require **conservative banking** ("clean speech only, gated by the privacy toggle, not suspected-mixed, consistent with existing prints"). The non-matcher half of that discipline is Phase 2's job.

**This sub-project's slice (A):** surface the shipped foundation in the renderer and add the missing read/manage IPC, plus tighten banking to the conservative rule and make assignments/banks reversible.

**Explicitly NOT in scope (deferred to sibling sub-project B / later phases):** no matcher, no identity/merge/mixed **suggestion generation**, no `speaker_suggestions` reads/writes from the UI, no auto-apply, no static `speaker_options` floor, no re-transcribe backstop, no recording-type inference. The `consistency-with-existing-prints` clause of AC5/§10 requires comparing embeddings — that comparison is **sub-project B's matcher**; Phase 2 implements the parts of conservative banking that need no embedding comparison (clean-speech gate, privacy gate, "remember vs accept-for-this-recording" distinction, corroboration-by-recording-count) and leaves a typed seam for B to add the consistency check.

---

## 2. Conceptual model (rev-2 §16 — kept distinct in this design)

- **Label** — a diarizer output letter (`"A"`) for one transcript run. Lives in `transcripts.turns` and `recording_speakers.file_label`.
- **Speaker assignment** — a `recording_speakers` row mapping one label → one contact for one recording. Reversible.
- **Contact / Person** — the user-facing identity (`contacts` table / `Person` UI type). Exactly one may be `is_self`.
- **Voiceprint** — one embedding sample (`voiceprints` row) with provenance. A contact has many prints.
- **Banking** — the act of persisting a voiceprint from an assignment. Distinct from making an assignment.

Phase 2 manipulates assignments, contacts (`is_self`), and voiceprints (list/disable/delete/bank). It never touches labels' turn data except through the existing `speakers:assign`/`speakers:merge`/`transcripts:updateTurns` paths.

---

## 3. Architecture & components

### 3.1 Main process: voiceprint provenance write (banking discipline core)

**Unit:** Extend `voiceprint-service.ts` `captureVoiceprint` to write provenance and apply the conservative banking gate.

- **What it does:** When an assignment banks a print, write the full v27 provenance (`source_recording_id`, `source_label`, `clean_speech_ms`, `quality_score`, `model_version`, `created_from`) instead of the bare 6 columns. Apply the Phase-2 banking gate before banking.
- **Interface:** unchanged signature `captureVoiceprint(recordingId, fileLabel, contactId): Promise<CaptureResult>`, but `CaptureResult` gains a discriminated `reason` enum and an optional `voiceprintId` so the caller can report outcome to the renderer (see §3.4). New shape:
  ```ts
  export type CaptureSkipReason =
    | 'voiceprint-disabled'      // privacy toggle off
    | 'voiceprint-unavailable'   // sherpa addon not loaded
    | 'no-audio-file'            // recording.file_path missing
    | 'insufficient-clean-speech'// < MIN_CLEAN_SPEECH_MS
    | 'no-samples'               // slicing produced 0 samples
    | 'decode-failed'
    | 'embedding-failed'
  export interface CaptureResult {
    captured: boolean
    voiceprintId?: string        // set when captured
    cleanSpeechMs?: number       // always set once turns are read (drives "enrolled X s" / "skipped — only Y s")
    reason?: CaptureSkipReason
  }
  ```
- **Dependencies:** `insertVoiceprint` (must be extended — see §3.7), `collectCleanSpeechMs` (exists), `getConfig().privacy.enableVoiceprintCapture` (already gated), `embedSamples` (worker pool, exists). `quality_score` for now = `null` (B owns a real quality metric); `created_from = 'manual'` for a `speakers:assign` bank, `'self'` for a self-enroll bank (§3.3).
- **Banking gate (the non-matcher part of AC5/§10):** bank only when (a) privacy toggle on, (b) `cleanSpeechMs ≥ MIN_CLEAN_SPEECH_MS` (existing 10 s). `captureVoiceprint` always banks the **new** contact's print for the (recordingId, fileLabel) when (a)+(b) hold; correctness for the *reassign* case comes not from suppressing this bank but from the **handler-level ordering** in §3.6 — the `speakers:assign` handler synchronously purges the *prior* contact's stranded prints (`deleteVoiceprintsBySource(rec, label, priorContactId)`) **before** the `setImmediate` that calls `captureVoiceprint` for the new contact. So `captureVoiceprint` itself needs no "is-this-a-correction" flag; the prior attribution is already gone by the time the new print lands. The **consistency-with-existing-prints** check (AC5 third clause) is left as a typed hook `shouldBankGivenExisting(newEmb, existingPrints): boolean` that returns `true` unconditionally in Phase 2 and is implemented by B's matcher (B §7 "Consistency" gate). This deferral is **only** about the embedding-comparison clause; the first-bank policy itself is FINAL (see the ratified Decision below) — not an open question.

> **Decision — FINAL (corroboration / "remember vs accept-for-this-recording"):** rev-2 §10 distinguishes "accept this label for THIS recording" (no bank) from "remember this voice" (bank). **Phase 2 BANKS on the FIRST clean assignment** (`created_from='manual'`) — it does **NOT** require ≥2 recordings before banking. The corroboration signal is surfaced as a **derived "remembered from N recordings" count** in the Voices tab (distinct `source_recording_id`), not as a gate on the first bank. Rationale: the matcher (B) consumes prints and can weight by print count, so blocking the first bank behind a 2-recording counter would only strand a usable print; the lowest-risk, leak-free reading of §10 is to bank immediately and expose the count as the corroboration signal. This is ratified and not subject to further confirmation.

### 3.2 Main process: NEW `voiceprints` IPC handlers

**Unit:** new file `electron/main/ipc/voiceprints-handlers.ts`, `registerVoiceprintsHandlers()` added to `handlers.ts` registration list (after `registerSpeakersHandlers()`).

Channels (all return the `Result<T>` pattern from `../types/api`, matching `contacts-handlers.ts`):

| Channel | Request (validated by zod) | Returns | Purpose |
|---|---|---|---|
| `voiceprints:listForContact` | `contactId: string` | `Result<VoiceprintSummary[]>` | Voices tab list (active + disabled). |
| `voiceprints:disable` | `{ id: string }` | `Result<void>` | Stop using a print for recognition (reversible — sets `disabled_at`). |
| `voiceprints:enable` | `{ id: string }` | `Result<void>` | Re-enable a disabled print (clears `disabled_at`). Symmetry for the toggle. |
| `voiceprints:delete` | `{ id: string }` | `Result<void>` | Hard-delete one print (AC12 un-bank / AC13 per-print delete). |
| `voiceprints:clearAllForContact` | `{ contactId: string }` | `Result<{ deleted: number }>` | "Forget this person's voice" — delete all their prints. |
| `voiceprints:clearAll` | none | `Result<{ deleted: number }>` | Settings "Clear all voiceprints" (AC13). |

`VoiceprintSummary` is a renderer-safe projection (the raw `embedding` BLOB is **never** sent to the renderer — privacy + payload size):
```ts
export interface VoiceprintSummary {
  id: string
  contactId: string
  modelId: string
  createdAt: string
  sourceRecordingId: string | null
  sourceRecordingTitle: string | null   // resolved via getRecordingById/knowledge title; null if recording gone
  sourceLabel: string | null
  cleanSpeechMs: number | null
  createdFrom: 'manual' | 'confirmed' | 'self' | 'import' | null
  disabledAt: string | null
}
```

- **Dependencies:** `getVoiceprintsByContactId` (exists — returns active+disabled; note `getActiveVoiceprintsByContactId` excludes disabled, used by the matcher not the UI), `disableVoiceprint`/`deleteVoiceprint` (exist), `getRecordingById` (exists, for title resolution), and a new `enableVoiceprint` + `deleteVoiceprintsByContactId` + `deleteAllVoiceprints` (§3.7). Title resolution: prefer the recording's knowledge-capture title if present, else `recording.filename`, else `null`.
- **Why a new handler file, not extend contacts-handlers:** voiceprints are a distinct resource with their own lifecycle; mirrors the speakers/contacts split already in the codebase.

### 3.3 Main process: `contacts:setSelf` + surface `is_self`

**Unit:** extend `contacts-handlers.ts`.

- `contacts:setSelf` — request `{ contactId: string | null }`, returns `Result<Person | null>`. With a `contactId`, calls `setSelfContact(contactId)` (exists; enforces the singleton in a transaction) and returns the re-fetched mapped person. There is intentionally no separate `clearSelf` channel in v1 — "this is me" moves to whoever you pick; to unset, pass `contactId: null`, which calls `clearSelfContact()` (§3.7; sets `is_self=0` on the current self) and returns `Result<null>`, so the user is never stranded.
- `contacts:getSelf` — request: none, returns `Result<Person | null>`. Resolves the current self via `getSelfContactId()` (exists, `database.ts:2946`) → `getContactById(id)` (exists, `database.ts:3343`) → `mapToPerson`; returns `success(null)` when no contact is `is_self`. **This is what drives the §3.10 move-confirm** (the renderer needs the *prior* self's name to render "X is currently marked as you — move it to Y?"). The original brief's "expose is_self (via getSelf or mapToPerson)" is satisfied by both halves: `mapToPerson` surfaces `isSelf` on the single contact being viewed, and `contacts:getSelf` answers "who is self right now" without loading every contact.
- **Expose `is_self`:** `mapToPerson` in `contacts-handlers.ts` adds `isSelf: contact.is_self === 1`. This requires the DB `Contact` interface and `getContactById`/`getContacts` to carry `is_self` (they already `SELECT *`, so it arrives at runtime; we just add it to the `Contact` type and to `mapToPerson`'s output). `Person` (renderer type, `src/types/knowledge.ts`) gains `isSelf?: boolean`.
- **Dependencies:** `setSelfContact`/`getSelfContactId`/`getContactById` (exist); `clearSelfContact` (new, §3.7); `Contact` interface + `Person` type edits.

### 3.4 Main process: report capture outcome to the renderer (capture feedback — rev-2 AC requires SpeakersPanel feedback)

**Decision:** `speakers:assign` currently fires `captureVoiceprint` in a `setImmediate` and only `console.log`s the result. To give the SpeakersPanel "enrolled / skipped (reason)" feedback (the rev-2 panel requirement and AC6's visibility), the handler emits a main→renderer push event when the deferred capture resolves.

**Push pattern (must match the codebase's real one).** Every main→renderer push in this app — `transcription:completed`, `activity-log:entry`, `migration:progress`, `domain-event`, `download-service:state-update` — uses a **module-scoped `let mainWindow: BrowserWindow | null`**, a `setMainWindowFor*(win)` exporter that `index.ts` calls once after `createWindow()`, and a guarded `mainWindow.webContents.send(channel, data)` (see `transcription.ts:38/43/822-826` `notifyRenderer`, `event-bus.ts:181`, `migration-handlers.ts:893`, all wired at `index.ts:266-270`). `getAllWebContents()` is used **nowhere** in `electron/main` (grep: zero hits), and `speakers-handlers.ts` today holds **no window reference and no `BrowserWindow` import**. The design therefore copies the existing exporter idiom rather than the (nonexistent) `getAllWebContents` broadcast:

- **`speakers-handlers.ts` gains a module-scoped window + exporter:**
  ```ts
  import { BrowserWindow, ipcMain } from 'electron'

  let mainWindow: BrowserWindow | null = null
  export function setMainWindowForSpeakers(win: BrowserWindow): void {
    mainWindow = win
  }
  ```
- **`index.ts` wires it** alongside the others (~line 268, inside the existing `if (mainWindow) { … }` block):
  ```ts
  setMainWindowForTranscription(mainWindow)
  setMainWindowForEventBus(mainWindow)
  setMainWindowForMigration(mainWindow)
  setMainWindowForSpeakers(mainWindow)   // ← added
  ```
  with `import { setMainWindowForSpeakers } from './ipc/speakers-handlers'` added next to the other handler imports.
- **New event channel `voiceprint:captured`** with payload `{ recordingId, fileLabel, contactId, captured, reason?, cleanSpeechMs?, voiceprintId?, purgedPriorContactId?, purgedCount? }`. The two `purged*` fields are set when the assign was a reassign-to-a-different-contact that auto-purged the prior contact's prints (§3.6); they let the panel show "removed N stale voiceprint(s) from X."
- **Preload exposes `onVoiceprintCaptured(cb): () => void`** (same idiom as `onTranscriptionCompleted`).
- **The `setImmediate` block in `speakers-handlers.ts` emits inside the existing `.then`**, guarded so a dead/destroyed window can't reject the IPC (mirrors `transcription.ts`'s `notifyRenderer`):
  ```ts
  // priorContactId + purgedCount are computed SYNCHRONOUSLY in the handler before this
  // setImmediate (see §3.6 reassign auto-purge); they are closed over here for the event.
  setImmediate(() => {
    captureVoiceprint(recordingId, fileLabel, contactId)
      .then((r) => {
        const payload = {
          recordingId, fileLabel, contactId,
          captured: r.captured, reason: r.reason, cleanSpeechMs: r.cleanSpeechMs, voiceprintId: r.voiceprintId,
          purgedPriorContactId: priorContactId !== contactId ? priorContactId ?? undefined : undefined,
          purgedCount: purgedCount || undefined
        }
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('voiceprint:captured', payload)
          }
        } catch (e) {
          console.warn(`[Voiceprint] send failed (${recordingId}/${fileLabel}): ${(e as Error).message}`)
        }
        if (!r.captured) console.log(`[Voiceprint] skipped (${recordingId}/${fileLabel}): ${r.reason}`)
      })
      .catch((e) => console.warn(`[Voiceprint] capture error (${recordingId}/${fileLabel}): ${(e as Error).message}`))
  })
  ```
  The `isDestroyed()` guard + `try/catch` mean a closed window simply drops the event; the `.then`/`.catch` structure already isolates this from the (already-returned) assign `Result`, so the IPC can never reject.

This keeps capture asynchronous (no UI block, preserving AC3's off-thread guarantee) while letting the panel show a transient "Enrolled voice (clean 14 s)" or "Voice not enrolled — only 6 s of clean speech" note.

### 3.5 Main process: contact-delete cascades voiceprints (AC13)

**Unit:** extend `deleteContact` in `database.ts`.

- **What it does:** before deleting the contact row, delete its voiceprints and (defensively) NULL/delete `recording_speakers` rows that point at it. Decision: `DELETE FROM voiceprints WHERE contact_id = ?` (hard delete — biometric data must not survive the person) and `DELETE FROM recording_speakers WHERE contact_id = ?` (an assignment to a deleted contact is meaningless; deleting the row makes the label "Unassigned" again, which is the correct UX). If `is_self` was set on this contact, the singleton simply becomes "no self," which is valid (`getSelfContactId` returns null).
- **Dependencies:** none new; reuses `run`. Wrap the multi-statement delete in `runInTransaction` for atomicity (helper exists at `database.ts:1745`).

### 3.6 Main process: un-bank a wrong assignment + reassign-to-a-different-contact (AC12)

**Reassign overwrites in place — this is the dominant wrong-match path, and it must not strand a biometric print.**

`speakers:assign` calls `upsertRecordingSpeaker`, whose SQL is `ON CONFLICT(recording_id, file_label) DO UPDATE SET contact_id = excluded.contact_id, …` (verified, `database.ts:2481`; PK is `(recording_id, file_label)`). So correcting a mis-assignment by reassigning label **A** from contact **X** to contact **Y** *overwrites* the existing row's `contact_id` in place, and the deferred `setImmediate` capture (verified `speakers-handlers.ts:105-111`, fires unconditionally) banks a **new** print for **Y** while **X's earlier print for that exact `(recordingId, fileLabel)` provenance is left in the library** — a stranded wrong-attribution biometric print for precisely the AC12 wrong-match case. The §3.12 unassign affordance only triggers on explicit `speakers:unassign`, never on reassign-to-a-different-contact, so without an explicit reassign policy AC12 is *not* satisfied for the dominant correction.

**Decision — policy (a): the reassign path auto-purges the prior contact's prints for that provenance (server-side, in the `speakers:assign` handler, before the capture fires).** Chosen over policy (b) (re-surfacing the unassign "remove the print this created?" prompt) because a reassignment is an explicit *correction* — the user is asserting "label A is NOT X, it is Y." Leaving X's biometric print banked under that false attribution is the exact leak AC12 forbids, and requiring a second confirmation tap to undo a correction the user just made is poor UX and easy to skip (leaving the leak in place). Auto-purge is the conservative, leak-free default; the print is recoverable only in the sense that re-assigning A back to X re-banks it from the same clean audio. The mechanics:

1. The `speakers:assign` handler reads the prior row **before** the upsert: `const prior = getRecordingSpeakers(recordingId).find(r => r.file_label === fileLabel)` (or a targeted `getRecordingSpeaker(recordingId, fileLabel)` helper, §3.7).
2. It computes `priorContactId = prior?.contact_id ?? null`.
3. After the upsert, **if `priorContactId` is non-null and `priorContactId !== contactId`** (a genuine contact change, not a re-confirm of the same contact and not a first assignment), it deletes the prior contact's prints for that provenance **scoped to that contact**: `deleteVoiceprintsBySource(recordingId, fileLabel, priorContactId)` (§3.7) — i.e. every voiceprint row whose `(source_recording_id, source_label, contact_id) == (recordingId, fileLabel, priorContactId)`. This runs synchronously inside the handler (not in the `setImmediate`), so the purge happens before the new `captureVoiceprint(recordingId, fileLabel, contactId)` for **Y** runs. Re-confirming the *same* contact (`priorContactId === contactId`) purges nothing — the re-bank below simply adds another corroborating print for that contact.
4. The `voiceprint:captured` push event (§3.4) is extended with an optional `purgedPriorContactId?: string` and `purgedCount?: number` so the SpeakersPanel can show "Reassigned to Y; removed N stale voiceprint(s) from X."

This makes the reassign correction leak-free without a second user tap, and it is the path AC12's "un-banks the specific print it produced" most needs covered.

**Two further reversal flows, both server-side:**

1. **Undo an assignment** (clear a label entirely). Phase 2 adds `speakers:unassign` — request `{ recordingId, fileLabel }`, reads the row first to learn the current `contact_id`, then calls `deleteRecordingSpeaker(recordingId, fileLabel)`. The label returns to "Unassigned" in the panel. **Un-bank decision:** unassigning does **not** auto-delete the banked print (the voice may be correctly remembered even if this one label was wrong), but it surfaces a "this assignment banked voiceprint(s) — remove them too?" affordance keyed by provenance **scoped to the contact that was just unassigned** (`source_recording_id == recordingId AND source_label == fileLabel AND contact_id == priorContactId`). The renderer offers a one-tap "remove" that calls `voiceprints:delete` for **each** matching print id (there may be more than one — see cardinality below). Unassign differs from reassign deliberately: there is no new attribution to correct *toward*, only a possibly-correct memory, so the user decides; reassign asserts a competing identity, so the stale print is purged automatically.
2. **Wrong-match un-bank** (the print itself is bad). Direct `voiceprints:delete` from the Voices tab (§3.2). Because provenance is now written, the Voices tab shows *which recording/label* each print came from, so the user can find and excise the bad one (AC12 "un-banks the specific print it produced").

**Cardinality contract for "find the print(s) this assignment produced".** The `voiceprints` table's only key is `id` (PK; verified `database.ts:276` — there is **no** unique constraint on `(source_recording_id, source_label)`). Every repeated assign to a label banks a fresh `vp_<uuid>`, and reassignments across contacts produce rows for *different* contacts with *identical* `(source_recording_id, source_label)` provenance. So `(source_recording_id, source_label)` is genuinely **many-rows, across multiple contacts** — a single-row lookup is ambiguous and could resolve the wrong contact's print or miss siblings. The contract is therefore **list-valued and contact-scoped**:

- **New helper:** `getVoiceprintsBySource(recordingId, fileLabel, contactId?): Voiceprint[]` in `database.ts` — returns **all** matching prints ordered by `created_at DESC` (newest first). When `contactId` is supplied it filters `AND contact_id = ?` (the scoped form the unassign/reassign affordances use to act on exactly one contact's prints); when omitted it returns every contact's prints for that provenance (diagnostic / Voices-tab cross-reference). SQL: `SELECT * FROM voiceprints WHERE source_recording_id = ? AND source_label = ? [AND contact_id = ?] ORDER BY created_at DESC`.
- **Exposed via `voiceprints:findBySource` IPC** — request `{ recordingId, fileLabel, contactId?: string }`, returns `Result<VoiceprintSummary[]>` (a **list**, not `... | null`). The inline un-bank affordance (§3.12) acts on **all** ids in the list (the renderer iterates `voiceprints:delete` per id, or §3.7 adds a `deleteVoiceprintsBySource` batch helper the handler calls once). The reassign auto-purge above uses the **scoped, contact-filtered** form (`priorContactId`) so it deletes only X's prints, never Y's freshly-banked one. AC12's "un-bank the specific print it produced" is satisfied: the provenance + contact scope pins exactly the print(s) a given (assignment → contact) produced, and the list-valued return ensures none are missed when an assignment was banked more than once.

### 3.7 Main process: extend `insertVoiceprint` + `Voiceprint` type + new hygiene helpers (`database.ts`)

- **`Voiceprint` interface** gains the v27 provenance fields as optional: `source_recording_id?`, `source_label?`, `clean_speech_ms?`, `quality_score?`, `model_version?`, `created_from?`, `disabled_at?`, `superseded_by?`.
- **`insertVoiceprint`** writes provenance:
  ```ts
  export function insertVoiceprint(vp: Omit<Voiceprint, 'created_at'>): void {
    run(`INSERT INTO voiceprints
      (id, contact_id, model_id, dim, embedding, created_at,
       source_recording_id, source_label, clean_speech_ms, quality_score, model_version, created_from)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [vp.id, vp.contact_id, vp.model_id, vp.dim, vp.embedding, new Date().toISOString(),
       vp.source_recording_id ?? null, vp.source_label ?? null, vp.clean_speech_ms ?? null,
       vp.quality_score ?? null, vp.model_version ?? 1, vp.created_from ?? 'manual'])
  }
  ```
  Backwards-compatible: existing callers that omit provenance still work (Phase-1 `embedRecordingLabels` writes label embeddings via `insertLabelEmbedding`, not `insertVoiceprint`, so only `captureVoiceprint` and the self-enroll path bank prints).
- **New helpers:**
  - `enableVoiceprint(id)` (`UPDATE voiceprints SET disabled_at=NULL WHERE id=?`).
  - `deleteVoiceprintsByContactId(contactId)` (returns count).
  - `deleteAllVoiceprints()` (returns count).
  - `getVoiceprintsBySource(recordingId, fileLabel, contactId?): Voiceprint[]` — **list-valued** (the table has no `(source_recording_id, source_label)` uniqueness, so this provenance maps to many rows across contacts; §3.6). `SELECT * FROM voiceprints WHERE source_recording_id=? AND source_label=? [AND contact_id=?] ORDER BY created_at DESC`. Replaces the earlier single-row `getVoiceprintBySource` draft, which was unsafe.
  - `deleteVoiceprintsBySource(recordingId, fileLabel, contactId): number` — batch un-bank for the reassign auto-purge (§3.6 step 3) and the inline unassign affordance. **Always contact-scoped** (the three-arg form) so it can only ever delete one contact's prints for that provenance, never another contact's freshly-banked print. `DELETE FROM voiceprints WHERE source_recording_id=? AND source_label=? AND contact_id=?`; returns the deleted count.
  - `getRecordingSpeaker(recordingId, fileLabel): RecordingSpeaker | undefined` — targeted single-row read so the `speakers:assign`/`speakers:unassign` handlers can learn the prior `contact_id` before mutating (avoids re-scanning all rows via `getRecordingSpeakers`). `SELECT * FROM recording_speakers WHERE recording_id=? AND file_label=? LIMIT 1`.
  - `clearSelfContact()` (`UPDATE contacts SET is_self=0 WHERE is_self=1`).

### 3.8 Renderer: AppConfig privacy type + config plumbing

- `src/types/index.ts` `AppConfig` gains:
  ```ts
  privacy: {
    enableVoiceprintCapture: boolean
    excludeVoiceprintsFromBackup: boolean
  }
  ```
  (matches `config.ts`). No store change needed — `useConfigStore.updateConfig('privacy', {...})` already works generically over `keyof AppConfig` and `config-handlers` `config:update-section` is section-generic.

### 3.9 Renderer: Settings "Privacy" card

**Unit:** new card in `src/pages/Settings.tsx` (between Chat/RAG and Storage cards), following the existing Card + dirty-state + `updateConfig` idiom.

- **Controls:**
  - Toggle **"Capture voiceprints"** → `privacy.enableVoiceprintCapture`. Off disables all future capture (already enforced server-side). Sub-text explains voiceprints are local-only biometric data.
  - Toggle **"Exclude voiceprints from backups & sync"** → `privacy.excludeVoiceprintsFromBackup`. **Consumer scoping decision (AC13):** no backup/sync feature ships in this app today, so this flag has no consumer. Phase 2 ships the toggle, defaults it `true`, and documents the contract: *any future backup/sync exporter MUST read `config.privacy.excludeVoiceprintsFromBackup` and skip the `voiceprints` table when true.* The card shows a small "Honored when backup/sync ships" note so the toggle isn't misleading. (Implementing a real consumer is out of scope; recorded in openQuestions.)
  - Button **"Clear all voiceprints"** → confirm dialog (`AlertDialog`, destructive) → `window.electronAPI.voiceprints.clearAll()` → toast "Removed N voiceprints." This is the global panic button (AC13 spirit).
- **Dependencies:** `useConfigStore`, `voiceprints.clearAll` preload bridge (§3.11), `AlertDialog` (already used in People/PersonDetail).
- **Decision:** save-on-toggle (immediate `updateConfig`) rather than the Save-button idiom the other cards use, because privacy toggles read better as instant switches; mirrors no existing card exactly but is the least-surprising behavior for a privacy control. (openQuestion — could align to Save button for consistency.)

### 3.10 Renderer: PersonDetail "Voices" tab + "This is me" control

**Unit:** extend `src/pages/PersonDetail.tsx`.

- **"This is me" control:** in the sticky header action row (next to Edit/Delete), a toggle button. When `person.isSelf` it renders "You" (filled, with a small user/badge icon); otherwise "Mark as me". Tooltip explains self is used to pre-select your own voice in transcripts (rev-2 §10/AC6 — self is *suggested*, never silently auto-applied; Phase 2 only records who "me" is — the suggesting is B's matcher).
- **Move-confirm (now backed by a real query):** clicking "Mark as me" first calls `window.electronAPI.contacts.getSelf()` (§3.3). If it returns a person whose `id !== this person's id`, show the named confirm "**{priorSelf.name}** is currently marked as you — move it to **{person.name}**?"; if it returns `null` (no current self) or the same id, skip the confirm. On confirm (or no-confirm-needed), call `window.electronAPI.contacts.setSelf({ contactId: id })` then `loadDetails()`. Because `getSelf` answers "who is self" directly, the prior self's name is always available to the prompt — the dialog is no longer specified against a data source that doesn't exist. (When already self, the button instead offers "Unset" → `contacts.setSelf({ contactId: null })`, no confirm.)
- **Third tab "Voices"** added to the existing `'timeline' | 'knowledge'` tab union → `'timeline' | 'knowledge' | 'voices'`. The tab grid becomes 3 columns. Content:
  - Calls `window.electronAPI.voiceprints.listForContact(id)` on tab open.
  - Renders one row per print: source recording title (link to it where resolvable), captured-at (`formatDateTime(createdAt)`), clean-speech duration (`formatDuration(cleanSpeechMs/1000)`), `createdFrom` badge, and per-row actions: **Disable/Enable** (`voiceprints.disable`/`.enable`, greys the row when disabled), **Delete** (confirm → `voiceprints.delete`, AC12).
  - Header summary: "Remembered from N recordings" (distinct `sourceRecordingId` count — the corroboration signal from §3.1) and a **"Forget this voice"** button (`voiceprints.clearAllForContact`, destructive confirm).
  - Empty state: "No voiceprints yet. Assign this person to a speaker in a transcript to remember their voice." with a privacy note when `enableVoiceprintCapture` is off ("Voiceprint capture is disabled in Settings").
- **Dependencies:** `voiceprints` + `contacts.setSelf` preload bridges; `useConfigStore` (to read `enableVoiceprintCapture` for the disabled-note); `AlertDialog`, `formatDateTime`/`formatDuration` (already imported / available in `@/lib/utils`).

### 3.11 Renderer: preload bridge additions (`electron/preload/index.ts`)

Add to `ElectronAPI` interface + the `electronAPI` object + the event-listener section:
```ts
voiceprints: {
  listForContact: (contactId: string) => Promise<Result<VoiceprintSummary[]>>
  disable: (id: string) => Promise<Result<void>>
  enable: (id: string) => Promise<Result<void>>
  delete: (id: string) => Promise<Result<void>>
  clearAllForContact: (contactId: string) => Promise<Result<{ deleted: number }>>
  clearAll: () => Promise<Result<{ deleted: number }>>
  findBySource: (recordingId: string, fileLabel: string, contactId?: string) => Promise<Result<VoiceprintSummary[]>>
}
contacts: {
  /* existing... */
  setSelf: (request: { contactId: string | null }) => Promise<Result<Person | null>>
  getSelf: () => Promise<Result<Person | null>>
}
speakers: { /* existing... */ unassign: (request: { recordingId: string; fileLabel: string }) => Promise<Result<void>> }
onVoiceprintCaptured: (cb: (data: { recordingId: string; fileLabel: string; contactId: string; captured: boolean; reason?: string; cleanSpeechMs?: number; voiceprintId?: string; purgedPriorContactId?: string; purgedCount?: number }) => void) => () => void
```
All call through the existing `callIPC` wrapper. `VoiceprintSummary` is imported from `../main/types/database` (add the export there alongside `Contact`).

### 3.12 Renderer: SpeakersPanel capture feedback + privacy gating

**Unit:** extend `src/features/library/components/SpeakersPanel.tsx`.

- **Capture feedback:** subscribe to `onVoiceprintCaptured` (in a `useEffect` keyed by `recordingId`). When an event arrives for this recording's label, store a transient per-label note in state: `captured` → "Voice remembered" (subtle check + tooltip with clean-speech seconds); skip reasons → human strings ("Not enough clean speech to remember the voice", "Voiceprint capture is off in Settings"). Render it inline next to the `→ <name>` assigned label. Auto-clears after ~6 s or on next change.
- **Privacy gating:** read `enableVoiceprintCapture` from `useConfigStore`. When off, show a one-line muted hint under the Speakers header ("Voice memory is off — assignments won't be remembered. Enable in Settings → Privacy.") and suppress the "Voice remembered" affordance. Assignment itself still works (capture is the only thing gated).
- **Unassign:** the existing Assign/Reassign control gains a "Clear assignment" option in the picker (calls `speakers.unassign`). The renderer remembers the label's current `contactId` (from the roster it already renders) before clearing; on success it calls `voiceprints.findBySource(recordingId, fileLabel, priorContactId)` and, if the returned **list** is non-empty, prompts "Also remove the N voiceprint(s) this created?" → iterates `voiceprints.delete` over **every** id in the list (or calls a single batched delete). This is the AC12 inline un-bank, scoped to the unassigned contact so it never touches another contact's prints for the same provenance.
- **Reassign (label → different contact):** handled server-side, no extra renderer step — `speakers:assign` auto-purges the prior contact's prints (§3.6). The panel just reflects the `voiceprint:captured` event's `purgedPriorContactId`/`purgedCount` as a transient "Reassigned; removed N stale voiceprint(s)" note.
- **Dependencies:** `useConfigStore`, the new preload bridges. No change to the merge/reassign turn logic.

### 3.13 Renderer: carry `contactId` per label from SourceReader into SpeakersPanel (BLOCKING — required by §3.6/§3.12 inline un-bank)

**Problem (verified against the real code).** SpeakersPanel's only assignment prop today is `assignedNames?: Record<string, string>` (label → contact **name**, `SpeakersPanel.tsx:20` + consumed at `:209` for the `→ <name>` display). `SourceReader.refreshSpeakers` (`SourceReader.tsx:146-180`) already fetches `speakers:getForRecording`, whose handler returns the richer `Record<string, { contactId; contactName }>` (verified `speakers-handlers.ts:185-212`), but it **collapses that to names only** at `SourceReader.tsx:170-175`:
```ts
const names: Record<string, string> = {}
if (speakerRes?.success && speakerRes.data) {
  for (const [label, entry] of Object.entries(speakerRes.data)) {
    names[label] = (entry as { contactName: string }).contactName
  }
}
setSpeakerNames(names)
```
and passes that names-only map as `assignedNames={speakerNames}` (`SourceReader.tsx:679`). So the panel has the assigned **name** but **not the `contactId`** for any label. The §3.12 inline un-bank cannot run: on "Clear assignment" it must call `voiceprints.findBySource(recordingId, fileLabel, priorContactId)`, and the §3.6 contract keeps `findBySource` **contact-scoped** (so it can never return another contact's prints) — but `priorContactId` is exactly what the panel does not have. **Without this widening, the AC12 inline un-bank affordance is unimplementable.**

**Decision — widen the prop to carry `contactId` per label (keep names for display).** Do **not** overload `assignedNames`; add a new, explicit prop and keep `assignedNames` for the display path so the change is additive and the existing `→ <name>` render is untouched:

- **`SpeakersPanel` prop addition:**
  ```ts
  /** Existing label -> { contactId, contactName } map (from recording_speakers join). */
  assignedSpeakers?: Record<string, { contactId: string; contactName: string }>
  ```
  The display path keeps reading the name (now from `assignedSpeakers?.[label]?.contactName`, with `assignedNames` retained only as a fallback during the transition or removed once SourceReader is updated). The inline un-bank reads `assignedSpeakers?.[label]?.contactId` as `priorContactId` and passes it into `voiceprints.findBySource(recordingId, fileLabel, priorContactId)`.
- **`SourceReader.refreshSpeakers` STOPS collapsing to names.** Replace the `names: Record<string, string>` projection at `SourceReader.tsx:170-175` so it preserves `contactId`. The component holds the full map in state (e.g. widen `speakerNames` state to `Record<string, { contactId; contactName }>`, renaming to `assignedSpeakers`, or add a parallel `speakerContactIds` map). **TranscriptViewer compatibility:** `TranscriptViewer` (passed `speakerNames={speakerNames}` at `SourceReader.tsx:687`) consumes names-only; preserve that contract either by (a) keeping a derived `Record<string,string>` for TranscriptViewer (`Object.fromEntries(Object.entries(assignedSpeakers).map(([l, e]) => [l, e.contactName]))`) or (b) updating TranscriptViewer's prop too — (a) is the minimal, lower-blast-radius choice and is the design default. No handler/IPC change is needed: `speakers:getForRecording` **already** returns `{ contactId, contactName }`; this fix only stops SourceReader from discarding the `contactId` it already receives.
- **Prop wiring at `SourceReader.tsx:675-681`:** pass `assignedSpeakers={...}` (the un-collapsed map) to `<SpeakersPanel>`.

**Dependencies:** no main-process change (the handler shape is already correct); SourceReader state + projection edit; SpeakersPanel prop + inline-un-bank read. This is a prerequisite of the §3.12 "Clear assignment" / inline un-bank and the §3.6 contact-scoped `findBySource` use.

---

## 4. Data flow

**Assign → bank (with reassign auto-purge + feedback):**
```
SpeakersPanel.assign(label, contactId)
  → speakers:assign IPC  [synchronous, returns immediately]
       → priorContactId = getRecordingSpeaker(rec, label)?.contact_id   (read BEFORE mutating)
       → upsertRecordingSpeaker(source='user')                          (overwrites contact_id in place)
       → if priorContactId && priorContactId !== contactId:             (reassign-to-different-contact)
            purgedCount = deleteVoiceprintsBySource(rec, label, priorContactId)   ← leak-free; removes ONLY X's prints
  → setImmediate: captureVoiceprint(rec, label, contactId)
       → privacy gate (enableVoiceprintCapture) → clean-speech gate (≥10s)
       → decode (utilityProcess) → embedSamples → insertVoiceprint(+provenance, created_from='manual')
       → webContents.send('voiceprint:captured', { captured, reason, cleanSpeechMs, voiceprintId, purgedPriorContactId, purgedCount })
  → renderer onVoiceprintCaptured → SpeakersPanel shows "Voice remembered" / "skipped: <reason>" / "removed N stale print(s) from X"
```

**Voices tab:**
```
PersonDetail open "Voices" → voiceprints:listForContact(id)
  → getVoiceprintsByContactId(id) (active+disabled) → for each: resolve title via getRecordingById
  → project to VoiceprintSummary[] (NO embedding BLOB) → render rows
  row Disable → voiceprints:disable → disableVoiceprint (sets disabled_at) → refetch
  row Delete  → confirm → voiceprints:delete → deleteVoiceprint → refetch
  "Forget this voice" → voiceprints:clearAllForContact → deleteVoiceprintsByContactId → refetch
```

**This is me:**
```
PersonDetail "Mark as me" → contacts:setSelf({contactId}) → setSelfContact (txn singleton) → loadDetails → header shows "You"
```

**Privacy / clear-all:**
```
Settings Privacy card toggle → useConfigStore.updateConfig('privacy', {...}) → config:update-section → saveConfig
Settings "Clear all voiceprints" → confirm → voiceprints:clearAll → deleteAllVoiceprints → toast "Removed N"
```

**Contact delete cascade:**
```
People/PersonDetail delete → contacts:delete → deleteContact (txn: del meeting_contacts, voiceprints, recording_speakers, contact)
```

---

## 5. New IPC endpoints + preload bridge (summary)

| Channel | Handler file | DB calls |
|---|---|---|
| `voiceprints:listForContact` | voiceprints-handlers.ts (new) | `getVoiceprintsByContactId`, `getRecordingById` |
| `voiceprints:disable` / `:enable` | voiceprints-handlers.ts | `disableVoiceprint` / `enableVoiceprint` (new) |
| `voiceprints:delete` | voiceprints-handlers.ts | `deleteVoiceprint` |
| `voiceprints:clearAllForContact` | voiceprints-handlers.ts | `deleteVoiceprintsByContactId` (new) |
| `voiceprints:clearAll` | voiceprints-handlers.ts | `deleteAllVoiceprints` (new) |
| `voiceprints:findBySource` | voiceprints-handlers.ts | `getVoiceprintsBySource` (new; list-valued, optional contact scope) |
| `contacts:setSelf` | contacts-handlers.ts (extend) | `setSelfContact` / `clearSelfContact` (new) |
| `contacts:getSelf` | contacts-handlers.ts (extend) | `getSelfContactId`, `getContactById` → `mapToPerson` |
| `speakers:assign` (reassign auto-purge) | speakers-handlers.ts (extend) | `getRecordingSpeaker` (new) → `upsertRecordingSpeaker` → `deleteVoiceprintsBySource` (new, contact-scoped) when prior contact differs |
| `speakers:unassign` | speakers-handlers.ts (extend) | `getRecordingSpeaker` (new) → `deleteRecordingSpeaker` |
| `voiceprint:captured` (push event) | speakers-handlers.ts (module-scoped `mainWindow` via new `setMainWindowForSpeakers`, wired in `index.ts:268`) | — |

Preload: add `voiceprints` namespace, `contacts.setSelf`, `contacts.getSelf`, `speakers.unassign`, `onVoiceprintCaptured`. Register `registerVoiceprintsHandlers()` in `handlers.ts`. Wire `setMainWindowForSpeakers(mainWindow)` in `index.ts` next to `setMainWindowForTranscription`/`...EventBus`/`...Migration`.

---

## 6. New/modified renderer components

- **`src/types/index.ts`** — `AppConfig.privacy` added.
- **`src/types/knowledge.ts`** — `Person.isSelf?: boolean`.
- **`electron/preload/index.ts`** — `voiceprints` namespace, `contacts.setSelf`, `contacts.getSelf`, `speakers.unassign`, `onVoiceprintCaptured`.
- **`src/pages/Settings.tsx`** — Privacy card.
- **`src/pages/PersonDetail.tsx`** — "Voices" tab + "This is me" control; thread `isSelf` through `loadDetails`'s person mapping.
- **`src/features/library/components/SpeakersPanel.tsx`** — capture feedback, privacy hint, clear-assignment + inline un-bank; **new `assignedSpeakers?: Record<string, { contactId; contactName }>` prop** (§3.13) so the inline un-bank can pass `priorContactId` into the contact-scoped `voiceprints.findBySource`.
- **`src/features/library/components/SourceReader.tsx`** (§3.13) — `refreshSpeakers` STOPS collapsing `speakers:getForRecording` to names-only; preserve `{ contactId, contactName }` per label in state and pass it to `<SpeakersPanel assignedSpeakers={…}>`. Keep a derived names-only map for `TranscriptViewer` (its `speakerNames` prop contract is unchanged). No IPC/handler change — the handler already returns `contactId`.
- (No change to `People.tsx` UI required; it benefits from the cascade fix transparently. Optional: a small "You" badge on the self card — deferred.)

---

## 7. Error handling & edge cases

- **Capture never fails the assign IPC** (preserved): the `setImmediate`/`.then`/`.catch` structure stays; the new `webContents.send` is inside `.then` and is itself wrapped so a dead webContents can't throw.
- **No voiceprint engine (sherpa unavailable):** `captureVoiceprint` returns `{captured:false, reason:'voiceprint-unavailable'}`; SpeakersPanel shows nothing (silent, per Phase-1 §6.7) rather than a scary error. The Voices tab still lists any previously-banked prints.
- **Recording deleted but print remains:** `voiceprints:listForContact` resolves `sourceRecordingTitle=null`; the row shows "from a deleted recording" and the link is omitted. The print is still deletable.
- **`is_self` race / double-set:** `setSelfContact` runs in a transaction that first clears all `is_self=1` then sets one — already a singleton. Setting self on an already-self contact is a no-op. Clearing self when none is set is a no-op.
- **Privacy toggle flips off mid-session:** future captures no-op (server-gated); existing prints are untouched (the user must explicitly clear them — toggling capture off is not the same as deleting). The Settings copy says so.
- **Clear-all with zero prints:** returns `{deleted:0}`, toast "No voiceprints to remove."
- **Disable then delete:** delete works on a disabled print (hard delete ignores `disabled_at`).
- **Un-bank when no print exists** (assignment was below the clean-speech gate, so nothing was banked): `voiceprints:findBySource` returns an **empty list** (`[]`); the SpeakersPanel skips the "remove voiceprint?" prompt.
- **Reassign auto-purge with multiple stranded prints:** if label A was assigned to X twice (banked two prints), then reassigned to Y, the synchronous `deleteVoiceprintsBySource(rec, A, X)` removes **both** of X's prints (the helper deletes all matching rows, not one) and returns `purgedCount=2`; Y's freshly-banked print (different `contact_id`) is never touched because the purge is contact-scoped to X and runs *before* the `setImmediate` capture for Y.
- **Reassign to the same contact (re-confirm):** `priorContactId === contactId`, so the purge condition is false — nothing is deleted; the re-bank simply adds a corroborating print (raising the §3.1 "remembered from N recordings" signal). No stale-print risk.
- **Reassign where the prior label had no contact** (`priorContactId === null` — was Unassigned): purge condition is false (first real assignment); nothing to purge.
- **`findBySource` ambiguity (resolved):** because the table has no `(source_recording_id, source_label)` uniqueness and a reassign leaves rows for multiple contacts under one provenance, a single-row lookup could delete the wrong contact's print. The list-valued + contact-scoped contract (§3.6) makes "the print(s) this assignment produced" unambiguous: scope by `contactId`, act on all matching ids.
- **BLOB never crosses IPC:** `VoiceprintSummary` omits `embedding`; the handler must project explicitly (don't spread the raw `Voiceprint`).
- **Migration safety:** the v27 provenance columns already exist (Phase 1). `insertVoiceprint`'s new INSERT references them; a DB that somehow lacks them would throw — but Phase 1's migration is a hard prerequisite (`SCHEMA_VERSION === 27`), so no defensive column-existence check is added.
- **Contact-delete cascade idempotency:** wrapped in a transaction; deleting a contact with no prints/assignments deletes 0 extra rows harmlessly.

---

## 8. Testing strategy

All tests are Vitest, main-process tests run `@vitest-environment node`. **No real USB/hardware. Mock sherpa (`Module._load` / `sherpa-onnx-node`), `electron` (`ipcMain`/`utilityProcess`/`webContents`/`app`/`safeStorage`), and `child_process`.** Renderer component tests use the jsdom env + a stubbed `window.electronAPI`.

**Unit-testable (mocked):**

- **`voiceprint-service.ts` provenance + gate** (`voiceprint-service.test.ts`, extend): assert a successful capture calls `insertVoiceprint` with `source_recording_id`, `source_label`, `clean_speech_ms`, `created_from='manual'`; assert privacy-off and <10 s short-circuit before embedding with the right `reason`; assert `CaptureResult.cleanSpeechMs` is populated. Mock `embedSamples` → `Float32Array(256)`, mock DB getters + `insertVoiceprint`.
- **`voiceprints-handlers.ts`** (new test): mock `electron` ipcMain (capture handlers into a Map, the existing idiom in `speakers-assign-voiceprint.test.ts`) and `../../services/database`. Assert: `listForContact` projects to `VoiceprintSummary` with **no `embedding` field**; title resolved from a mocked `getRecordingById`; `disable`/`enable`/`delete`/`clearAll*` call the right DB fns and return `Result`; validation errors for bad input; BLOB never present in the response.
- **`contacts:setSelf` + `contacts:getSelf`** (extend `contacts-handlers.test.ts`): mock `setSelfContact`/`clearSelfContact`/`getSelfContactId`/`getContactById`; assert `setSelf` calls `setSelfContact` and the returned `Person` carries `isSelf:true`; `contactId:null` calls `clearSelfContact` and returns `success(null)`; `getSelf` returns the mapped prior-self `Person` when `getSelfContactId` resolves and `success(null)` when it returns null; `mapToPerson` maps `is_self===1 → isSelf:true`.
- **`speakers:unassign` + reassign auto-purge + capture feedback event** (extend `speakers-assign-voiceprint.test.ts` / `speakers-handlers.test.ts`): mock `deleteRecordingSpeaker`/`getRecordingSpeaker`/`deleteVoiceprintsBySource`; assert `unassign` reads the prior contact then deletes the row.
  - **Reassign-X-to-Y leaves no stale X print (the AC12 dominant-path test):** seed `getRecordingSpeaker(rec,'A')` to return a row with `contact_id='X'`; call `speakers:assign(rec,'A','Y')`; assert the handler calls `deleteVoiceprintsBySource(rec,'A','X')` **synchronously before** the `setImmediate` capture, and does **not** purge `'Y'`. Re-assigning the **same** contact (`assign(rec,'A','X')` when prior is `'X'`) asserts `deleteVoiceprintsBySource` is **not** called. First assignment (prior `contact_id=null`) asserts no purge. Assert the `voiceprint:captured` payload carries `purgedPriorContactId:'X'` and `purgedCount`.
  - For the event: inject a fake window via `setMainWindowForSpeakers({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any)` (mock the **module-scoped window**, not `getAllWebContents` — which doesn't exist in this codebase), await the `setImmediate` tick (`await new Promise(setImmediate)`), assert `mainWindow.webContents.send` was called with `'voiceprint:captured'` and the capture result; assert that a `send` that throws (and an `isDestroyed()===true` window) doesn't reject the assign IPC.
- **`database.ts` helpers** (extend `database-v27.test.ts`): `insertVoiceprint` round-trips provenance; `enableVoiceprint` clears `disabled_at`; `deleteVoiceprintsByContactId`/`deleteAllVoiceprints` return counts and remove rows; `getRecordingSpeaker` returns the single matching row or `undefined`; **`getVoiceprintsBySource` is list-valued** — insert two prints for contact X and one for contact Y all under `(rec,'A')`, assert the 3-arg `getVoiceprintsBySource(rec,'A','X')` returns **both** X prints (newest first) and none of Y's, and the 2-arg form returns all 3; **`deleteVoiceprintsBySource(rec,'A','X')`** deletes exactly X's two prints (returns 2) and leaves Y's; `clearSelfContact` zeroes `is_self`; **`deleteContact` cascade** removes the contact's `voiceprints` and `recording_speakers` rows in one transaction.
- **Renderer components** (Vitest + jsdom + Testing Library, matching existing component tests): SpeakersPanel shows "Voice remembered"/skip-reason on a mocked `onVoiceprintCaptured`; shows the "removed N stale voiceprint(s)" note when the event carries `purgedCount`; hides the remembered affordance when `enableVoiceprintCapture` is false and shows the off-hint. SpeakersPanel "Clear assignment" calls `voiceprints.findBySource(rec, label, priorContactId)` **with the correct contact-scoped `priorContactId`** — render the panel with `assignedSpeakers={{ A: { contactId: 'X', contactName: 'Alice' } }}` (the §3.13 prop) and assert the Clear-assignment call passes exactly `('rec', 'A', 'X')`, proving the panel reads `contactId` from `assignedSpeakers` rather than the old names-only `assignedNames` (which carried no id); when the mock returns a **2-element list**, asserts the prompt offers "remove 2" and that confirming calls `voiceprints.delete` for **both** ids; when the mock returns `[]`, asserts no prompt. **SourceReader (§3.13):** assert `refreshSpeakers` does NOT collapse `speakers:getForRecording` — mock the IPC to return `{ A: { contactId: 'X', contactName: 'Alice' } }` and assert SpeakersPanel receives `assignedSpeakers` carrying `contactId:'X'` (not just the name), while TranscriptViewer still receives a names-only `speakerNames` map. PersonDetail "Voices" tab renders rows from a mocked `voiceprints.listForContact`, fires disable/delete/clear-all; the "Mark as me" button calls `contacts.getSelf` first and, when it resolves a *different* prior self, shows the named "{X} is currently marked as you — move it to {Y}?" confirm before calling `contacts.setSelf` (no confirm when `getSelf` returns `null` or the same id). Settings Privacy card toggles call `updateConfig('privacy', …)` and "Clear all" calls `voiceprints.clearAll`.

**Explicitly NOT unit-tested here (B / live):** matcher consistency check (stub returns true), suggestion generation, real embedding distances, real backup/sync exclusion (no consumer).

**Quality gate (per task):** `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`.

---

## 9. Acceptance criteria (mapped to rev-2 §18)

- **AC5 (banking discipline — non-matcher part):** confirming banks a print **only** when clean-speech ≥ 10 s and the privacy toggle is on; provenance (`created_from`, `source_*`, `clean_speech_ms`) is recorded; the consistency-with-existing-prints clause is left as a typed hook for B. *Verified by `voiceprint-service.test.ts` provenance + gate tests.*
- **AC6 (self suggested, not auto-applied; "mark me" once):** `contacts:setSelf` records `is_self` and `contacts:getSelf` reads the current self (driving the named move-confirm); `Person.isSelf` surfaces in PersonDetail as "You"; **no auto-application** happens in Phase 2 (no matcher). *Verified by contacts-handlers (`setSelf`+`getSelf`) + PersonDetail tests.*
- **AC12 (undo & delete; un-bank the specific print; `deleteVoiceprint` reachable):** three correction paths are leak-free. (1) **Reassign-to-a-different-contact — the dominant path:** `speakers:assign` reads the prior `contact_id` before the in-place `upsertRecordingSpeaker` overwrite and, when it changed, synchronously `deleteVoiceprintsBySource(rec, label, priorContactId)` purges the prior contact's stranded print(s) *before* the new contact's capture fires (§3.6) — no stale wrong-attribution biometric survives. (2) **Unassign:** `speakers:unassign` reverses an assignment; the inline SpeakersPanel affordance resolves the banked print(s) via the **list-valued, contact-scoped** `voiceprints:findBySource` and deletes **all** of them. This requires the panel to know the label's `contactId`, which §3.13 supplies via the new `assignedSpeakers` prop (SourceReader stops collapsing `speakers:getForRecording` to names-only) — without that widening this path is unimplementable. (3) **Wrong print itself:** the Voices tab deletes any print directly. The cardinality contract (`(source_recording_id, source_label)` is many-rows; resolve by `(…, contact_id)`, act on the full list) makes "the specific print(s) it produced" unambiguous. `voiceprints:delete` is reachable from both surfaces. *Verified by the reassign-X-to-Y-leaves-no-stale-X-print test (speakers-handlers), the list-valued `getVoiceprintsBySource`/`deleteVoiceprintsBySource` tests (database-v27), and the SpeakersPanel list-un-bank test.*
- **AC13 (per-contact delete + disable-recognition toggle + exclude-from-backup default):** per-print disable/enable + per-contact "Forget this voice" + global "Clear all"; Settings Privacy `enableVoiceprintCapture` (the recognition/capture master gate) and `excludeVoiceprintsFromBackup` default `true`; contact-delete cascades voiceprints. Backup-exclusion consumer scoped as "honored when backup/sync ships." *Verified by Settings + voiceprints-handlers + `deleteContact` cascade tests.*

---

## 10. Explicit non-goals / deferred to sibling sub-project B (or later)

- **Matcher, identity/merge/mixed suggestion generation, `speaker_suggestions` UI, auto-apply** — sub-project B. Phase 2 reads/writes no suggestions.
- **The "consistent with existing prints" banking clause** (AC5 third condition) — needs embedding comparison → B's matcher. Phase 2 ships the typed hook returning `true`.
- **Self auto-apply, similar-voice handling (AC10), conservative static `speaker_options` floor, Solo handling, re-transcribe backstop (AC11), recording-type inference** — later phases (rev-2 §13/§19 steps 5–7).
- **A real backup/sync exporter that honors `excludeVoiceprintsFromBackup`** — no backup feature exists yet; Phase 2 ships the flag + the documented contract only.
- **Encryption-at-rest of the embedding BLOB** (rev-2 §14) — **DEFERRED (FINAL decision, documented as a follow-up).** The Phase-2 privacy posture for voiceprints is: **local-only + renderer-isolated (no BLOB ever crosses IPC — `VoiceprintSummary` omits `embedding`) + excluded-from-backup (`excludeVoiceprintsFromBackup` defaults `true`).** At-rest encryption of the BLOB is explicitly out of Phase-2 scope and tracked as a follow-up; the app's `safeStorage` story currently covers config secrets, not DB BLOBs, and the three controls above are the ratified Phase-2 posture. Not an open question — confirmed deferred.
- **A `People.tsx` "You" badge** and a dedicated unset-self affordance beyond `setSelf(null)` — minor polish, deferred.
