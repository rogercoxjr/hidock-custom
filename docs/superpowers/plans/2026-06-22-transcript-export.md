# Transcript Export Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL — `subagent-driven-development`. Each task below is sized for one fresh subagent that sees only that task plus this header. Follow strict TDD: write the failing test, run it and watch it fail, write the minimal implementation, run it green, then commit. Do not look ahead; everything a task needs (neighboring names, exact signatures) is restated in that task's Interfaces block.
>
> **Shared test fixtures:** Tasks 2–4 all extend the SAME test file `transcript-export.test.ts` and depend on two helper functions — `baseData()` and `diarized(turns)`. These are scaffolded ONCE in Task 1's test file (see Task 1) and are therefore already present for Tasks 2–4; those tasks reference them as "already present from the Task 1 scaffold" and MUST NOT re-define them.
>
> **Tasks 2–4 can be collapsed:** Tasks 2 (`toJson`), 3 (`toCsv`), and 4 (`toSrt`) are independent pure functions that touch the same two files (`transcript-export.ts` + its test). A single agent MAY write all three failing test blocks, watch them fail, implement all three, run green, and commit once — there is no consumer of the module until Task 5, so the intermediate single-formatter commits add no value. If the three are run by SEPARATE parallel agents instead, keep them as three commits (they edit the same file, so serialize the merges).

**Goal:** Let a user export the transcript of a single recording from the Library reader to CSV, SRT, or JSON via the native Save dialog.

**Architecture:** Pure formatters in the Electron main process (`transcript-export.ts`, no Electron/DB imports) consume a normalized `ExportData` object; one IPC handler (`transcripts:export`) loads the transcript + recording + speaker roster from the DB, builds `ExportData` defensively, gates CSV/SRT on diarization, runs the matching formatter, and saves via `dialog.showSaveDialog` + `writeFile`. The renderer adds a thin adaptive `Select` dropdown in `SourceReader` that calls `window.electronAPI.transcripts.export`.

**Tech Stack:** Electron 39 main process (Node.js), React 18 + TypeScript + Tailwind + Radix UI (renderer), sql.js (SQLite), Vitest. Repo cwd is `C:/Users/rcox/hidock-tools/hidock-next`; the app lives in `apps/electron`.

## Global Constraints

- 120-column TypeScript everywhere (Python line-length rules do not apply here).
- Before declaring done, run the FULL gate from `apps/electron`: `npm run typecheck && npm run lint && npm run test:run`. `npm run typecheck` covers BOTH `typecheck:node` and `typecheck:web` (tsconfig.node includes test files) — running vitest alone is NOT sufficient.
- File saves MUST mirror the native-dialog pattern in `electron/main/ipc/outputs-handlers.ts`: `dialog.showSaveDialog(win, { defaultPath, filters })` then `writeFileSync` imported from `'fs'` (NOT `writeFile` from `fs/promises` — the handler test's fs mock provides only `writeFileSync`).
- Every IPC handler returns the `Result<T>` envelope from `electron/main/types/api.ts` via `success(data)` / `error(code, message, details?)`.
- Do NOT touch any device/USB code (no `device-service.ts`, no Jensen protocol, no `usb` package).
- CSV output is RFC-4180 (quote a field iff it contains `"`, `,`, `\n`, or `\r`; double embedded `"`; `\r\n` line terminator) and begins with a UTF-8 BOM (`﻿`).
- SRT/CSV timestamps: SRT uses `HH:MM:SS,mmm` (comma), CSV uses `HH:MM:SS.mmm` (dot), both via `msToClock(ms, sep)`.
- Speaker names resolve mapped-then-fallback: the roster display name when present, else the raw file label.
- Save-dialog cancellation is NOT an error: the handler returns `success(null)` and the renderer treats `data === null` as a silent no-op.

---

### Task 1: `transcript-export` module scaffold + pure helpers

**Files:**
- Create: `apps/electron/electron/main/services/transcript-export.ts`
- Create (test): `apps/electron/electron/main/services/__tests__/transcript-export.test.ts`

**Interfaces:**

Produces (this task defines these; later tasks import them):
```ts
// Canonical Turn is electron/main/services/asr/asr-provider.ts; import it, do not redefine.
import type { Turn } from './asr/asr-provider'

export interface ExportData {
  recording: {
    id: string
    title: string
    dateRecorded: string
    durationMs: number | null
    language: string
    transcriptionProvider: string | null
    transcriptionModel: string | null
  }
  fullText: string
  turns: Turn[] | null
  analysis: {
    summary: string | null
    actionItems: string[]
    topics: string[]
    keyPoints: string[]
    titleSuggestion: string | null
    sentiment: string | null
  }
  speakers: Record<string, string>
}

export function msToClock(ms: number, sep: ',' | '.'): string   // -> "HH:MM:SS<sep>mmm"
export function csvEscape(field: string): string                 // RFC-4180
export function resolveSpeaker(label: string, speakers: Record<string, string>): string
export function sanitizeBasename(title: string): string          // Windows-safe, fallback "transcript"
```

Consumes: the canonical `Turn` interface (`{ speaker: string; startMs: number; endMs: number; text: string; words?: Array<{text:string;startMs:number;endMs:number}>; sentiment?: 'POSITIVE'|'NEUTRAL'|'NEGATIVE' }`).

**Steps:**

- [ ] Write the failing test file `apps/electron/electron/main/services/__tests__/transcript-export.test.ts`. This scaffold also defines the two shared fixture helpers (`baseData`, `diarized`) used by the `toJson`/`toCsv`/`toSrt` tests added in Tasks 2–4 — define them ONCE here, at top file scope, so the later tasks can rely on them without redefining:
```ts
import { describe, it, expect } from 'vitest'
import {
  msToClock,
  csvEscape,
  resolveSpeaker,
  sanitizeBasename
} from '../transcript-export'
import type { ExportData } from '../transcript-export'

// ---------------------------------------------------------------------------
// Shared fixture helpers — used by the toJson, toCsv, and toSrt tests added in
// Tasks 2–4 below. Defined once here so those append-only test blocks do NOT
// redefine them. `baseData()` is a fully-populated non-diarized ExportData;
// `diarized(turns)` is the same record with a turns array spliced in.
// ---------------------------------------------------------------------------
function baseData(): ExportData {
  return {
    recording: {
      id: 'rec1',
      title: 'Weekly Sync',
      dateRecorded: '2026-06-22T10:00:00.000Z',
      durationMs: 123000,
      language: 'en',
      transcriptionProvider: 'assemblyai',
      transcriptionModel: 'best'
    },
    fullText: 'Hello world',
    turns: null,
    analysis: {
      summary: 'A short meeting.',
      actionItems: ['Ship it'],
      topics: ['release'],
      keyPoints: ['went well'],
      titleSuggestion: 'Weekly Sync',
      sentiment: 'POSITIVE'
    },
    speakers: { Speaker_0: 'Alice Johnson', Speaker_1: 'Speaker_1' }
  }
}

function diarized(turns: ExportData['turns']): ExportData {
  return { ...baseData(), turns }
}

describe('msToClock', () => {
  it('formats 0 ms', () => {
    expect(msToClock(0, ',')).toBe('00:00:00,000')
    expect(msToClock(0, '.')).toBe('00:00:00.000')
  })
  it('formats sub-second boundaries', () => {
    expect(msToClock(999, ',')).toBe('00:00:00,999')
    expect(msToClock(1000, ',')).toBe('00:00:01,000')
    expect(msToClock(59_999, ',')).toBe('00:00:59,999')
  })
  it('formats one hour exactly', () => {
    expect(msToClock(3_600_000, ',')).toBe('01:00:00,000')
  })
  it('formats a duration just over one hour', () => {
    expect(msToClock(3_661_001, ',')).toBe('01:01:01,001')
  })
  it('does not truncate hours beyond two digits', () => {
    expect(msToClock(36_000_000, ',')).toBe('10:00:00,000')
  })
  it('rounds fractional milliseconds to the nearest ms', () => {
    expect(msToClock(1500.6, ',')).toBe('00:00:01,501')
    expect(msToClock(1500.4, ',')).toBe('00:00:01,500')
  })
  it('clamps negatives to zero', () => {
    expect(msToClock(-5, ',')).toBe('00:00:00,000')
  })
})

describe('csvEscape', () => {
  it('leaves plain text unquoted', () => {
    expect(csvEscape('hello')).toBe('hello')
  })
  it('quotes fields containing a comma', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
  })
  it('quotes and doubles embedded double-quotes', () => {
    expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""')
  })
  it('quotes fields containing newlines or carriage returns', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
    expect(csvEscape('a\rb')).toBe('"a\rb"')
  })
})

describe('resolveSpeaker', () => {
  it('returns the mapped display name when present', () => {
    expect(resolveSpeaker('Speaker_0', { Speaker_0: 'Alice Johnson' })).toBe('Alice Johnson')
  })
  it('falls back to the raw label when unmapped', () => {
    expect(resolveSpeaker('Speaker_1', { Speaker_0: 'Alice Johnson' })).toBe('Speaker_1')
  })
  it('falls back to the label when the mapped value is empty', () => {
    expect(resolveSpeaker('Speaker_0', { Speaker_0: '' })).toBe('Speaker_0')
  })
  it('preserves a Unicode display name', () => {
    expect(resolveSpeaker('Speaker_0', { Speaker_0: '田中 花子' })).toBe('田中 花子')
  })
})

describe('sanitizeBasename', () => {
  it('strips Windows-illegal characters', () => {
    expect(sanitizeBasename('a<b>c:d"e/f\\g|h?i*j')).toBe('abcdefghij')
  })
  it('collapses whitespace and trims', () => {
    expect(sanitizeBasename('  My   Meeting  ')).toBe('My Meeting')
  })
  it('preserves non-ASCII (CJK) characters', () => {
    expect(sanitizeBasename('会議レポート 2026')).toBe('会議レポート 2026')
  })
  it('falls back to "transcript" when empty after sanitizing', () => {
    expect(sanitizeBasename('   ')).toBe('transcript')
    expect(sanitizeBasename('/\\:*?')).toBe('transcript')
  })
})
```

- [ ] Run it and watch it fail:
  - Command: `cd apps/electron && npx vitest run electron/main/services/__tests__/transcript-export.test.ts`
  - Expected failure: module resolution error — `Failed to resolve import "../transcript-export"` (the file does not exist yet).

- [ ] Write the minimal implementation `apps/electron/electron/main/services/transcript-export.ts`:
```ts
/**
 * Transcript export — pure formatters and helpers (no Electron / DB imports).
 *
 * The IPC handler (transcripts:export) assembles ExportData from the DB and calls
 * one of toCsv / toSrt / toJson. These functions are pure so they unit-test without
 * Electron, React, or sql.js, and a future bulk-export reuses them unchanged.
 */

import type { Turn } from './asr/asr-provider'

export interface ExportData {
  recording: {
    id: string
    title: string
    dateRecorded: string
    durationMs: number | null
    language: string
    transcriptionProvider: string | null
    transcriptionModel: string | null
  }
  fullText: string
  turns: Turn[] | null
  analysis: {
    summary: string | null
    actionItems: string[]
    topics: string[]
    keyPoints: string[]
    titleSuggestion: string | null
    sentiment: string | null
  }
  speakers: Record<string, string>
}

/** Format milliseconds as HH:MM:SS<sep>mmm. `sep` is ',' for SRT, '.' for CSV. */
export function msToClock(ms: number, sep: ',' | '.'): string {
  const total = Math.max(0, Math.round(ms))
  const millis = total % 1000
  const totalSeconds = Math.floor(total / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  const pad3 = (n: number): string => String(n).padStart(3, '0')
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}${sep}${pad3(millis)}`
}

