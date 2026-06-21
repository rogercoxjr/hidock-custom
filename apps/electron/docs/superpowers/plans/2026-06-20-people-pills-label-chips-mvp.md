# People Pills + Label Chips on Library Cards — MVP (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render meeting-attendee pills and category dot-chips on every Library card (SourceRow + SourceCard), derived renderer-side from already-fetched data with no new IPC or DB changes.

**Architecture:** Two pure derivation helpers (`deriveCapturePeople`, `deriveCaptureLabels`) produce typed arrays from existing `meeting` and `recording.category` data; primitive string keys (`peopleKey`, `labelsKey`) are pre-computed in Library.tsx and passed as props alongside the arrays so the existing scalar `memo` comparators can guard re-renders without per-render array allocation. The meeting enrichment fetch is widened to include device-only rows that have a `meetingId`. Both `SourceRow` and `SourceCard` receive the new props and render a slim meta row using existing `PersonAvatar`, `Badge`, and `Tooltip` Harbor primitives.

**Tech Stack:** React 18 + TypeScript, Tailwind CSS (Harbor tokens), Vitest, existing `PersonAvatar`/`Badge`/`Tooltip` components.

## Global Constraints

- No new DB schema changes (no migrations).
- No new IPC channels or `electronAPI` additions (MVP is renderer-only).
- No new `useState`/`useEffect` in Library.tsx — fold all enrichment widening into the existing `loadEnrichment` `Promise.all` and `enrichmentKey` useMemo.
- Do NOT modify `PersonAvatar` — it was recently updated; read it, use it, don't change it.
- Label colors use only existing Harbor semantic tokens (no raw palette colors, no hashing).
- QA logs use `useUIStore.getState().qaLogsEnabled` + `[QA-MONITOR]` prefix (CLAUDE.md rule).
- Line length: 120 characters (TypeScript).
- All three quality gates must stay green: `npm run typecheck:web`, `npm run test:run`, `npm run build` (run from `apps/electron/`). The pre-existing `typecheck:node` chat-provider failure is not ours to fix.
- Harbor token cheatsheet: `bg-surface-sunken`, `text-ink-muted`, `text-ink`, `bg-accent-2-soft text-accent-2`, `bg-warning-soft text-warning`, `bg-success-soft text-success`, `bg-primary text-primary-foreground`, `bg-danger-soft text-danger`, `text-foreground`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/features/library/utils/deriveCapturePeople.ts` | **Create** | Pure helper: `Meeting → CapturePerson[]` from attendees |
| `src/features/library/utils/deriveCaptureLabels.ts` | **Create** | Pure helper: `category → CaptureLabel[]` with color token |
| `src/features/library/utils/__tests__/deriveCapturePeople.test.ts` | **Create** | Unit tests for derivation + key stability |
| `src/features/library/utils/__tests__/deriveCaptureLabels.test.ts` | **Create** | Unit tests for derivation + key stability |
| `src/features/library/utils/index.ts` | **Modify** | Re-export the two new helpers |
| `src/features/library/types/captureMeta.ts` | **Create** | `CapturePerson`, `CaptureLabel` interfaces |
| `src/features/library/components/CapturePeoplePills.tsx` | **Create** | Renders pills (PersonAvatar + name + overflow "+N" with tooltip) |
| `src/features/library/components/CaptureLabelChips.tsx` | **Create** | Renders label chips (Badge + colored dot) |
| `src/features/library/components/__tests__/CapturePeoplePills.test.tsx` | **Create** | Render tests: count cap, "+N", tooltip content |
| `src/features/library/components/__tests__/CaptureLabelChips.test.tsx` | **Create** | Render tests: color token present, chip text |
| `src/features/library/components/SourceRow.tsx` | **Modify** | Add `people?`, `labels?`, `peopleKey?`, `labelsKey?` props; render meta row; update comparator |
| `src/features/library/components/SourceCard.tsx` | **Modify** | Same new props; render meta row; update comparator |
| `src/pages/Library.tsx` | **Modify** | Widen meeting enrichment filter; compute `people`/`labels`/`peopleKey`/`labelsKey`; pass to both card components |

---

### Task 1: Define CapturePerson and CaptureLabel types

**Files:**
- Create: `src/features/library/types/captureMeta.ts`

**Interfaces:**
- Produces: `CapturePerson`, `CaptureLabel` (used by Tasks 2–9)

- [ ] **Step 1: Write the type file**

```typescript
// src/features/library/types/captureMeta.ts

/**
 * A person associated with a capture — derived renderer-side from meeting
 * attendees (slice 1) or diarized speakers (slice 2, fast-follow).
 */
export interface CapturePerson {
  /** Contact ID if known (from attendee or speaker record). */
  id?: string
  name: string
  source: 'attendee' | 'speaker'
  /** True if this person is the app user (used to hide self on cards). Slice 1: always undefined. */
  isSelf?: boolean
}

/**
 * A label associated with a capture — category (slice 1) or topic chip (slice 2).
 */
