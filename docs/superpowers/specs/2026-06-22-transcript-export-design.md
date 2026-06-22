# Transcript Export (CSV / SRT / JSON) — Design

**Date:** 2026-06-22
**App:** `apps/electron` (universal knowledge hub)
**Status:** proposed / approved for planning

## 1. Request in one sentence

Let a user export the transcript of a single recording from the Library reader to **CSV**, **SRT**, or **JSON**, choosing a save location via the native file dialog.

## 2. Scope

**In scope (v1):**
- Single-recording export, triggered from the reader (`SourceReader`).
- Three formats: CSV, SRT, JSON.
- Native Save dialog; one file per export.
- Adaptive format availability based on whether the recording is diarized.

**Out of scope (v1, may fast-follow):**
- Bulk / multi-select export.
- Plain `.txt` export (non-diarized recordings export JSON only).
- VTT/WebVTT.
- Subtitle-length chunking via word-level timestamps (one SRT cue per turn is acceptable for v1).
- Re-export pipelines, scheduled exports, or export from any surface other than the reader.

## 3. Current-state anchors

- A transcript lives in the `transcripts` table, keyed by `recording_id` (one per recording). Relevant columns: `full_text` (always present), `language`, `summary`, `action_items`, `topics`, `key_points`, `sentiment`, `speakers`, `turns`, `diarization_run_id`, `transcription_provider`, `transcription_model`, `title_suggestion`, `created_at`. `action_items`/`topics`/`key_points`/`question_suggestions`/`speakers`/`turns` are stored as JSON **strings**.
- `turns` is a JSON-serialized `Turn[]` and is **only populated for diarized recordings**; it is `NULL` for non-diarized (e.g. Gemini/Whisper) transcripts.
- `Turn` shape (canonical: `electron/main/services/asr/asr-provider.ts`):
  ```ts
  interface Turn {
    speaker: string      // file label, e.g. "Speaker_0"
    startMs: number      // milliseconds
    endMs: number        // milliseconds
    text: string
    words?: Array<{ text: string; startMs: number; endMs: number }>
    sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
  }
  ```
- Speaker display names: the `recording_speakers` roster maps a recording's file label → contact. Exposed to the renderer via `window.electronAPI.speakers.getForRecording(recordingId)` → `Record<string, { contactId: string; contactName: string }>`. Main reads the same roster directly from the DB.
- Recording metadata (`recordings` table): `filename`, `original_filename`, `duration_seconds`, `date_recorded`.
- Established file-save pattern (`electron/main/ipc/outputs-handlers.ts`): `dialog.showSaveDialog(win, { defaultPath, filters })` → `writeFileSync(path, content, 'utf-8')` → `Result<string>` (saved path); cancellation returns a `VALIDATION_ERROR`.
- IPC convention: `ipcMain.handle(channel, …): Promise<Result<T>>` with `success(data)` / `error(code, message, details?)`; preload groups methods under a `window.electronAPI.<namespace>` object.
- There is **no** existing transcript-export code; this is net-new. The Outputs handler is the reference pattern.

## 4. Architecture

Pure formatters in the main process + one IPC handler + a thin reader control.

```
SourceReader (renderer)
  └─ Export dropdown → window.electronAPI.transcripts.export(recordingId, format)
        └─ IPC: transcripts:export
              ├─ load transcript + recording + speaker roster (DB)
              ├─ build normalized ExportData
              ├─ re-check diarization (server-side backstop)
              ├─ formatter: toCsv | toSrt | toJson  (pure)
              ├─ derive sanitized default filename
              ├─ dialog.showSaveDialog → writeFile
              └─ Result<string> (saved path) | error
```

**Why this split:** formatters are pure functions of `ExportData`, so they unit-test without Electron/React or a DB; main owns DB access + file I/O (consistent with Outputs); the renderer stays thin; a future bulk export reuses the formatters unchanged.

## 5. Components

### 5.1 `electron/main/services/transcript-export.ts` (pure, no Electron/DB imports)

Normalized input the handler assembles and the formatters consume:

```ts
interface ExportData {
  recording: {
    id: string
    title: string          // title_suggestion ?? original_filename ?? filename
    dateRecorded: string    // ISO from date_recorded
    durationMs: number | null   // duration_seconds * 1000, or null
    language: string
    transcriptionProvider: string | null
    transcriptionModel: string | null
  }
  fullText: string
  turns: Turn[] | null      // null when not diarized
  analysis: {
    summary: string | null
    actionItems: string[]
    topics: string[]
    keyPoints: string[]
    titleSuggestion: string | null
    sentiment: string | null
  }
  speakers: Record<string, string>   // label -> display name (mapped contact name, else label)
}
```

