# Reassign in the By-Speaker View (remove Turns pane) — Design

**Date:** 2026-06-23
**App:** `apps/electron` (universal knowledge hub)
**Status:** proposed / approved for planning

## 1. Request in one sentence

Remove the SpeakersPanel "Turns" pane and put turn reassignment on each turn row of the By-Speaker transcript cards, with three scope options (**Reassign** / **Reassign All Before** / **Reassign All After**) and an Assign-style target picker; reassigning re-runs voiceprint matching via the existing invalidation path.

## 2. Scope

**In scope:**
- Delete the SpeakersPanel "Turns" collapsible pane + its per-turn reassign.
- Add a per-turn "Reassign ▾" control to each turn row in the `TranscriptViewer` By-Speaker cards.
- Three scope options; an Assign-style target picker (existing speaker / contact / new unnamed speaker = next letter).
- One atomic main-process operation that rewrites the scoped turns, mints/maps the target letter, cleans up an emptied source label, and invalidates embeddings so the matcher re-runs.

**Out of scope:**
- The SpeakersPanel roster (assign label→contact, merge, "this is me", suggestion chips) stays as-is.
- No new voiceprint/banking behavior beyond what assigning a contact already does, and no new "unsure" surfacing (user chose: just preserve the existing auto re-match).
- The chronological Timeline view's rows are unchanged (reassign lives in the By-Speaker cards only).
- No markdown/rich rendering changes.

## 3. Current-state anchors

- **`SpeakersPanel.tsx`** (`apps/electron/src/features/library/components/SpeakersPanel.tsx`): the **Turns pane** is a collapsible section (state `turnsExpanded` ~:134; markup ~:837–903) listing every turn with a per-turn reassign dropdown (`openReassignTurn` ~:132; `reassignTurn(turnIndex, toLabel)` ~:382–400). The **roster** (~:546–833) has the **Assign popover** (~:617–694: current-assignment card, search input, contact pick list = attendees + all contacts, "Create contact" quick-add, clear) and the **merge** dropdown (~:709–726). Props: `{ recordingId, meetingId, turns, assignedNames, assignedSpeakers, suggestions, onJumpToTime, onChanged }`.
- **`reassignTurn`** maps the full turns array changing one turn's `speaker`, then calls `electronAPI.transcripts.updateTurns({ recordingId, turns })`.
- **IPC `transcripts:updateTurns`** (`electron/main/ipc/speakers-handlers.ts` ~:390–415): `updateTranscriptTurns(recordingId, turns)` + `deleteLabelEmbeddingsForRecording` + `deleteWindowEmbeddingsForRecording` + `clearSuggestionsInFlight`. **IPC `speakers:merge`** (~:270–324) additionally `expireSuggestionsForRecording`, carries the `fromLabel` contact mapping to `toLabel` when `toLabel` has none, and `deleteRecordingSpeaker(recordingId, fromLabel)` for the orphan — this is the template for the reassign handler's mapping + cleanup + invalidation.
- **DB** (`electron/main/services/database.ts`): `updateTranscriptTurns(recordingId, turns)` (~:2959), `getRecordingSpeakers(recordingId)`, `upsertRecordingSpeaker({recording_id,file_label,contact_id,source})`, `deleteRecordingSpeaker(recordingId, label)` (~:2915–2994). Raw diarization labels are **single uppercase letters** (A, B, C…), not necessarily contiguous or starting at A (e.g. one recording uses B–F).
- **`TranscriptViewer.tsx`**: By-Speaker cards render `speakerGroups.groups.map(...)` (~:376–439 region); each card has a header + that speaker's turn list (each row: `TimeAnchor` timestamp + turn text). Per-speaker collapse was added earlier (reader-qol). The component is **read-only today**; it receives `turns` + `speakerNames` (label→display name) as props. The By-Speaker toggle in tests is a `role="tab"`.
- **`SourceReader.tsx`**: owns `recordingId`, the parsed `turns`, `speakerNames`, `speakerAssignments` (label→{contactId,contactName}), `suggestions`, and the contacts/IPC; passes `turns`/`speakerNames` to `TranscriptViewer`; `refreshSpeakers()` re-fetches transcript + speakers + `getSuggestions` (the re-match). `onChanged` from SpeakersPanel calls `refreshSpeakers()`.
- **Voiceprint matcher**: `speakers:getSuggestions` → `embedRecordingLabels` (re-embeds labels from audio) → `runMatcher` (identity `decision: strong|suggest|none`, merge, mixed). Deleting the label/window embeddings + clearing in-flight forces a full re-embed + re-match on the next `getSuggestions`. There is no explicit "unsure" flag.