/** RFC-4180 quoting: quote iff the field contains ", , CR or LF; double embedded quotes. */
export function csvEscape(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`
  }
  return field
}

/** Mapped display name when present and non-empty, else the raw label. */
export function resolveSpeaker(label: string, speakers: Record<string, string>): string {
  const name = speakers[label]
  return name && name.trim().length > 0 ? name : label
}

/** Windows-safe base filename derived from a recording title; "transcript" when empty. */
export function sanitizeBasename(title: string): string {
  const cleaned = (title || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : 'transcript'
}
```

- [ ] Run it and watch it pass:
  - Command: `cd apps/electron && npx vitest run electron/main/services/__tests__/transcript-export.test.ts`
  - Expected: all helper tests pass.

- [ ] Commit:
```
git add apps/electron/electron/main/services/transcript-export.ts apps/electron/electron/main/services/__tests__/transcript-export.test.ts
git commit -m "feat(electron): transcript-export module scaffold + pure helpers

ExportData interface + msToClock/csvEscape/resolveSpeaker/sanitizeBasename
with golden unit tests (ms boundaries, RFC-4180 cases, Windows-safe names).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9"
```

---

### Task 2: `toJson` formatter (always available — complete record)

**Files:**
- Modify: `apps/electron/electron/main/services/transcript-export.ts`
- Modify (test): `apps/electron/electron/main/services/__tests__/transcript-export.test.ts`

**Interfaces:**

Consumes: `ExportData` and `Turn` (from Task 1, same file).

Produces:
```ts
export function toJson(data: ExportData): string   // pretty-printed (2-space) complete record
```
Output shape (spec §6.3):
```jsonc
{
  "version": 1,
  "recording": { "id", "title", "dateRecorded", "durationMs", "language",
                 "transcriptionProvider", "transcriptionModel" },
  "transcript": { "language", "fullText", "turns": Turn[] | null },
  "analysis": { "summary", "actionItems", "topics", "keyPoints", "titleSuggestion", "sentiment" },
  "speakers": { "<label>": "<display name>" }
}
```

**Steps:**

- [ ] Add the failing test block to `transcript-export.test.ts` (append to the existing file; add `toJson` to the import from `../transcript-export`). The `baseData()` helper is ALREADY present from the Task 1 scaffold — do not redefine it:
```ts
import { toJson } from '../transcript-export'

describe('toJson', () => {
  it('emits version 1 and the full record for a non-diarized recording (turns null)', () => {
    const out = JSON.parse(toJson(baseData()))
    expect(out.version).toBe(1)
    expect(out.recording).toEqual({
      id: 'rec1',
      title: 'Weekly Sync',
      dateRecorded: '2026-06-22T10:00:00.000Z',
      durationMs: 123000,
      language: 'en',
      transcriptionProvider: 'assemblyai',
      transcriptionModel: 'best'
    })
    expect(out.transcript).toEqual({ language: 'en', fullText: 'Hello world', turns: null })
    expect(out.analysis).toEqual({
      summary: 'A short meeting.',
      actionItems: ['Ship it'],
      topics: ['release'],
      keyPoints: ['went well'],
      titleSuggestion: 'Weekly Sync',
      sentiment: 'POSITIVE'
    })
    expect(out.speakers).toEqual({ Speaker_0: 'Alice Johnson', Speaker_1: 'Speaker_1' })
  })

  it('includes the turns array verbatim for a diarized recording', () => {
    const data = baseData()
    data.turns = [
      { speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi' },
      { speaker: 'Speaker_1', startMs: 1000, endMs: 2000, text: 'Hello', sentiment: 'NEUTRAL' }
    ]
    const out = JSON.parse(toJson(data))
    expect(out.transcript.turns).toEqual(data.turns)
  })

  it('pretty-prints with two-space indentation', () => {
    expect(toJson(baseData())).toContain('\n  "version": 1')
  })

  it('serializes a zero-analysis recording with empty arrays and null scalars (no undefined)', () => {
    const data = baseData()
    data.analysis = {
      summary: null,
      actionItems: [],
      topics: [],
      keyPoints: [],
      titleSuggestion: null,
      sentiment: null
    }
    const text = toJson(data)
    const out = JSON.parse(text)
    expect(out.analysis.actionItems).toEqual([]) // not null
    expect(out.analysis.topics).toEqual([])
    expect(out.analysis.keyPoints).toEqual([])
    expect(out.analysis.summary).toBeNull() // present-and-null, not omitted
    expect(out.analysis.titleSuggestion).toBeNull()
    expect(out.analysis.sentiment).toBeNull()
    // JSON.stringify drops undefined keys; assert none were dropped.
    expect(Object.keys(out.analysis).sort()).toEqual(
      ['actionItems', 'keyPoints', 'sentiment', 'summary', 'titleSuggestion', 'topics'].sort()
    )
  })
})
```

- [ ] Run it and watch it fail:
  - Command: `cd apps/electron && npx vitest run electron/main/services/__tests__/transcript-export.test.ts`
  - Expected failure: `toJson is not a function` / no export named `toJson`.

- [ ] Add the implementation to `transcript-export.ts` (append after `sanitizeBasename`):
```ts
/** Complete-record JSON (spec §6.3). Always available; turns is null when not diarized. */
export function toJson(data: ExportData): string {
  const record = {
    version: 1,
    recording: {
      id: data.recording.id,
      title: data.recording.title,
      dateRecorded: data.recording.dateRecorded,
      durationMs: data.recording.durationMs,
      language: data.recording.language,
      transcriptionProvider: data.recording.transcriptionProvider,
      transcriptionModel: data.recording.transcriptionModel
    },
    transcript: {
      language: data.recording.language,
      fullText: data.fullText,
      turns: data.turns
    },
    analysis: {
      summary: data.analysis.summary,
      actionItems: data.analysis.actionItems,
      topics: data.analysis.topics,
      keyPoints: data.analysis.keyPoints,
      titleSuggestion: data.analysis.titleSuggestion,
      sentiment: data.analysis.sentiment
    },
    speakers: data.speakers
  }
  return JSON.stringify(record, null, 2)
}
```

- [ ] Run it and watch it pass:
  - Command: `cd apps/electron && npx vitest run electron/main/services/__tests__/transcript-export.test.ts`
  - Expected: all helper + `toJson` tests pass.

- [ ] Commit:
```
git add apps/electron/electron/main/services/transcript-export.ts apps/electron/electron/main/services/__tests__/transcript-export.test.ts
git commit -m "feat(electron): toJson complete-record transcript formatter

version=1 record with recording/transcript/analysis/speakers; turns null
when non-diarized, array when diarized. Golden tests both shapes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9"
```

---

### Task 3: `toCsv` formatter (diarized only)

**Files:**
- Modify: `apps/electron/electron/main/services/transcript-export.ts`
- Modify (test): `apps/electron/electron/main/services/__tests__/transcript-export.test.ts`

**Interfaces:**

Consumes: `ExportData`, `Turn`, `msToClock(ms, '.')`, `csvEscape`, `resolveSpeaker` (Task 1).

Produces:
```ts
export function toCsv(data: ExportData): string
```
Behavior: requires `data.turns` non-empty (handler guarantees). One row per turn. Columns `speaker,start,end,text` plus trailing `sentiment` iff any turn has a `sentiment`. `start`/`end` via `msToClock(ms, '.')`. RFC-4180 quoting via `csvEscape`. `\r\n` terminators. File begins with a UTF-8 BOM (`﻿`).

**Steps:**

- [ ] Add the failing test block (append; add `toCsv` to the import). The `baseData()` and `diarized()` helpers are ALREADY present from the Task 1 scaffold — do not redefine them:
```ts
import { toCsv } from '../transcript-export'

describe('toCsv', () => {
  it('begins with a UTF-8 BOM and a header row, and uses CRLF terminators', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi' }]))
    expect(out.charCodeAt(0)).toBe(0xfeff)
    expect(out.slice(1).startsWith('speaker,start,end,text\r\n')).toBe(true)
  })

  it('emits one row per turn with HH:MM:SS.mmm timestamps and resolved speaker names', () => {
    const out = toCsv(diarized([
      { speaker: 'Speaker_0', startMs: 0, endMs: 1500, text: 'Hello' },
      { speaker: 'Speaker_9', startMs: 1500, endMs: 3000, text: 'World' }
    ]))
    const rows = out.slice(1).split('\r\n')
    expect(rows[0]).toBe('speaker,start,end,text')
    expect(rows[1]).toBe('Alice Johnson,00:00:00.000,00:00:01.500,Hello')
    expect(rows[2]).toBe('Speaker_9,00:00:01.500,00:00:03.000,World')
  })

  it('quotes text containing a comma (RFC-4180 trigger)', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'a,b' }]))
    expect(out.slice(1).split('\r\n')[1]).toBe('Alice Johnson,00:00:00.000,00:00:01.000,"a,b"')
  })

  it('quotes and doubles an embedded double-quote (RFC-4180 trigger)', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'say "hi"' }]))
    expect(out.slice(1).split('\r\n')[1]).toBe('Alice Johnson,00:00:00.000,00:00:01.000,"say ""hi"""')
  })

  it('quotes text containing an embedded newline (RFC-4180 trigger)', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'a\nb' }]))
    expect(out.slice(1)).toBe('speaker,start,end,text\r\nAlice Johnson,00:00:00.000,00:00:01.000,"a\nb"')
  })

  it('quotes text containing a bare carriage return (RFC-4180 trigger)', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'a\rb' }]))
    expect(out.slice(1)).toBe('speaker,start,end,text\r\nAlice Johnson,00:00:00.000,00:00:01.000,"a\rb"')
  })

  it('throws when given an empty turns array (formatter contract guard)', () => {
    expect(() => toCsv({ ...baseData(), turns: [] })).toThrow()
  })

  it('omits the sentiment column when no turn has a sentiment', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi' }]))
    expect(out.slice(1).split('\r\n')[0]).toBe('speaker,start,end,text')
  })

  it('adds a trailing sentiment column when any turn has a sentiment', () => {
    const out = toCsv(diarized([
      { speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi', sentiment: 'POSITIVE' },
      { speaker: 'Speaker_1', startMs: 1000, endMs: 2000, text: 'Bye' }
    ]))
    const rows = out.slice(1).split('\r\n')
    expect(rows[0]).toBe('speaker,start,end,text,sentiment')
    expect(rows[1]).toBe('Alice Johnson,00:00:00.000,00:00:01.000,Hi,POSITIVE')
    expect(rows[2]).toBe('Speaker_1,00:00:01.000,00:00:02.000,Bye,')
    // The sentiment-less row keeps the sentinel cell (5 fields), not 4 — fixed column count.
    expect(rows[2].split(',').length).toBe(5)
  })
})
```

- [ ] Run it and watch it fail:
  - Command: `cd apps/electron && npx vitest run electron/main/services/__tests__/transcript-export.test.ts`
  - Expected failure: `toCsv is not a function` / no export named `toCsv`.

- [ ] Add the implementation to `transcript-export.ts` (append after `toJson`):
```ts
const BOM = '﻿'

/** CSV of turns (spec §6.1). Requires a non-empty turns array (handler-guaranteed). */
export function toCsv(data: ExportData): string {
  const turns = data.turns
  if (!turns || turns.length === 0) {
    throw new Error('toCsv requires a non-empty turns array')
  }
  const includeSentiment = turns.some((t) => typeof t.sentiment === 'string' && t.sentiment.length > 0)
  const header = includeSentiment ? ['speaker', 'start', 'end', 'text', 'sentiment'] : ['speaker', 'start', 'end', 'text']
  const lines: string[] = [header.join(',')]
  for (const turn of turns) {
    const cells = [
      csvEscape(resolveSpeaker(turn.speaker, data.speakers)),
      csvEscape(msToClock(turn.startMs, '.')),
      csvEscape(msToClock(turn.endMs, '.')),
      csvEscape(turn.text)
    ]
    if (includeSentiment) {
      cells.push(csvEscape(turn.sentiment ?? ''))
    }
    lines.push(cells.join(','))
  }
  return BOM + lines.join('\r\n')
}
```

- [ ] Run it and watch it pass:
  - Command: `cd apps/electron && npx vitest run electron/main/services/__tests__/transcript-export.test.ts`
  - Expected: all CSV tests pass.

- [ ] Commit:
```
git add apps/electron/electron/main/services/transcript-export.ts apps/electron/electron/main/services/__tests__/transcript-export.test.ts
git commit -m "feat(electron): toCsv turn-row formatter (RFC-4180, BOM, optional sentiment)

One row per turn; HH:MM:SS.mmm; CRLF; UTF-8 BOM; sentiment column only when
some turn carries one. Golden tests for quoting edge cases + sentiment on/off.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9"
```

---

### Task 4: `toSrt` formatter (diarized only)

**Files:**
- Modify: `apps/electron/electron/main/services/transcript-export.ts`
- Modify (test): `apps/electron/electron/main/services/__tests__/transcript-export.test.ts`

**Interfaces:**

Consumes: `ExportData`, `Turn`, `msToClock(ms, ',')`, `resolveSpeaker` (Task 1).

Produces:
```ts
export function toSrt(data: ExportData): string
```
Behavior: requires `data.turns` non-empty (handler-guaranteed). One cue per turn, numbered from 1. Cue = `<n>\nHH:MM:SS,mmm --> HH:MM:SS,mmm\n<speaker>: <text>` separated by a blank line; trailing blank line at end. Internal newlines in `text` are preserved.

**Steps:**

- [ ] Add the failing test block (append; add `toSrt` to the import). The `baseData()` and `diarized()` helpers are ALREADY present from the Task 1 scaffold — do not redefine them:
```ts
import { toSrt } from '../transcript-export'

describe('toSrt', () => {
  it('numbers cues from 1 with HH:MM:SS,mmm timestamps and Speaker: text captions', () => {
    const out = toSrt(diarized([
      { speaker: 'Speaker_0', startMs: 0, endMs: 1500, text: 'Hello' },
      { speaker: 'Speaker_9', startMs: 1500, endMs: 3661001, text: 'World' }
    ]))
    expect(out).toBe(
      '1\r\n' +
      '00:00:00,000 --> 00:00:01,500\r\n' +
      'Alice Johnson: Hello\r\n' +
      '\r\n' +
      '2\r\n' +
      '00:00:01,500 --> 01:01:01,001\r\n' +
      'Speaker_9: World\r\n' +
      '\r\n'
    )
  })

  it('preserves internal newlines in the caption text', () => {
    const out = toSrt(diarized([
      { speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'line1\nline2' }
    ]))
    expect(out).toBe(
      '1\r\n' +
      '00:00:00,000 --> 00:00:01,000\r\n' +
      'Alice Johnson: line1\nline2\r\n' +
      '\r\n'
    )
  })

  it('throws when given an empty turns array (formatter contract guard)', () => {
    expect(() => toSrt({ ...baseData(), turns: [] })).toThrow()
  })
})
```

- [ ] Run it and watch it fail:
  - Command: `cd apps/electron && npx vitest run electron/main/services/__tests__/transcript-export.test.ts`
  - Expected failure: `toSrt is not a function` / no export named `toSrt`.

- [ ] Add the implementation to `transcript-export.ts` (append after `toCsv`):
```ts
/** SRT of turns (spec §6.2). Requires a non-empty turns array (handler-guaranteed). */
export function toSrt(data: ExportData): string {
  const turns = data.turns
  if (!turns || turns.length === 0) {
    throw new Error('toSrt requires a non-empty turns array')
  }
  let out = ''
  turns.forEach((turn, i) => {
    const start = msToClock(turn.startMs, ',')
    const end = msToClock(turn.endMs, ',')
    const speaker = resolveSpeaker(turn.speaker, data.speakers)
    out += `${i + 1}\r\n${start} --> ${end}\r\n${speaker}: ${turn.text}\r\n\r\n`
  })
  return out
}
```

- [ ] Run it and watch it pass:
  - Command: `cd apps/electron && npx vitest run electron/main/services/__tests__/transcript-export.test.ts`
  - Expected: all SRT tests pass.

- [ ] Commit:
```
git add apps/electron/electron/main/services/transcript-export.ts apps/electron/electron/main/services/__tests__/transcript-export.test.ts
git commit -m "feat(electron): toSrt cue formatter (numbered, HH:MM:SS,mmm, Speaker: text)

One numbered cue per turn, blank-line separated; internal newlines preserved.
Golden tests for timestamp boundaries + sequential numbering.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9"
```

---

### Task 5: `transcripts:export` IPC handler + preload wiring

**Files:**
- Create: `apps/electron/electron/main/ipc/transcripts-export-handlers.ts`
- Modify: `apps/electron/electron/main/ipc/handlers.ts` (register the new handler)
- Modify: `apps/electron/electron/preload/index.ts` (add `transcripts.export` type + impl)
- Create (test): `apps/electron/electron/main/ipc/__tests__/transcripts-export-handlers.test.ts`

**Interfaces:**

Consumes (existing, import exactly these names):
- From `../types/api`: `success`, `error`, `Result`.
- From `../services/database`: `getTranscriptByRecordingId(recordingId: string): Transcript | undefined`, `getRecordingById(id: string): Recording | undefined`, `getRecordingSpeakers(recordingId: string): RecordingSpeaker[]`, `getContactById(id: string)`, and the types `Transcript`, `Recording`, `RecordingSpeaker`.
  - `Transcript` columns used: `full_text`, `language`, `turns?` (JSON string), `summary?`, `action_items?`, `topics?`, `key_points?`, `sentiment?`, `title_suggestion?`, `transcription_provider?`, `transcription_model?`. The JSON-string columns may be malformed and MUST be parsed defensively.
  - `RecordingSpeaker` fields used: `file_label: string`, `contact_id: string | null`.
  - `Recording` fields used: `original_filename?`, `filename`, `duration_seconds?`, `date_recorded`.
- From `../services/transcript-export`: `ExportData`, `toCsv(data: ExportData): string`, `toSrt(data: ExportData): string`, `toJson(data: ExportData): string`, `sanitizeBasename(title: string): string`.
- From `electron`: `ipcMain`, `dialog`, `BrowserWindow`. From `fs`: `writeFileSync`.
- Canonical `Turn` from `../services/asr/asr-provider`.

Produces:
- `export function registerTranscriptsExportHandlers(): void` — registers `ipcMain.handle('transcripts:export', ...)`.
- IPC contract: input `{ recordingId: string; format: 'csv' | 'srt' | 'json' }`; returns `Promise<Result<string | null>>` (saved path on success, `null` on cancel).
- Preload addition to the existing `transcripts` namespace:
  ```ts
  export: (recordingId: string, format: 'csv' | 'srt' | 'json') => Promise<Result<string | null>>
  ```
  implemented as `export: (recordingId, format) => callIPC('transcripts:export', { recordingId, format })`.

**Steps:**

- [ ] Write the failing test file `apps/electron/electron/main/ipc/__tests__/transcripts-export-handlers.test.ts`:
```ts
// NOTE: the transcript-export formatters (toCsv/toSrt/toJson) are intentionally NOT
// mocked here — a formatter regression must surface in this handler suite too. Only
// electron, fs, and the database module are mocked.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// --- electron mock: capture ipcMain.handle registrations + drive the save dialog ---
const handlers = new Map<string, (...args: any[]) => any>()
const showSaveDialog = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
  dialog: { showSaveDialog: (...a: any[]) => showSaveDialog(...a) },
  BrowserWindow: { fromWebContents: () => ({}) }
}))

// --- fs mock ---
const writeFileSync = vi.fn()
vi.mock('fs', () => ({ writeFileSync: (...a: any[]) => writeFileSync(...a) }))

// --- database mock ---
const getTranscriptByRecordingId = vi.fn()
const getRecordingById = vi.fn()
const getRecordingSpeakers = vi.fn()
const getContactById = vi.fn()
vi.mock('../../services/database', () => ({
  getTranscriptByRecordingId: (...a: any[]) => getTranscriptByRecordingId(...a),
  getRecordingById: (...a: any[]) => getRecordingById(...a),
  getRecordingSpeakers: (...a: any[]) => getRecordingSpeakers(...a),
  getContactById: (...a: any[]) => getContactById(...a)
}))

import { registerTranscriptsExportHandlers } from '../transcripts-export-handlers'

const FAKE_EVENT = { sender: {} } as any

// Typed baselines: an override typo (e.g. `turn` for `turns`) fails at compile time.
const DEFAULT_TRANSCRIPT_ROW = {
  id: 't1',
  recording_id: 'rec1',
  full_text: 'Hello world',
  language: 'en',
  turns: JSON.stringify([
    { speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi' },
    { speaker: 'Speaker_1', startMs: 1000, endMs: 2000, text: 'Bye' }
  ]) as string | null,
  summary: 'sum' as string | null,
  action_items: JSON.stringify(['do x']) as string | null,
  topics: JSON.stringify(['t']) as string | null,
  key_points: JSON.stringify(['k']) as string | null,
  sentiment: 'POSITIVE' as string | null,
  title_suggestion: 'My Meeting' as string | null,
  transcription_provider: 'assemblyai' as string | null,
  transcription_model: 'best' as string | null
}

const DEFAULT_RECORDING_ROW = {
  id: 'rec1',
  filename: 'rec1.wav',
  original_filename: 'orig.wav' as string | null,
  file_path: '/x/rec1.wav',
  date_recorded: '2026-06-22T10:00:00.000Z',
  duration_seconds: 120 as number | null,
  status: 'complete'
}

function setupTranscript(
  over: Partial<typeof DEFAULT_TRANSCRIPT_ROW> = {},
  recOver: Partial<typeof DEFAULT_RECORDING_ROW> = {}
) {
  getTranscriptByRecordingId.mockReturnValue({ ...DEFAULT_TRANSCRIPT_ROW, ...over })
  getRecordingById.mockReturnValue({ ...DEFAULT_RECORDING_ROW, ...recOver })
  getRecordingSpeakers.mockReturnValue([
    { recording_id: 'rec1', file_label: 'Speaker_0', contact_id: 'c1', confidence: null, source: 'user', created_at: 'x' }
  ])
  getContactById.mockReturnValue({ id: 'c1', name: 'Alice Johnson' })
}

beforeEach(() => {
  handlers.clear()
  showSaveDialog.mockReset()
  writeFileSync.mockReset()
  getTranscriptByRecordingId.mockReset()
  getRecordingById.mockReset()
  getRecordingSpeakers.mockReset()
  getContactById.mockReset()
  registerTranscriptsExportHandlers()
})

function callExport(args: { recordingId: string; format: 'csv' | 'srt' | 'json' }) {
  const fn = handlers.get('transcripts:export')!
  return fn(FAKE_EVENT, args)
}

describe('transcripts:export handler', () => {
  it('registers the channel', () => {
    expect(handlers.has('transcripts:export')).toBe(true)
  })

  it('returns NOT_FOUND and writes nothing when there is no transcript', async () => {
    getTranscriptByRecordingId.mockReturnValue(undefined)
    const res = await callExport({ recordingId: 'rec1', format: 'json' })
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('NOT_FOUND')
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('gates CSV on diarization with NOT_DIARIZED when turns are absent', async () => {
    setupTranscript({ turns: null })
    const res = await callExport({ recordingId: 'rec1', format: 'csv' })
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('NOT_DIARIZED')
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('gates SRT on diarization with NOT_DIARIZED when turns are absent', async () => {
    setupTranscript({ turns: null })
    const res = await callExport({ recordingId: 'rec1', format: 'srt' })
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('NOT_DIARIZED')
  })

  it('treats malformed turns JSON as non-diarized: CSV gated, JSON still exports turns:null', async () => {
    setupTranscript({ turns: '{not json' })
    const csv = await callExport({ recordingId: 'rec1', format: 'csv' })
    expect(csv.success).toBe(false)
    expect(csv.error.code).toBe('NOT_DIARIZED')

    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/My Meeting.json' })
    const json = await callExport({ recordingId: 'rec1', format: 'json' })
    expect(json.success).toBe(true)
    const written = writeFileSync.mock.calls[0][1] as string
    expect(JSON.parse(written).transcript.turns).toBeNull()
  })

  it('returns success(null) and writes nothing when the dialog is cancelled', async () => {
    setupTranscript()
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const res = await callExport({ recordingId: 'rec1', format: 'json' })
    expect(res.success).toBe(true)
    expect(res.data).toBeNull()
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('writes the formatter output to the chosen path and returns the path on success', async () => {
    setupTranscript()
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/My Meeting.csv' })
    const res = await callExport({ recordingId: 'rec1', format: 'csv' })
    expect(res.success).toBe(true)
    expect(res.data).toBe('/out/My Meeting.csv')
    expect(writeFileSync).toHaveBeenCalledTimes(1)
    const [path, content, enc] = writeFileSync.mock.calls[0]
    expect(path).toBe('/out/My Meeting.csv')
    expect(enc).toBe('utf-8')
    expect((content as string).charCodeAt(0)).toBe(0xfeff) // BOM
    expect(content as string).toContain('Alice Johnson,00:00:00.000,00:00:01.000,Hi')
  })

  it('proposes a sanitized default filename derived from the title', async () => {
    setupTranscript({ title_suggestion: 'a/b:c*?' })
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    await callExport({ recordingId: 'rec1', format: 'json' })
    const opts = showSaveDialog.mock.calls[0][1]
    expect(opts.defaultPath).toBe('abc.json')
  })

  it('falls back to the recording filename (sans extension) when title_suggestion is null', async () => {
    setupTranscript({ title_suggestion: null }, { original_filename: 'My Recording.wav' })
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    await callExport({ recordingId: 'rec1', format: 'json' })
    const opts = showSaveDialog.mock.calls[0][1]
    expect(opts.defaultPath).toBe('My Recording.json')
  })

  it('rejects an invalid format with VALIDATION_ERROR', async () => {
    setupTranscript()
    const res = await callExport({ recordingId: 'rec1', format: 'pdf' } as any)
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('VALIDATION_ERROR')
  })
})
```

- [ ] Run it and watch it fail:
  - Command: `cd apps/electron && npx vitest run electron/main/ipc/__tests__/transcripts-export-handlers.test.ts`
  - Expected failure: `Failed to resolve import "../transcripts-export-handlers"` (file not created yet).

- [ ] Create `apps/electron/electron/main/ipc/transcripts-export-handlers.ts`:
```ts
/**
 * Transcript Export IPC Handler (transcripts:export)
 *
 * Loads a recording's transcript + metadata + speaker roster, builds a normalized
 * ExportData, gates CSV/SRT on diarization (server-side backstop — the UI also
 * disables them), runs the matching pure formatter, and saves via the native dialog.
 * Mirrors the file-save pattern in outputs-handlers.ts.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { success, error, Result } from '../types/api'
import {
  getTranscriptByRecordingId,
  getRecordingById,
  getRecordingSpeakers,
  getContactById
} from '../services/database'
import {
  toCsv,
  toSrt,
  toJson,
  sanitizeBasename,
  type ExportData
} from '../services/transcript-export'
import type { Turn } from '../services/asr/asr-provider'

type ExportFormat = 'csv' | 'srt' | 'json'

/** Parse a JSON string into a string[]; any failure or non-array yields []. */
function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
  } catch {
    return []
  }
}

/** Parse the turns JSON string into Turn[]; any failure or non-array yields null (non-diarized). */
function parseTurns(raw: string | null | undefined): Turn[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as Turn[]) : null
  } catch {
    return null
  }
}

const DIALOG_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  csv: { name: 'CSV', extensions: ['csv'] },
  srt: { name: 'SubRip Subtitle', extensions: ['srt'] },
  json: { name: 'JSON', extensions: ['json'] }
}

export function registerTranscriptsExportHandlers(): void {
  ipcMain.handle(
    'transcripts:export',
    async (event, request: unknown): Promise<Result<string | null>> => {
      try {
        // Validate input
        const req = request as { recordingId?: unknown; format?: unknown } | null
        const recordingId = req && typeof req.recordingId === 'string' ? req.recordingId : ''
        const format = req && (req.format === 'csv' || req.format === 'srt' || req.format === 'json')
          ? (req.format as ExportFormat)
          : null
        if (!recordingId || !format) {
          return error('VALIDATION_ERROR', 'Invalid export request: need a recordingId and a csv|srt|json format')
        }

        // Load transcript
        const transcript = getTranscriptByRecordingId(recordingId)
        if (!transcript) {
          return error('NOT_FOUND', 'No transcript to export')
        }

        // Parse turns defensively → diarization gate
        const turns = parseTurns(transcript.turns)
        const isDiarized = Array.isArray(turns) && turns.length > 0
        if ((format === 'csv' || format === 'srt') && !isDiarized) {
          return error(
            'NOT_DIARIZED',
            'CSV and SRT export require diarization. Re-transcribe with diarization to enable.'
          )
        }

        // Recording metadata. Title prefers the AI title; the filename fallbacks have their
        // file extension stripped so the default save name is not e.g. "My Recording.wav.json".
        const recording = getRecordingById(recordingId)
        const stripExt = (name: string): string => name.replace(/\.[^./\\]+$/, '')
        const fileFallback = recording?.original_filename || recording?.filename
        const title =
          transcript.title_suggestion ||
          (fileFallback ? stripExt(fileFallback) : '') ||
          'transcript'
        const durationMs =
          recording && typeof recording.duration_seconds === 'number'
            ? Math.round(recording.duration_seconds * 1000)
            : null

        // Speaker roster: file_label -> contact name (fallback handled by resolveSpeaker)
        const speakers: Record<string, string> = {}
        for (const row of getRecordingSpeakers(recordingId)) {
          if (!row.contact_id) continue
          const contact = getContactById(row.contact_id)
          if (contact) speakers[row.file_label] = contact.name
        }

        const data: ExportData = {
          recording: {
            id: recordingId,
            title,
            dateRecorded: recording?.date_recorded ?? '',
            durationMs,
            language: transcript.language ?? '',
            transcriptionProvider: transcript.transcription_provider ?? null,
            transcriptionModel: transcript.transcription_model ?? null
          },
          fullText: transcript.full_text ?? '',
          turns,
          analysis: {
            summary: transcript.summary ?? null,
            actionItems: parseStringArray(transcript.action_items),
            topics: parseStringArray(transcript.topics),
            keyPoints: parseStringArray(transcript.key_points),
            titleSuggestion: transcript.title_suggestion ?? null,
            sentiment: transcript.sentiment ?? null
          },
          speakers
        }

        const content =
          format === 'csv' ? toCsv(data) : format === 'srt' ? toSrt(data) : toJson(data)

        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) {
          return error('INTERNAL_ERROR', 'No window found')
        }

        const defaultPath = `${sanitizeBasename(title)}.${format}`
        const result = await dialog.showSaveDialog(win, {
          defaultPath,
          filters: [DIALOG_FILTERS[format], { name: 'All Files', extensions: ['*'] }]
        })

        if (result.canceled || !result.filePath) {
          return success(null)
        }

        writeFileSync(result.filePath, content, 'utf-8')
        return success(result.filePath)
      } catch (err) {
        console.error('transcripts:export error:', err)
        return error('INTERNAL_ERROR', 'Failed to export transcript', err)
      }
    }
  )

  console.log('Transcript export IPC handler registered')
}
```

- [ ] Run it and watch it pass:
  - Command: `cd apps/electron && npx vitest run electron/main/ipc/__tests__/transcripts-export-handlers.test.ts`
  - Expected: all handler tests pass.

- [ ] Register the handler in `apps/electron/electron/main/ipc/handlers.ts`. Add the import after the `registerSummarizationTemplatesHandlers` import line:
```ts
import { registerTranscriptsExportHandlers } from './transcripts-export-handlers'
```
  and add the call after the `registerSummarizationTemplatesHandlers()` line inside `registerIpcHandlers`:
```ts
  registerTranscriptsExportHandlers()
```

- [ ] Wire the preload in `apps/electron/electron/preload/index.ts`. Use grep-stable textual anchors (line numbers drift across schema versions). There are two `updateTurns:` occurrences — one in the TYPE block, one in the IMPL block; edit BOTH.
  - In the TYPE block, find the `updateTurns:` type line (`updateTurns: (request: { recordingId: string; turns: unknown[] }) => Promise<Result<{ recordingId: string }>>`) and add this line immediately after it:
```ts
    export: (recordingId: string, format: 'csv' | 'srt' | 'json') => Promise<Result<string | null>>
```
  - In the IMPL block, find the `updateTurns:` impl line (`updateTurns: (request) => callIPC('transcripts:updateTurns', request)`), add a trailing comma to it, and add this line immediately after:
```ts
    export: (recordingId, format) => callIPC('transcripts:export', { recordingId, format })
```
  (`Result` is already imported in this file — it is used by the existing `updateTurns` type.)

- [ ] Run the full gate (typecheck node+web + lint + all tests):
  - Command: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`
  - Expected: typecheck and lint clean; all tests (including the new ones) pass.

- [ ] Commit:
```
git add apps/electron/electron/main/ipc/transcripts-export-handlers.ts apps/electron/electron/main/ipc/handlers.ts apps/electron/electron/preload/index.ts apps/electron/electron/main/ipc/__tests__/transcripts-export-handlers.test.ts
git commit -m "feat(electron): transcripts:export IPC handler + preload binding

Loads transcript+recording+roster, builds ExportData defensively, server-side
NOT_DIARIZED gate for csv/srt, sanitized default filename, native save dialog,
success(null) on cancel. Adds transcripts.export to the preload namespace.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9"
```

---

### Task 6: SourceReader export dropdown (adaptive Select)

**Files:**
- Modify: `apps/electron/src/features/library/components/SourceReader.tsx`
- Create (test): `apps/electron/src/features/library/components/__tests__/SourceReaderExport.test.tsx`

**Interfaces:**

Consumes (existing in `SourceReader.tsx`):
- `const recordingId = recording?.id` (string | undefined, line ~121).
- `turns` state (`Turn[]`, line ~122) — diarization is `turns.length > 0`.
- `transcript?.full_text` — the export control is gated on the literal expression `transcript?.full_text && recordingId` (there is NO `hasTranscript` variable in this file; do not introduce one).
- `Select, SelectTrigger, SelectValue, SelectContent, SelectItem` from `@/components/ui/select` (already imported).
- `Download` icon from `lucide-react` (already imported), `toast` from `@/components/ui/toaster` (already imported).
- Preload method (Task 5): `window.electronAPI.transcripts.export(recordingId: string, format: 'csv' | 'srt' | 'json'): Promise<Result<string | null>>` where success carries the saved path (`string`) or `null` on cancel.

Produces: an Export `Select` in the action-button area (`<div className="flex flex-wrap gap-2 ...">` at line ~606) rendered when `transcript?.full_text && recordingId` is truthy. Trigger `className="h-8 w-auto gap-1 text-sm"` with a `Download` icon and `placeholder="Export…"`. Items: JSON always enabled; CSV and SRT enabled only when `turns.length > 0`, else `disabled` with hint text "Requires diarization". On select: call the preload export, show a success toast with the path, no-op on `null`, error toast on failure. The Select is action-only (resets after each pick).

**Steps:**

- [ ] Write the failing test `apps/electron/src/features/library/components/__tests__/SourceReaderExport.test.tsx`. (Drive the dropdown by calling `onValueChange` directly via a stub of the `Select` from `@/components/ui/select`, so the test does not depend on Radix portal/pointer behavior in jsdom.)
```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SourceReader } from '../SourceReader'
import type { UnifiedRecording } from '@/types/unified-recording'