Exports:
- `toCsv(data: ExportData): string`
- `toSrt(data: ExportData): string`
- `toJson(data: ExportData): string`
- helpers (not necessarily exported): `msToClock(ms: number, sep: ',' | '.'): string` → `HH:MM:SS<sep>mmm`; `csvEscape(field: string): string` (RFC-4180); `resolveSpeaker(label: string, speakers: Record<string,string>): string`.

`toCsv` / `toSrt` require `data.turns` to be a non-empty array; the handler guarantees that before calling them (they may assert).

### 5.2 `transcripts:export` IPC handler

Add to the transcripts handler module (or a new `transcripts-export-handlers.ts` registered alongside).

- **Input:** `{ recordingId: string; format: 'csv' | 'srt' | 'json' }`.
- **Steps:**
  1. Load the transcript by `recordingId`; if none → `error('NOT_FOUND', 'No transcript to export')`.
  2. Parse `turns` (JSON) → `Turn[] | null`. `isDiarized = Array.isArray(turns) && turns.length > 0`.
  3. If `format` is `csv` or `srt` and not `isDiarized` → `error('NOT_DIARIZED', 'CSV and SRT export require diarization. Re-transcribe with diarization to enable.')` (backstop; the UI disables these).
  4. Load recording metadata + speaker roster; build `ExportData` (parse `action_items`/`topics`/`key_points` JSON strings defensively → `[]` on parse failure; map speaker labels via roster, falling back to the label).
  5. Call the matching formatter → `content`.
  6. Compute a **sanitized** default filename: `sanitizeBasename(title)` + `.` + ext (`csv`/`srt`/`json`). `sanitizeBasename` strips path separators and characters illegal on Windows (`<>:"/\|?*`, control chars), collapses whitespace, trims, and falls back to `transcript` if empty.
  7. `dialog.showSaveDialog(win, { defaultPath, filters: [<format>, All Files] })`.
  8. If `canceled || !filePath` → return `success(null)` (the renderer treats `data === null` as a silent no-op; see §7).
  9. `writeFile(filePath, content, 'utf-8')` (CSV content already includes a UTF-8 BOM, see §6.1). On write failure → `error('INTERNAL_ERROR', <message>)`.
  10. Return `success(filePath)`.

The handler's success type is therefore `Result<string | null>`: a saved path on success, `null` on cancellation.

### 5.3 Preload

Add to the existing `transcripts` namespace:
```ts
transcripts: {
  // …existing…
  export: (recordingId: string, format: 'csv' | 'srt' | 'json') => Promise<Result<string | null>>
}
```
Implementation: `export: (recordingId, format) => callIPC('transcripts:export', { recordingId, format })`. (`data` is the saved path, or `null` if the user cancelled the save dialog.)

### 5.4 Reader UI (`SourceReader.tsx`)

- An **Export** control in the existing action-button area, gated by `hasTranscript`.
- Use the same `Select` dropdown pattern already used for "Re-summarize with…" (trigger `className="h-8 w-auto gap-1 text-sm"`, a `Download`/`FileDown` lucide icon). Trigger label: "Export…".
- Items:
  - **JSON** — always enabled.
  - **CSV** — enabled only when the open transcript is diarized; otherwise rendered disabled with hint text "Requires diarization".
  - **SRT** — same gating as CSV.