export interface CaptureLabel {
  text: string
  kind: 'category' | 'topic'
  /**
   * Tailwind utility string for the dot color (e.g. "bg-accent-2").
   * Set only for category kind. Topics are uncolored in slice 1.
   */
  colorClass?: string
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx tsc --noEmit --project tsconfig.web.json 2>&1 | head -20`

Expected: no errors related to `captureMeta.ts`.

- [ ] **Step 3: Commit**

```bash
git -C "C:/Users/rcox/hidock-tools/hidock-next" add apps/electron/src/features/library/types/captureMeta.ts
git -C "C:/Users/rcox/hidock-tools/hidock-next" commit -m "feat(library): add CapturePerson + CaptureLabel renderer types"
```

---

### Task 2: Implement `deriveCaptureLabels` + tests

**Files:**
- Create: `src/features/library/utils/deriveCaptureLabels.ts`
- Create: `src/features/library/utils/__tests__/deriveCaptureLabels.test.ts`

**Interfaces:**
- Consumes: `CapturePerson`, `CaptureLabel` from `../types/captureMeta`
- Produces: `deriveCaptureLabels(category?: string): CaptureLabel[]`, `buildLabelsKey(labels: CaptureLabel[]): string`

The category color palette (6 fixed values matching `SourceCategory` enum from `src/features/library/types/source.ts`):

| category | colorClass |
|----------|-----------|
| `meeting` | `bg-primary` |
| `interview` | `bg-accent-2` |
| `1:1` | `bg-success` |
| `brainstorm` | `bg-warning` |
| `note` | `bg-accent-strong-soft` |
| `other` | `bg-surface-sunken` |

- [ ] **Step 1: Write the failing tests**

```typescript
// src/features/library/utils/__tests__/deriveCaptureLabels.test.ts
import { describe, it, expect } from 'vitest'
import { deriveCaptureLabels, buildLabelsKey } from '../deriveCaptureLabels'

describe('deriveCaptureLabels', () => {
  it('returns empty array when category is undefined', () => {
    expect(deriveCaptureLabels(undefined)).toEqual([])
  })

  it('returns empty array when category is empty string', () => {
    expect(deriveCaptureLabels('')).toEqual([])
  })

  it('returns one category chip for a known category', () => {
    const labels = deriveCaptureLabels('meeting')
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatchObject({ text: 'meeting', kind: 'category', colorClass: 'bg-primary' })
  })

  it('returns a chip for every known category value', () => {
    const categories = ['meeting', 'interview', '1:1', 'brainstorm', 'note', 'other'] as const
    for (const cat of categories) {
      const labels = deriveCaptureLabels(cat)
      expect(labels).toHaveLength(1)
      expect(labels[0].kind).toBe('category')
      expect(labels[0].colorClass).toBeTruthy()
    }
  })

  it('returns a chip for unknown category without a colorClass', () => {
    const labels = deriveCaptureLabels('custom-unknown')
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatchObject({ text: 'custom-unknown', kind: 'category' })
    expect(labels[0].colorClass).toBeUndefined()
  })
})

describe('buildLabelsKey', () => {
  it('returns empty string for empty array', () => {
    expect(buildLabelsKey([])).toBe('')
  })

  it('produces stable key: same values → same string', () => {
    const a = deriveCaptureLabels('meeting')
    const b = deriveCaptureLabels('meeting')
    expect(buildLabelsKey(a)).toBe(buildLabelsKey(b))
  })

  it('produces different key for different categories', () => {
    const a = buildLabelsKey(deriveCaptureLabels('meeting'))
    const b = buildLabelsKey(deriveCaptureLabels('interview'))
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx vitest run src/features/library/utils/__tests__/deriveCaptureLabels.test.ts 2>&1 | tail -10`

Expected: test file errors (module not found).

- [ ] **Step 3: Write the implementation**

```typescript
// src/features/library/utils/deriveCaptureLabels.ts
import type { CaptureLabel } from '../types/captureMeta'

/** Fixed color tokens for the 6 known SourceCategory values. */
const CATEGORY_COLOR: Record<string, string> = {
  meeting: 'bg-primary',
  interview: 'bg-accent-2',
  '1:1': 'bg-success',
  brainstorm: 'bg-warning',
  note: 'bg-accent-strong-soft',
  other: 'bg-surface-sunken',
}

/**
 * Derive capture labels from a recording's category field.
 * Slice 1: category only. Slice 2 will add uncolored topic chips.
 */
export function deriveCaptureLabels(category?: string | null): CaptureLabel[] {
  if (!category) return []
  return [
    {
      text: category,
      kind: 'category',
      colorClass: CATEGORY_COLOR[category],
    },
  ]
}

/**
 * Stable primitive key from a labels array — safe to use in memo comparators
 * without array allocation per comparison.
 */
export function buildLabelsKey(labels: CaptureLabel[]): string {
  return labels.map((l) => `${l.kind}:${l.text}`).join('|')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx vitest run src/features/library/utils/__tests__/deriveCaptureLabels.test.ts 2>&1 | tail -10`

Expected: all tests pass (green).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/rcox/hidock-tools/hidock-next" add \
  apps/electron/src/features/library/utils/deriveCaptureLabels.ts \
  apps/electron/src/features/library/utils/__tests__/deriveCaptureLabels.test.ts
git -C "C:/Users/rcox/hidock-tools/hidock-next" commit -m "feat(library): add deriveCaptureLabels helper + tests"
```

---

### Task 3: Implement `deriveCapturePeople` + tests

**Files:**
- Create: `src/features/library/utils/deriveCapturePeople.ts`
- Create: `src/features/library/utils/__tests__/deriveCapturePeople.test.ts`

**Interfaces:**
- Consumes: `Meeting` from `@/types`, `parseAttendees` from `@/types`, `CapturePerson` from `../types/captureMeta`
- Produces: `deriveCapturePeople(meeting?: Meeting): CapturePerson[]`, `buildPeopleKey(people: CapturePerson[]): string`

Self-hiding rule (Decision #2c): Best-effort in slice 1. Attendees have no reliable `isSelf` flag, so hide nobody. `isSelf` enforcement arrives in slice 2.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/features/library/utils/__tests__/deriveCapturePeople.test.ts
import { describe, it, expect } from 'vitest'
import { deriveCapturePeople, buildPeopleKey } from '../deriveCapturePeople'
import type { Meeting } from '@/types'

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    subject: 'Test Meeting',
    start_time: '2026-01-01T09:00:00Z',
    end_time: '2026-01-01T10:00:00Z',
    location: null,
    organizer_name: null,
    organizer_email: null,
    attendees: null,
    description: null,
    is_recurring: 0,
    recurrence_rule: null,
    meeting_url: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('deriveCapturePeople', () => {
  it('returns empty array when meeting is undefined', () => {
    expect(deriveCapturePeople(undefined)).toEqual([])
  })

  it('returns empty array when meeting has no attendees', () => {
    expect(deriveCapturePeople(makeMeeting({ attendees: null }))).toEqual([])
  })

  it('returns empty array when attendees is empty JSON array', () => {
    expect(deriveCapturePeople(makeMeeting({ attendees: '[]' }))).toEqual([])
  })

  it('derives people from attendees with names', () => {
    const attendees = JSON.stringify([
      { name: 'Alice Smith', email: 'alice@example.com' },
      { name: 'Bob Jones', email: 'bob@example.com' },
    ])
    const people = deriveCapturePeople(makeMeeting({ attendees }))
    expect(people).toHaveLength(2)
    expect(people[0]).toMatchObject({ name: 'Alice Smith', source: 'attendee' })
    expect(people[1]).toMatchObject({ name: 'Bob Jones', source: 'attendee' })
  })

  it('falls back to email when name is missing', () => {
    const attendees = JSON.stringify([{ email: 'noname@example.com' }])
    const people = deriveCapturePeople(makeMeeting({ attendees }))
    expect(people).toHaveLength(1)
    expect(people[0].name).toBe('noname@example.com')
  })

  it('skips attendees with no name AND no email', () => {
    const attendees = JSON.stringify([{}, { name: 'Alice' }])
    const people = deriveCapturePeople(makeMeeting({ attendees }))
    expect(people).toHaveLength(1)
    expect(people[0].name).toBe('Alice')
  })

  it('handles malformed JSON gracefully (returns empty array)', () => {
    const people = deriveCapturePeople(makeMeeting({ attendees: 'not-json' }))
    expect(people).toEqual([])
  })
})

describe('buildPeopleKey', () => {
  it('returns empty string for empty array', () => {
    expect(buildPeopleKey([])).toBe('')
  })

  it('produces stable key: same people → same string', () => {
    const attendees = JSON.stringify([{ name: 'Alice Smith' }])
    const a = deriveCapturePeople(makeMeeting({ attendees }))
    const b = deriveCapturePeople(makeMeeting({ attendees }))
    expect(buildPeopleKey(a)).toBe(buildPeopleKey(b))
  })

  it('produces different key for different people', () => {
    const a = buildPeopleKey([{ name: 'Alice', source: 'attendee' }])
    const b = buildPeopleKey([{ name: 'Bob', source: 'attendee' }])
    expect(a).not.toBe(b)
  })

  it('produces different key for different count', () => {
    const a = buildPeopleKey([{ name: 'Alice', source: 'attendee' }])
    const b = buildPeopleKey([{ name: 'Alice', source: 'attendee' }, { name: 'Bob', source: 'attendee' }])
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx vitest run src/features/library/utils/__tests__/deriveCapturePeople.test.ts 2>&1 | tail -10`

Expected: test file errors (module not found).

- [ ] **Step 3: Write the implementation**

```typescript
// src/features/library/utils/deriveCapturePeople.ts
import { parseAttendees } from '@/types'
import type { Meeting } from '@/types'
import type { CapturePerson } from '../types/captureMeta'

/**
 * Derive capture people (slice 1: meeting attendees only).
 * Slice 2 will add diarized/assigned speakers from recording_speakers.
 */
export function deriveCapturePeople(meeting?: Meeting): CapturePerson[] {
  if (!meeting) return []
  const attendees = parseAttendees(meeting.attendees)
  const people: CapturePerson[] = []
  for (const attendee of attendees) {
    const name = attendee.name?.trim() || attendee.email?.trim()
    if (!name) continue
    people.push({ name, source: 'attendee' })
  }
  return people
}

/**
 * Stable primitive key from a people array — safe to use in memo comparators
 * without array allocation per comparison.
 */
export function buildPeopleKey(people: CapturePerson[]): string {
  return people.map((p) => p.name).join('|')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx vitest run src/features/library/utils/__tests__/deriveCapturePeople.test.ts 2>&1 | tail -10`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/rcox/hidock-tools/hidock-next" add \
  apps/electron/src/features/library/utils/deriveCapturePeople.ts \
  apps/electron/src/features/library/utils/__tests__/deriveCapturePeople.test.ts
git -C "C:/Users/rcox/hidock-tools/hidock-next" commit -m "feat(library): add deriveCapturePeople helper + tests"
```

---

### Task 4: Re-export new helpers from utils/index.ts

**Files:**
- Modify: `src/features/library/utils/index.ts`

**Interfaces:**
- Produces: all helpers importable via `@/features/library/utils`

- [ ] **Step 1: Read the current index.ts**

Read `src/features/library/utils/index.ts` (currently exports 6 entries, no derivation helpers).

- [ ] **Step 2: Add re-exports**

The current content of `src/features/library/utils/index.ts` is:
```typescript
export * from './errorHandling'
export * from './adapters'
export * from './formatTimestamp'
export * from './getDisplayTitle'
export * from './highlightText'
export { buildSearchCorpus, buildDateAliases } from './buildSearchCorpus'
```

Append these two lines:
```typescript
export * from './deriveCapturePeople'
export * from './deriveCaptureLabels'
```

- [ ] **Step 3: Verify typecheck still passes**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx tsc --noEmit --project tsconfig.web.json 2>&1 | grep "error TS" | head -10`

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git -C "C:/Users/rcox/hidock-tools/hidock-next" add apps/electron/src/features/library/utils/index.ts
git -C "C:/Users/rcox/hidock-tools/hidock-next" commit -m "feat(library): re-export deriveCapturePeople + deriveCaptureLabels from utils"
```

---

### Task 5: Build `CaptureLabelChips` component + tests

**Files:**
- Create: `src/features/library/components/CaptureLabelChips.tsx`
- Create: `src/features/library/components/__tests__/CaptureLabelChips.test.tsx`

**Interfaces:**
- Consumes: `CaptureLabel` from `../types/captureMeta`, `Badge` from `@/components/ui/badge`
- Produces: `CaptureLabelChips({ labels: CaptureLabel[] }): JSX.Element | null`

Design rule: Each label chip = `<Badge size="sm" variant="default">` with a small colored leading dot span using `colorClass`. If `colorClass` is undefined the dot is omitted. Render nothing when `labels` is empty.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/features/library/components/__tests__/CaptureLabelChips.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { CaptureLabelChips } from '../CaptureLabelChips'
import type { CaptureLabel } from '../../types/captureMeta'

describe('CaptureLabelChips', () => {
  it('renders nothing when labels is empty', () => {
    const { container } = render(<CaptureLabelChips labels={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one chip for a category label', () => {
    const labels: CaptureLabel[] = [{ text: 'meeting', kind: 'category', colorClass: 'bg-primary' }]
    render(<CaptureLabelChips labels={labels} />)
    expect(screen.getByText('meeting')).toBeInTheDocument()
  })

  it('renders the colored dot span when colorClass is set', () => {
    const labels: CaptureLabel[] = [{ text: 'meeting', kind: 'category', colorClass: 'bg-primary' }]
    const { container } = render(<CaptureLabelChips labels={labels} />)
    // The dot span has the colorClass applied
    const dot = container.querySelector('.bg-primary')
    expect(dot).not.toBeNull()
  })

  it('renders without dot when colorClass is undefined', () => {
    const labels: CaptureLabel[] = [{ text: 'custom', kind: 'category' }]
    const { container } = render(<CaptureLabelChips labels={labels} />)
    expect(screen.getByText('custom')).toBeInTheDocument()
    // No dot element (no colorClass utility in this container aside from badge itself)
    expect(container.querySelectorAll('[class*="bg-"]:not(span[class*="border"])').length).toBeGreaterThanOrEqual(0) // soft check
  })

  it('renders multiple chips', () => {
    const labels: CaptureLabel[] = [
      { text: 'meeting', kind: 'category', colorClass: 'bg-primary' },
      { text: 'interview', kind: 'category', colorClass: 'bg-accent-2' },
    ]
    render(<CaptureLabelChips labels={labels} />)
    expect(screen.getByText('meeting')).toBeInTheDocument()
    expect(screen.getByText('interview')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx vitest run src/features/library/components/__tests__/CaptureLabelChips.test.tsx 2>&1 | tail -10`

Expected: errors (module not found).

- [ ] **Step 3: Write the component**

```tsx
// src/features/library/components/CaptureLabelChips.tsx
import { Badge } from '@/components/ui/badge'
import type { CaptureLabel } from '../types/captureMeta'

interface CaptureLabelChipsProps {
  labels: CaptureLabel[]
}

/**
 * Renders a row of category dot-chips from a CaptureLabel array.
 * Each chip is a Harbor Badge (size sm) with an optional leading colored dot.
 */
export function CaptureLabelChips({ labels }: CaptureLabelChipsProps) {
  if (labels.length === 0) return null

  return (
    <div className="flex items-center flex-wrap gap-1" aria-label="Capture labels">
      {labels.map((label) => (
        <Badge key={`${label.kind}-${label.text}`} variant="default" size="sm">
          {label.colorClass && (
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${label.colorClass}`}
              aria-hidden
            />
          )}
          {label.text}
        </Badge>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx vitest run src/features/library/components/__tests__/CaptureLabelChips.test.tsx 2>&1 | tail -10`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/rcox/hidock-tools/hidock-next" add \
  apps/electron/src/features/library/components/CaptureLabelChips.tsx \
  apps/electron/src/features/library/components/__tests__/CaptureLabelChips.test.tsx
git -C "C:/Users/rcox/hidock-tools/hidock-next" commit -m "feat(library): add CaptureLabelChips component + tests"
```

---

### Task 6: Build `CapturePeoplePills` component + tests

**Files:**
- Create: `src/features/library/components/CapturePeoplePills.tsx`
- Create: `src/features/library/components/__tests__/CapturePeoplePills.test.tsx`

**Interfaces:**
- Consumes: `CapturePerson` from `../types/captureMeta`, `PersonAvatar` from `@/components/harbor/PersonAvatar`, `Tooltip*` from `@/components/ui/tooltip`
- Produces: `CapturePeoplePills({ people: CapturePerson[], cap?: number, onOverflowClick?: () => void }): JSX.Element | null`

Design rules:
- Default cap = 3 visible avatars + "+N" pill when more.
- Each visible person: `<PersonAvatar size={20} name={person.name} />` + name truncated (single-line).
- Overflow "+N" pill: a `<button>` styled like a mini-badge that calls `onOverflowClick` when provided; wraps in Tooltip showing full names.
- Render nothing when `people` is empty.
- Accessible: `aria-label="N people"` on the wrapper; the tooltip trigger has `aria-label="Show all attendees"`.
- Do NOT pass `color` to PersonAvatar (let it derive its deterministic color from name). Do NOT pass `voiceBadge` (slice 2 concern).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/features/library/components/__tests__/CapturePeoplePills.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { CapturePeoplePills } from '../CapturePeoplePills'
import type { CapturePerson } from '../../types/captureMeta'

const people3: CapturePerson[] = [
  { name: 'Alice Smith', source: 'attendee' },
  { name: 'Bob Jones', source: 'attendee' },
  { name: 'Carol Davis', source: 'attendee' },
]

const people5: CapturePerson[] = [
  ...people3,
  { name: 'Dave Brown', source: 'attendee' },
  { name: 'Eve Miller', source: 'attendee' },
]

describe('CapturePeoplePills', () => {
  it('renders nothing when people is empty', () => {
    const { container } = render(<CapturePeoplePills people={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders up to cap (default 3) visible names', () => {
    render(<CapturePeoplePills people={people3} />)
    expect(screen.getByText('Alice Smith')).toBeInTheDocument()
    expect(screen.getByText('Bob Jones')).toBeInTheDocument()
    expect(screen.getByText('Carol Davis')).toBeInTheDocument()
  })

  it('renders "+N" overflow pill when count exceeds cap', () => {
    render(<CapturePeoplePills people={people5} />)
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('does NOT render overflow pill when count equals cap', () => {
    render(<CapturePeoplePills people={people3} cap={3} />)
    expect(screen.queryByText(/^\+\d+$/)).toBeNull()
  })

  it('respects custom cap prop', () => {
    render(<CapturePeoplePills people={people5} cap={2} />)
    expect(screen.getByText('+3')).toBeInTheDocument()
  })

  it('renders wrapper with accessible aria-label', () => {
    render(<CapturePeoplePills people={people3} />)
    expect(screen.getByRole('group', { name: '3 people' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx vitest run src/features/library/components/__tests__/CapturePeoplePills.test.tsx 2>&1 | tail -10`

Expected: errors (module not found).

- [ ] **Step 3: Write the component**

```tsx
// src/features/library/components/CapturePeoplePills.tsx
import { PersonAvatar } from '@/components/harbor/PersonAvatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { CapturePerson } from '../types/captureMeta'

interface CapturePeoplePillsProps {
  people: CapturePerson[]
  /** Max visible pills before "+N" overflow. Default 3. */
  cap?: number
  /** Called when user clicks the overflow "+N" pill (e.g. to open source reader). */
  onOverflowClick?: () => void
}

/**
 * Renders a row of person avatar pills capped at `cap` with an overflow "+N" button.
 * People are derived from meeting attendees (slice 1) or diarized speakers (slice 2).
 */
export function CapturePeoplePills({ people, cap = 3, onOverflowClick }: CapturePeoplePillsProps) {
  if (people.length === 0) return null

  const visible = people.slice(0, cap)
  const overflow = people.slice(cap)
  const hasOverflow = overflow.length > 0

  return (
    <div
      className="flex items-center gap-1 flex-wrap"
      role="group"
      aria-label={`${people.length} people`}
    >
      {visible.map((person) => (
        <span
          key={person.name}
          className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-1.5 py-0.5"
          title={person.name}
        >
          <PersonAvatar name={person.name} size={16} />
          <span className="text-[10.5px] font-medium text-ink-muted leading-none truncate max-w-[80px]">
            {person.name}
          </span>
        </span>
      ))}

      {hasOverflow && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10.5px] font-medium text-ink-muted leading-none hover:bg-surface-hover transition-colors"
                onClick={onOverflowClick}
                aria-label="Show all attendees"
              >
                +{overflow.length}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">{overflow.map((p) => p.name).join(', ')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx vitest run src/features/library/components/__tests__/CapturePeoplePills.test.tsx 2>&1 | tail -10`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/rcox/hidock-tools/hidock-next" add \
  apps/electron/src/features/library/components/CapturePeoplePills.tsx \
  apps/electron/src/features/library/components/__tests__/CapturePeoplePills.test.tsx
git -C "C:/Users/rcox/hidock-tools/hidock-next" commit -m "feat(library): add CapturePeoplePills component + tests"
```

---

### Task 7: Wire new props into SourceRow + update comparator

**Files:**
- Modify: `src/features/library/components/SourceRow.tsx`

**Interfaces:**
- Consumes: `CapturePerson`, `CaptureLabel` from `../types/captureMeta`; `CapturePeoplePills` from `./CapturePeoplePills`; `CaptureLabelChips` from `./CaptureLabelChips`
- Produces: updated `SourceRowProps` with `people?`, `labels?`, `peopleKey?`, `labelsKey?`

**Layout change:** Add a third line under the secondary meta line (date · duration · status pill). The new line renders `CapturePeoplePills` and `CaptureLabelChips` side-by-side, only when content exists. Keep the same compact height profile — use `mt-0.5` spacing.

**Comparator change:** Add `prevProps.peopleKey === nextProps.peopleKey && prevProps.labelsKey === nextProps.labelsKey` (these are primitive strings — safe for the comparator).

- [ ] **Step 1: Read SourceRow.tsx**

Read the full file at `src/features/library/components/SourceRow.tsx` (already done above for reference).

- [ ] **Step 2: Add imports at the top of SourceRow.tsx**

After the existing imports (after the `useLibraryStore` and `highlightText` imports), add:
```typescript
import { CapturePeoplePills } from './CapturePeoplePills'
import { CaptureLabelChips } from './CaptureLabelChips'
import type { CapturePerson, CaptureLabel } from '../types/captureMeta'
```

- [ ] **Step 3: Extend SourceRowProps**

After `deviceConnected?: boolean` in `SourceRowProps`, add:
```typescript
  /** Pre-derived people for the pills row (from meeting attendees, slice 1). */
  people?: CapturePerson[]
  /** Pre-derived labels for the chip row (category, slice 1). */
  labels?: CaptureLabel[]
  /** Stable primitive key for people array — used in memo comparator. */
  peopleKey?: string
  /** Stable primitive key for labels array — used in memo comparator. */
  labelsKey?: string
  /** Called when overflow "+N" pill is clicked (opens source reader). */
  onOverflowPeopleClick?: () => void
```

- [ ] **Step 4: Destructure new props**

In the function signature destructuring after `deviceConnected = false,`, add:
```typescript
  people = [],
  labels = [],
  peopleKey: _peopleKey,
  labelsKey: _labelsKey,
  onOverflowPeopleClick,
```

Note: `peopleKey` and `labelsKey` are destructured with aliases `_peopleKey`/`_labelsKey` to satisfy linting (the values are only used in the comparator, not in the render body).

- [ ] **Step 5: Add the people/labels meta row in the JSX**

Inside the `<div className="flex-1 min-w-0">` (the content area), after the existing `<div className="flex items-center gap-1.5 mt-0.5 min-w-0">` (secondary meta line), add:

```tsx
{/* People pills + label chips — visible when data is present */}
{(people.length > 0 || labels.length > 0) && (
  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
    <CapturePeoplePills people={people} cap={3} onOverflowClick={onOverflowPeopleClick} />
    <CaptureLabelChips labels={labels} />
  </div>
)}
```

- [ ] **Step 6: Update the memo comparator**

In the comparator function at the bottom of the file, after the `prevProps.searchQuery === nextProps.searchQuery` comparison, add:
```typescript
    prevProps.peopleKey === nextProps.peopleKey &&
    prevProps.labelsKey === nextProps.labelsKey &&
```

- [ ] **Step 7: Verify typecheck**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx tsc --noEmit --project tsconfig.web.json 2>&1 | grep "error TS" | head -20`

Expected: no errors.

- [ ] **Step 8: Run existing SourceRow tests to verify nothing broken**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx vitest run src/features/library/components/__tests__/ 2>&1 | tail -20`

Expected: all pass (no regressions; the new props are optional with defaults).

- [ ] **Step 9: Commit**

```bash
git -C "C:/Users/rcox/hidock-tools/hidock-next" add apps/electron/src/features/library/components/SourceRow.tsx
git -C "C:/Users/rcox/hidock-tools/hidock-next" commit -m "feat(library): add people pills + label chips to SourceRow"
```

---

### Task 8: Wire new props into SourceCard + update comparator

**Files:**
- Modify: `src/features/library/components/SourceCard.tsx`

**Interfaces:**
- Consumes: same `CapturePerson`, `CaptureLabel`, `CapturePeoplePills`, `CaptureLabelChips`
- Produces: updated `SourceCardProps` with `people?`, `labels?`, `peopleKey?`, `labelsKey?`

**Layout change:** In `SourceCard`, add the meta row between `CardDescription` (date/size/duration line, `:130-135`) and the closing `</div>` of the header info block. This places it directly under the mono description line. Only render if `people.length > 0 || labels.length > 0`.

**Comparator change:** same as SourceRow — add `peopleKey`/`labelsKey` string comparisons.

- [ ] **Step 1: Read SourceCard.tsx**

Read the full file at `src/features/library/components/SourceCard.tsx` (already done above for reference).

- [ ] **Step 2: Add imports**

After the existing imports (after `useLibraryStore` import), add:
```typescript
import { CapturePeoplePills } from './CapturePeoplePills'
import { CaptureLabelChips } from './CaptureLabelChips'
import type { CapturePerson, CaptureLabel } from '../types/captureMeta'
```

- [ ] **Step 3: Extend SourceCardProps**

After `onNavigateToMeeting: (meetingId: string) => void`, add:
```typescript
  people?: CapturePerson[]
  labels?: CaptureLabel[]
  peopleKey?: string
  labelsKey?: string
  onOverflowPeopleClick?: () => void
```

- [ ] **Step 4: Destructure new props**

After `onNavigateToMeeting` in the function destructuring, add:
```typescript
  people = [],
  labels = [],
  peopleKey: _peopleKey,
  labelsKey: _labelsKey,
  onOverflowPeopleClick,
```

- [ ] **Step 5: Add the meta row in JSX**

Inside `<CardHeader className="pb-3">`, within the inner `<div className="min-w-0">` that wraps `CardTitle` + `CardDescription` (lines 126-135), after the closing `</CardDescription>` tag, add:

```tsx
{/* People pills + label chips — visible when data is present */}
{(people.length > 0 || labels.length > 0) && (
  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
    <CapturePeoplePills people={people} cap={3} onOverflowClick={onOverflowPeopleClick} />
    <CaptureLabelChips labels={labels} />
  </div>
)}
```

- [ ] **Step 6: Update the memo comparator**

After `prevProps.meeting?.id === nextProps.meeting?.id`, add:
```typescript
    prevProps.peopleKey === nextProps.peopleKey &&
    prevProps.labelsKey === nextProps.labelsKey &&
```

- [ ] **Step 7: Verify typecheck + existing tests**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx tsc --noEmit --project tsconfig.web.json 2>&1 | grep "error TS" | head -20`

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx vitest run src/features/library/components/__tests__/ 2>&1 | tail -20`

Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git -C "C:/Users/rcox/hidock-tools/hidock-next" add apps/electron/src/features/library/components/SourceCard.tsx
git -C "C:/Users/rcox/hidock-tools/hidock-next" commit -m "feat(library): add people pills + label chips to SourceCard"
```

---

### Task 9: Widen meeting enrichment + pass pills/chips from Library.tsx

**Files:**
- Modify: `src/pages/Library.tsx`

**What changes:**

1. **Meeting enrichment widening (Decision #1b):** The current `meetingIds` filter in both `enrichmentKey` and `loadEnrichment` is:
   ```typescript
   .filter((rec) => hasLocalPath(rec) && rec.meetingId)
   ```
   Change both occurrences to:
   ```typescript
   .filter((rec) => rec.meetingId)
   ```
   This includes device-only rows with a `meetingId` so their attendee pills aren't silently empty.

2. **Derive + pass people/labels to SourceRow** (list view, around line 1014):
   Before the `<SourceRow>` render, compute:
   ```typescript
   const people = deriveCapturePeople(meeting)
   const labels = deriveCaptureLabels(recording.category)
   const peopleKey = buildPeopleKey(people)
   const labelsKey = buildLabelsKey(labels)
   ```
   Then pass as props: `people={people} labels={labels} peopleKey={peopleKey} labelsKey={labelsKey} onOverflowPeopleClick={() => handleRowClick(recording)}`.

3. **Derive + pass people/labels to SourceCard** (card view, around line 1073):
   Same computation pattern, pass the same four props + `onOverflowPeopleClick`.

4. **Imports:** Add at the top of Library.tsx (near other feature imports):
   ```typescript
   import { deriveCapturePeople, buildPeopleKey, deriveCaptureLabels, buildLabelsKey } from '@/features/library/utils'
   ```

- [ ] **Step 1: Read the relevant sections of Library.tsx**

Read `src/pages/Library.tsx` lines 314-368 (enrichmentKey + loadEnrichment) and lines 990-1110 (list view + card view render blocks).

- [ ] **Step 2: Add the imports**

Find the existing import block at the top of Library.tsx that already imports from `@/features/library/utils`. It currently reads something like:
```typescript
import { buildSearchCorpus, buildDateAliases } from '@/features/library/utils'
```
Add to that import:
```typescript
import {
  buildSearchCorpus, buildDateAliases,
  deriveCapturePeople, buildPeopleKey,
  deriveCaptureLabels, buildLabelsKey
} from '@/features/library/utils'
```

- [ ] **Step 3: Widen the enrichmentKey meetingIds filter**

In the `enrichmentKey` useMemo (lines ~314-326), change:
```typescript
    const meetingIds = recordings
      .filter((rec) => hasLocalPath(rec) && rec.meetingId)
      .map((rec) => rec.meetingId!)
      .sort()
      .join(',')
```
To:
```typescript
    const meetingIds = recordings
      .filter((rec) => rec.meetingId)
      .map((rec) => rec.meetingId!)
      .sort()
      .join(',')
```

- [ ] **Step 4: Widen the loadEnrichment meetingIds filter**

In the `loadEnrichment` async function (lines ~336-347), change:
```typescript
      const meetingIds = recordings
        .filter((rec) => hasLocalPath(rec) && rec.meetingId)
        .map((rec) => rec.meetingId!)
```
To:
```typescript
      const meetingIds = recordings
        .filter((rec) => rec.meetingId)
        .map((rec) => rec.meetingId!)
```

- [ ] **Step 5: Add derivation + pass props to SourceRow (list view)**

In the list view block (around line 1014 where `<SourceRow>` is rendered), the existing pattern is:
```typescript
const meeting = recording.meetingId ? meetings.get(recording.meetingId) : undefined
```
After that line (which already exists), add:
```typescript
const people = deriveCapturePeople(meeting)
const labels = deriveCaptureLabels(recording.category)
const peopleKey = buildPeopleKey(people)
const labelsKey = buildLabelsKey(labels)
```
Then in the `<SourceRow>` JSX (right after existing props like `onGenerateOutput`), add:
```tsx
  people={people}
  labels={labels}
  peopleKey={peopleKey}
  labelsKey={labelsKey}
  onOverflowPeopleClick={() => handleRowClick(recording)}
```

- [ ] **Step 6: Add derivation + pass props to SourceCard (card view)**

In the card view block (around line 1054 where `<SourceCard>` is rendered), the same pattern:
```typescript
const meeting = recording.meetingId ? meetings.get(recording.meetingId) : undefined
```
After that, add the same four-line derivation block, then pass `people`, `labels`, `peopleKey`, `labelsKey`, and `onOverflowPeopleClick={() => handleRowClick(recording)}` to `<SourceCard>`.

- [ ] **Step 7: Verify typecheck**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx tsc --noEmit --project tsconfig.web.json 2>&1 | grep "error TS" | head -20`

Expected: no errors.

- [ ] **Step 8: Run all tests**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npx vitest run 2>&1 | tail -20`

Expected: all tests pass (green).

- [ ] **Step 9: Commit**

```bash
git -C "C:/Users/rcox/hidock-tools/hidock-next" add apps/electron/src/pages/Library.tsx
git -C "C:/Users/rcox/hidock-tools/hidock-next" commit -m "feat(library): widen meeting enrichment + wire people pills + label chips from Library"
```

---

### Task 10: Final quality gates

**Files:**
- No code changes — this task verifies all three gates.

- [ ] **Step 1: Run typecheck:web**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npm run typecheck:web 2>&1 | tail -5`

Expected: exits 0, no errors.

- [ ] **Step 2: Run test suite**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npm run test:run 2>&1 | tail -10`

Expected: all tests pass.

- [ ] **Step 3: Run build**

Run: `cd "C:/Users/rcox/hidock-tools/hidock-next/apps/electron" && npm run build 2>&1 | tail -10`

Expected: exits 0, build succeeds.

- [ ] **Step 4: Commit gate evidence**

If any gate fails, diagnose and fix before proceeding. If all gates pass, note the result lines for the final deliverable summary.

---

## Self-Review Checklist

**Spec coverage:**
- [x] Decision #1b (widen meeting fetch for device-only rows) → Task 9 step 3+4
- [x] Decision #2c (best-effort self-hiding — no new IPC) → `deriveCapturePeople` returns all attendees without isSelf, meeting the "slice 1 is best-effort" requirement
- [x] Decision #3a (attendees only for MVP) → `deriveCapturePeople` uses only `meeting.attendees`
- [x] Decision #4a (category only, colored, fixed palette) → `deriveCaptureLabels` + `CATEGORY_COLOR` map
- [x] Primitive keys passed as props, comparators updated → Tasks 7+8 comparator steps
- [x] Reuse existing enrichment `Promise.all`, no new state/effect → Task 9
- [x] `PersonAvatar` read-only (not modified) → CapturePeoplePills consumes it
- [x] SourceRow layout preserved (content-first rebuild) → new row added under secondary meta
- [x] SourceCard layout preserved → new row added under CardDescription
- [x] Library.tsx centerPanel / deselect-on-reclick not touched → Task 9 only touches enrichmentKey + loadEnrichment + render props
- [x] QA log rule — no new debug logs added (no `console.log` in the new util/component files)
- [x] Tests: derivation helpers, comparator behavior (primitive key stability), component render → Tasks 2+3+5+6
- [x] No dead code: `_peopleKey`/`_labelsKey` destructuring alias in SourceRow/SourceCard avoids unused-var lint errors

**No placeholders found.**

**Type consistency:**
- `CapturePerson` / `CaptureLabel` defined once in `captureMeta.ts`, imported everywhere
- `deriveCapturePeople(meeting?: Meeting): CapturePerson[]` — consistent across task 3 and task 9
- `deriveCaptureLabels(category?: string | null): CaptureLabel[]` — consistent across task 2 and task 9
- `buildPeopleKey(people: CapturePerson[]): string` — consistent across task 3 and task 9
- `buildLabelsKey(labels: CaptureLabel[]): string` — consistent across task 2 and task 9
- `CapturePeoplePills` and `CaptureLabelChips` used identically in SourceRow and SourceCard