// Capture each Select's onValueChange, tagging the one that owns the export items so we
// can find it WITHOUT relying on render order (a Re-summarize Select may also render).
// The mocked SelectTrigger forwards data-testid; the export trigger is
// data-testid="transcript-export-trigger", so the Select wrapping it is the export one.
const selectCalls: Array<{ onValueChange?: (v: string) => void; isExport: boolean }> = []
function subtreeHasTestId(node: any, testId: string): boolean {
  if (!node || typeof node !== 'object') return false
  const arr = Array.isArray(node) ? node : [node]
  for (const n of arr) {
    if (!n || typeof n !== 'object') continue
    if (n.props?.['data-testid'] === testId) return true
    if (n.props?.children && subtreeHasTestId(n.props.children, testId)) return true
  }
  return false
}
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, onValueChange }: any) => {
    const isExport = subtreeHasTestId(children, 'transcript-export-trigger')
    selectCalls.push({ onValueChange, isExport })
    return <div data-testid={isExport ? 'export-select' : 'select'}>{children}</div>
  },
  SelectTrigger: ({ children, ['data-testid']: testId }: any) => (
    <button data-testid={testId}>{children}</button>
  ),
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value, disabled }: any) => (
    <div data-testid={`item-${value}`} data-disabled={disabled ? 'true' : 'false'}>{children}</div>
  )
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/components/ui/toaster', () => ({
  toast: { error: (...a: any[]) => toastError(...a), success: (...a: any[]) => toastSuccess(...a) }
}))