- Diarization state is derived from the already-parsed `turns` the reader loads (`parsedTurns.length > 0`).
- On selection: call `window.electronAPI.transcripts.export(recordingId, format)`.
  - Success → inline confirmation "Saved to `<path>`" (reuse the reader's existing inline status/feedback affordance).
  - Cancellation → silent no-op.
  - Error → inline error message.
- The dropdown resets to its placeholder after each action (it triggers an action, it is not a persistent selection).

## 6. Format details

### 6.1 CSV (diarized only)

- One row per turn, header row first.
- Columns: `speaker, start, end, text` — plus a trailing `sentiment` column **iff** any turn has a `sentiment` value (otherwise the column is omitted entirely).
- `start`/`end` formatted `HH:MM:SS.mmm` (via `msToClock(ms, '.')`).
- `speaker` = resolved display name.
- RFC-4180 quoting: a field is wrapped in double quotes when it contains `"`, `,`, `\n`, or `\r`; embedded `"` is doubled. Line terminator `\r\n`.
- File begins with a UTF-8 BOM (`﻿`) so Excel detects encoding.

### 6.2 SRT (diarized only)

- One cue per turn, numbered from 1.
- Cue:
  ```
  <n>
  HH:MM:SS,mmm --> HH:MM:SS,mmm
  <speaker>: <text>
  <blank line>
  ```
- Timestamps via `msToClock(ms, ',')`.
- Caption text is the turn text prefixed with `"<resolved speaker>: "`. Internal newlines in turn text are preserved as caption line breaks.

### 6.3 JSON (always available — complete record)

Pretty-printed (2-space). Shape:
```jsonc
{
  "version": 1,
  "recording": {
    "id": "...",
    "title": "...",
    "dateRecorded": "...",
    "durationMs": 123000,
    "language": "en",
    "transcriptionProvider": "...",
    "transcriptionModel": "..."
  },
  "transcript": {
    "language": "en",
    "fullText": "...",
    "turns": [ /* Turn[] as stored, or null when not diarized */ ]
  },
  "analysis": {
    "summary": "...",
    "actionItems": ["..."],
    "topics": ["..."],
    "keyPoints": ["..."],
    "titleSuggestion": "...",
    "sentiment": "..."
  },
  "speakers": { "Speaker_0": "Alice Johnson", "Speaker_1": "Speaker_1" }
}
```
- `turns` is the parsed array for diarized recordings, `null` otherwise.
- `analysis` array fields are the parsed stored JSON; a null/invalid stored value becomes `[]` (arrays) or `null` (scalars).

## 7. Error handling

| Condition | Behavior |
|---|---|
| No transcript for the recording | `error('NOT_FOUND', 'No transcript to export')`; reader shows the message. |
| CSV/SRT requested for non-diarized | `error('NOT_DIARIZED', …)` — backstop only; the menu already disables these. |
| Save dialog cancelled | Not an error. The handler returns `success(null)`; the reader treats `data === null` as a no-op. No toast/inline error. |
| Disk/permission write failure | `error('INTERNAL_ERROR', <message>)`; reader shows the message. |
| Malformed stored JSON (`turns`/analysis) | Parsed defensively: `turns` parse failure → treated as non-diarized; analysis array parse failure → `[]`. Never throws out of the handler. |

## 8. Testing

**Pure formatter unit tests** (`transcript-export.test.ts`) — golden outputs from fixed `ExportData`:
- `toCsv`: header with/without `sentiment` column; quoting of text containing comma, double-quote, `\n`; `\r\n` terminators; BOM prefix; speaker name resolution (mapped vs fallback).
- `toSrt`: sequential numbering; `HH:MM:SS,mmm` formatting at boundaries (0 ms, sub-second rounding, > 1 hour); `Speaker: text` prefix; blank-line separation.
- `toJson`: shape + `version`; diarized (turns array) vs non-diarized (`turns: null`); analysis fields surfaced from parsed JSON; `speakers` map.
- `msToClock`: 0, 999, 1000, 59_999, 3_600_000, rounding of fractional ms; both separators.
- `csvEscape`: each special-character case.

**Handler tests** (dialog + fs mocked):
- No transcript → `NOT_FOUND`, no write.
- CSV/SRT on non-diarized → `NOT_DIARIZED`, no write.
- Cancelled dialog → no write, cancellation result (no error).
- Success → `writeFile` called with the formatter's exact content and the chosen path; returns the path.
- Malformed `turns` JSON → does not throw; CSV/SRT gated as non-diarized, JSON still exports with `turns: null`.

**Reader test:**
- Menu adaptivity: CSV/SRT disabled when `parsedTurns` is empty, enabled when present; JSON always enabled.
- Selecting a format calls `transcripts.export` with the right `recordingId` + `format`; cancellation produces no error UI; success shows the saved-path confirmation.

## 9. Acceptance criteria

1. From the reader of a recording **with** a transcript, the user can export JSON; the saved file matches the §6.3 schema.
2. From the reader of a **diarized** recording, the user can additionally export CSV and SRT; CSV matches §6.1 (RFC-4180, BOM, `HH:MM:SS.mmm`, optional sentiment column) and SRT matches §6.2 (numbered cues, `HH:MM:SS,mmm`, `Speaker: text`).
3. For a **non-diarized** recording, CSV and SRT are visibly disabled with a "requires diarization" hint; JSON still works.
4. Speaker names in all formats use the mapped contact name when available, else the raw label.
5. Cancelling the save dialog leaves no file and shows no error.
6. A recording with no transcript shows a clear "no transcript to export" message and writes nothing.
7. The default filename is derived from the recording title and is safe on Windows (no illegal characters/path separators).
8. All formatter, handler, and reader tests pass; `npm run typecheck` (node+web) + lint clean.