## 4. Design

### 4.1 Remove the Turns pane
Delete the `turnsExpanded` state, the Turns collapsible section (~:837–903), the per-turn reassign UI, `openReassignTurn`, and `reassignTurn` from `SpeakersPanel.tsx`. The roster (assign/merge/suggestions/"this is me") is untouched. Update the SpeakersPanel tests to drop Turns-pane assertions.

### 4.2 Reassign control in the By-Speaker cards (`TranscriptViewer.tsx`)
Each turn row in a By-Speaker card gains a **"Reassign ▾"** control (a small menu, only shown when a reassign handler is provided — keeps the Timeline view and any read-only usage unaffected). Its three items are **scope** choices:
- **Reassign** — this turn only.
- **Reassign All Before** — this turn **and all earlier turns of the same speaker**.
- **Reassign All After** — this turn **and all later turns of the same speaker**.

Scope is over the **source speaker's** turns only, in global timeline order; the **anchor turn is included** in both bulk options.

Selecting a scope opens the **target picker** (§4.3). The control passes to the handler: the source label, the anchor turn's index in the full ordered turns array, the anchor's `startMs` (a staleness guard), and the chosen scope + target.

### 4.3 Target picker — `<SpeakerTargetPicker>` (new shared component)
Extract an Assign-style picker reused by the reassign control (and available for the roster's Assign later). It lists, in order:
1. **Existing speakers in this recording** — each shown by assigned name (e.g. "Dr. Anne Beavan") or "Speaker X" if unassigned; excludes the source speaker. Picking one targets that letter.
2. **A contact search** — type to filter existing contacts (attendees first, then all); pick one to target that contact. A **"Create contact "<name>""** quick-add creates a new contact (existing contacts-create path) and targets it.
3. **"New speaker"** — creates the next unused letter with no contact.

Contact → letter resolution (done in the handler, §4.4): a contact already mapped to a letter in this recording → that letter; otherwise mint the next letter and map it.

### 4.4 New IPC `speakers:reassignTurns` (atomic; mirrors merge)
Request:
```ts
{
  recordingId: string
  sourceLabel: string          // the speaker whose turns move
  anchorIndex: number          // selected turn's index in the full ordered turns array
  anchorStartMs: number        // staleness guard
  scope: 'one' | 'before' | 'after'
  target:
    | { kind: 'existingLabel'; label: string }
    | { kind: 'contact'; contactId: string }   // existing OR just-created contact
    | { kind: 'newSpeaker' }                    // mint next letter, no contact
}
```
Handler steps:
1. Load turns; **guard**: if `turns[anchorIndex]?.startMs !== anchorStartMs || turns[anchorIndex]?.speaker !== sourceLabel` → `error('VALIDATION_ERROR', 'stale turns; refresh and retry')` (no write).
2. Select the turns to rewrite: those with `speaker === sourceLabel` and, by index `i`, `scope==='one' ? i===anchorIndex : scope==='before' ? i<=anchorIndex : i>=anchorIndex`.
3. Resolve the **target letter**:
   - `existingLabel` → that label.
   - `contact` → if `getRecordingSpeakers` has a row for `contactId` → its `file_label`; else mint the next letter (§4.6) and create the mapping **via the same code path `speakers:assign` uses** (the upsert AND its scheduled voiceprint capture) — NOT a bare `upsertRecordingSpeaker` — so contact-assignment behavior stays identical to assigning from the roster. (This capture is existing Assign behavior, not new voiceprint work.)
   - `newSpeaker` → mint the next letter (§4.6); no mapping.
4. Rewrite the selected turns' `speaker` to the target letter; `updateTranscriptTurns(recordingId, rewritten)`.
5. If `sourceLabel` now has zero turns → `deleteRecordingSpeaker(recordingId, sourceLabel)` (orphan cleanup, mirrors merge).
6. Invalidate so the matcher re-runs: `deleteLabelEmbeddingsForRecording` + `deleteWindowEmbeddingsForRecording` + `clearSuggestionsInFlight` + `expireSuggestionsForRecording` (same set merge uses).
7. `return success({ recordingId, targetLabel, rewrittenCount })`.

The renderer creates a brand-new contact (when the picker's quick-add is used) via the existing contacts-create path first, then calls `reassignTurns` with `{ kind:'contact', contactId }`. After success, `onChanged()` → `refreshSpeakers()` → `getSuggestions` re-embeds + re-runs the matcher.

### 4.5 Prop threading (`SourceReader.tsx`)
`SourceReader` passes `TranscriptViewer` what the reassign control needs: `recordingId`, the speaker list with display names (it already has `speakerNames`/`speakerAssignments`), the contacts data for the picker, and an `onReassign`/`onChanged` callback that invokes `speakers:reassignTurns` then `refreshSpeakers()`. The reassign control is gated on these being present (absent in any read-only context).

### 4.6 Next-unused-letter
Among the union of (current turn labels) ∪ (`recording_speakers.file_label` for the recording), take the **highest** letter A–Z and return the **next** one (e.g. A–F present → G). If none used → 'A'. If 'Z' is in use (≥26 speakers) → "New speaker" is disabled with a brief note. Letters are single uppercase A–Z.

## 5. Behavior details

- **Source-speaker-scoped**: bulk reassign only moves the source speaker's turns in the range — never other speakers' turns that fall in the same time window.
- **Anchor inclusive**: "All Before" = anchor + earlier same-speaker turns; "All After" = anchor + later same-speaker turns.
- **Reassign to an existing speaker/contact** = move those turns into that letter's group (the diarization-fix sense).
- **Reassign to a new contact / new speaker** = split those turns into a fresh letter (+ contact mapping if a contact was chosen).
- The picker excludes the source speaker from the "existing speakers" list (can't reassign to self).

## 6. Re-voiceprinting

No new voiceprint code. The reassign handler performs the same embedding invalidation as `transcripts:updateTurns`/`merge`; `onChanged()` → `refreshSpeakers()` → `getSuggestions` re-embeds the labels and re-runs the matcher, so identity/merge/mixed suggestions refresh automatically after every reassign (user-selected option 1).

## 7. Error handling / edge cases

- **Stale turns** (anchor guard fails): reject with `VALIDATION_ERROR`; the UI surfaces "refresh and retry" (the list re-renders from fresh turns).
- **Emptied source label**: orphan `recording_speakers` row deleted; its card disappears on refresh.
- **All 26 letters used**: "New speaker" disabled with a note; existing-speaker/contact reassign still works.
- **Reassign-all to a contact already present**: turns simply merge into that contact's existing letter (no new letter minted).
- **Index shift**: indices are only used within a single call (guarded by `anchorStartMs`); after the write the view re-derives from refreshed turns — no cached indices across calls.
- **No transcript / no turns**: the By-Speaker view and the control don't render (existing `hasStructuredTurns`/`canGroupBySpeaker` guards).

## 8. Testing

- **SpeakersPanel**: Turns pane removed — its collapse test updated; the roster (assign/merge/suggestions) still renders.
- **TranscriptViewer**: a By-Speaker turn row shows "Reassign ▾" with the 3 options (only when a reassign handler is provided); picking each scope opens the target picker; the picker lists existing speakers (excluding source, by name or "Speaker X") + contact search + "New speaker".
- **`speakers:reassignTurns` handler** (DB-mocked or real sql.js): `scope:'one'` rewrites exactly the anchor turn; `before`/`after` rewrite the source speaker's turns at/earlier and at/later by index (anchor inclusive) and leave other speakers' in-range turns untouched; `existingLabel` target moves to that letter; `contact` target reuses an existing mapped letter or mints + maps the next letter; `newSpeaker` mints the next letter unmapped; emptied source label's `recording_speakers` row deleted; the embedding-invalidation set (`deleteLabelEmbeddings`/`deleteWindowEmbeddings`/`clearSuggestionsInFlight`/`expireSuggestions`) is called; the stale-anchor guard rejects with no write.
- **Next-unused-letter**: A–F → G; gaps tolerated (uses highest+1); none → A; Z present → disabled.
- **Integration**: after a reassign, `onChanged`/`refreshSpeakers` runs → `getSuggestions` invoked (re-match).

## 9. Acceptance criteria

1. The SpeakersPanel "Turns" pane is gone; the roster (assign/merge/suggestions) is unchanged.
2. Each By-Speaker card turn row offers **Reassign / Reassign All Before / Reassign All After**.
3. "Reassign" moves one turn; "All Before"/"All After" move the **source speaker's** turns at/earlier and at/later than the anchor (anchor inclusive), leaving other speakers' turns alone.
4. The target picker works like Assign: pick an existing speaker (by name or "Speaker X"), or search/create a contact, or make a new unnamed speaker = the next unused letter; choosing a contact maps the (existing or newly-minted) letter to that contact.
5. Reassigning re-runs voiceprint matching automatically (embeddings invalidated → `getSuggestions` re-embeds + re-matches); no new voiceprint behavior.
6. Reassigning all of a speaker's turns away removes that speaker (orphan mapping cleaned up).
7. A stale reassign (turns changed underneath) is rejected without a partial write.
8. `npm run typecheck` (node+web) + lint clean; all tests pass.