const recording = {
  id: 'rec1',
  filename: 'rec1.wav',
  transcriptionStatus: 'complete'
} as unknown as UnifiedRecording

const diarizedTranscript = {
  full_text: 'Hi there',
  turns: JSON.stringify([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi' }])
} as any

const nonDiarizedTranscript = { full_text: 'Hi there', turns: null } as any

// IMPORTANT: window.electronAPI.transcripts.getByRecordingId returns a RAW Transcript
// (the db:get-transcript channel), NOT a Result envelope. SourceReader.refreshSpeakers
// reads `freshTranscript.turns` (a raw JSON string) directly. If we mocked an envelope
// here, `.turns` would be undefined and the async setTurns([]) would blank the
// prop-seeded turns and race the gating assertions. So the mock must mirror the prop.
const getByRecordingId = vi.fn()
const exportFn = vi.fn()

/** Render with getByRecordingId mirroring the given raw transcript prop. */
function renderWith(transcript: any) {
  getByRecordingId.mockResolvedValue(transcript) // raw Transcript, not a Result
  return render(<SourceReader recording={recording} transcript={transcript} onResummarize={vi.fn()} />)
}

beforeEach(() => {
  selectCalls.length = 0
  toastError.mockReset()
  toastSuccess.mockReset()
  exportFn.mockReset()
  getByRecordingId.mockReset()
  ;(window as any).electronAPI = {
    transcripts: {
      getByRecordingId: (...a: any[]) => getByRecordingId(...a),
      export: exportFn
    },
    speakers: { getForRecording: vi.fn().mockResolvedValue({ success: true, data: {} }), getSuggestions: vi.fn().mockResolvedValue({ success: true, data: [] }) }
  }
})

/**
 * Return the export Select's captured props, identified deterministically by the
 * `transcript-export-trigger` testid it wraps — NOT by positional last-Select (a
 * Re-summarize Select may also render after it).
 */
function findExportSelect() {
  expect(screen.getByTestId('item-json')).toBeTruthy()
  const exportSelect = selectCalls.find((c) => c.isExport)
  expect(exportSelect).toBeTruthy()
  return exportSelect!
}

describe('SourceReader export dropdown', () => {
  it('disables CSV and SRT for a non-diarized transcript; JSON stays enabled', async () => {
    renderWith(nonDiarizedTranscript)
    // Wait for the async refreshSpeakers to settle (it sets turns from the raw fetch).
    await waitFor(() => expect(screen.getByTestId('item-csv').getAttribute('data-disabled')).toBe('true'))
    expect(screen.getByTestId('item-json').getAttribute('data-disabled')).toBe('false')
    expect(screen.getByTestId('item-srt').getAttribute('data-disabled')).toBe('true')
  })

  it('enables CSV and SRT for a diarized transcript', async () => {
    renderWith(diarizedTranscript)
    await waitFor(() => expect(screen.getByTestId('item-csv').getAttribute('data-disabled')).toBe('false'))
    expect(screen.getByTestId('item-srt').getAttribute('data-disabled')).toBe('false')
    expect(screen.getByTestId('item-json').getAttribute('data-disabled')).toBe('false')
  })

  it('calls transcripts.export with the recordingId and chosen format, toasting the saved path', async () => {
    exportFn.mockResolvedValue({ success: true, data: '/out/My Meeting.json' })
    renderWith(diarizedTranscript)
    await waitFor(() => expect(screen.getByTestId('item-json')).toBeTruthy())
    const sel = findExportSelect()
    await sel.onValueChange!('json')
    expect(exportFn).toHaveBeenCalledWith('rec1', 'json')
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it('is a no-op on cancellation (data === null): no toast', async () => {
    exportFn.mockResolvedValue({ success: true, data: null })
    renderWith(diarizedTranscript)
    await waitFor(() => expect(screen.getByTestId('item-json')).toBeTruthy())
    const sel = findExportSelect()
    await sel.onValueChange!('json')
    expect(exportFn).toHaveBeenCalledWith('rec1', 'json')
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('shows an error toast when the export fails', async () => {
    exportFn.mockResolvedValue({ success: false, error: { code: 'INTERNAL_ERROR', message: 'disk full' } })
    renderWith(diarizedTranscript)
    await waitFor(() => expect(screen.getByTestId('item-json')).toBeTruthy())
    const sel = findExportSelect()
    await sel.onValueChange!('json')
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })
})
```

- [ ] Run it and watch it fail:
  - Command: `cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReaderExport.test.tsx`
  - Expected failure: `Unable to find an element by: [data-testid="item-json"]` (the export Select does not exist yet).

- [ ] Add the export dropdown to `SourceReader.tsx`. Insert this block inside the action-button container (the `<div className="flex flex-wrap gap-2 border-b ...">` at line ~606), placed immediately before the Delete Button block (the `{onDelete && (` block at line ~817):
```tsx
        {/* Transcript export — JSON always; CSV/SRT only when the transcript is diarized. */}
        {transcript?.full_text && recordingId && (
          <Select
            onValueChange={async (format) => {
              const api = window.electronAPI
              if (!api?.transcripts?.export) return
              try {
                const res = await api.transcripts.export(recordingId, format as 'csv' | 'srt' | 'json')
                if (!res.success) {
                  toast.error('Export failed', res.error.message)
                } else if (res.data) {
                  toast.success('Transcript exported', `Saved to ${res.data}`)
                }
                // res.data === null → user cancelled the save dialog; no-op.
              } catch (err) {
                toast.error('Export failed', err instanceof Error ? err.message : String(err))
              }
            }}
          >
            <SelectTrigger
              className="h-8 w-auto gap-1 text-sm"
              title="Export the transcript to a file"
              data-testid="transcript-export-trigger"
            >
              <Download className="h-4 w-4" />
              <SelectValue placeholder="Export…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="csv" disabled={turns.length === 0}>
                {turns.length === 0 ? 'CSV — Requires diarization' : 'CSV'}
              </SelectItem>
              <SelectItem value="srt" disabled={turns.length === 0}>
                {turns.length === 0 ? 'SRT — Requires diarization' : 'SRT'}
              </SelectItem>
            </SelectContent>
          </Select>
        )}
```
  Note: `recordingId`, `turns`, `Select`/`SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem`, `Download`, and `toast` are all already in scope in this file — no new imports.

- [ ] Run it and watch it pass:
  - Command: `cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReaderExport.test.tsx`
  - Expected: all reader tests pass.

- [ ] Run the full gate:
  - Command: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`
  - Expected: typecheck (node+web) and lint clean; entire suite green.

- [ ] Commit:
```
git add apps/electron/src/features/library/components/SourceReader.tsx apps/electron/src/features/library/components/__tests__/SourceReaderExport.test.tsx
git commit -m "feat(electron): SourceReader transcript export dropdown

Adaptive Select gated on transcript?.full_text && recordingId: JSON always; CSV/SRT enabled only when
diarized (turns present) else disabled with a requires-diarization hint. Calls
transcripts.export; success toasts the saved path, cancel is a silent no-op.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9"
```

---

## Final verification (after Task 6)

- [ ] From `apps/electron`: `npm run typecheck && npm run lint && npm run test:run` — all green.
- [ ] Spot-confirm acceptance criteria §9: JSON export for any transcript; CSV+SRT for diarized; CSV/SRT disabled with hint for non-diarized; speaker names mapped-then-fallback; cancel leaves no file and no error; no-transcript → NOT_FOUND message; sanitized Windows-safe default filename.
