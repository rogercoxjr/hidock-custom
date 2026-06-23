# Reader Quality-of-Life Improvements Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL — `subagent-driven-development`. Each task below is an independent, TDD-shaped unit; dispatch one subagent per task, in order, and verify each task's tests pass before starting the next.

**Goal:** Ship five focused, UI-only quality-of-life tweaks to the Library reader's transcript experience in `apps/electron`: (1) a return-to-top button on the transcript scroll container, (2) per-speaker collapse in the By-Speaker view, (3) a collapsible Speakers panel, (4) assigned-name display in the Speakers panel, and (5) moving the summary to the top of the reader (out of `TranscriptViewer`, into `SourceReader`). No backend, IPC, DB, or data-model changes. No new dependencies.

**Architecture:** All three target components live under `apps/electron/src/features/library/components/`: `SourceReader.tsx` (host; renders metadata header → action buttons → sticky audio player → a single `overflow-auto` scroll area containing alert banners, loading indicator, `SpeakersPanel`, template chip, `TranscriptViewer`), `TranscriptViewer.tsx` (Summary / Action items / Transcript with a `containerRef` inner scroll container and a timeline/by-speaker `SegmentedToggle`), and `SpeakersPanel.tsx` (per-label rows with assign/merge/reassign + per-turn reassign list). `SourceReader` owns the transcript/analysis data (including `summary`) and fetches `speakerNames`/`speakerAssignments` via `window.electronAPI.speakers.getForRecording(recordingId)`. The changes reuse the existing in-component collapse pattern and local component state; no store changes.

**Tech Stack:** Electron 39 + React 18 + TypeScript + Tailwind + Radix UI. Tests: Vitest + `@testing-library/react`, co-located in `__tests__/` next to each component. `cwd` = repo root `C:/Users/rcox/hidock-tools/hidock-next`. Icons from `lucide-react`. Collapse pattern uses `ChevronDown`/`ChevronRight` and `Eyebrow` (`@/components/harbor/Eyebrow`).

## Global Constraints

- 120-column line length for all TS/TSX.
- **Shared test fixtures (DRY).** Two small test-util modules are created in Task 2 / Task 4 (first task that needs each) and imported by later co-located tests to avoid fixture drift:
  - `apps/electron/src/features/library/components/__tests__/transcriptViewerTestUtils.ts` — exports `makeTwoSpeakerTurns(): Turn[]` (the canonical two-speaker fixture) and `switchToBySpeaker()` (clicks the by-speaker `role="tab"` via `getByRole('tab', { name: /by speaker/i })` + `fireEvent.click`). No JSX is emitted, so `.ts` is correct. Used by the return-to-top and per-speaker-collapse tests.
  - `apps/electron/src/features/library/components/__tests__/speakersPanelTestUtils.ts` — exports `setupSpeakersPanelMocks()` (the `window.electronAPI` + `useConfigStore` stub block) and `makeTurns(): Turn[]`. Used by the SpeakersPanel collapse and names tests.
  These modules contain NO `describe`/`it`, so Vitest will not treat them as empty suites.
- Before declaring any task done, run the full gate from `apps/electron`: `npm run typecheck && npm run lint && npm run test:run` — `npm run typecheck` covers BOTH `typecheck:node` and `typecheck:web` (tsconfig.node includes test files); do NOT substitute vitest-only for typecheck.
- UI-only: NO backend, IPC, DB, or data-model changes; no new npm dependencies.
- Reuse the existing collapse pattern — `const [x, setX] = useState(true)` + a full-width header button `className="flex w-full items-center justify-between rounded-lg border border-border bg-surface-sunken p-3 transition-colors hover:bg-surface-hover"` with `aria-expanded={x}`, `ChevronDown` when expanded / `ChevronRight` when collapsed (`h-4 w-4 text-ink-muted`), body rendered only when `x`.
- All new collapses (summary, per-speaker, Speakers panel) default **expanded**.
- Collapse state is session-local component state, NOT persisted across recordings or app restarts.
- Return-to-top visibility threshold ≈ **300px** of `scrollTop`.
- Keep the raw diarization letter visible wherever a track must be identified for assignment/merge/reassign; the assigned name leads when present.
- Do NOT touch device/USB code.

**Verified current-state facts (checked against source before this plan was finalized — re-confirm during implementation):**
- `SegmentedToggle` (`src/components/ui/segmented-toggle.tsx`) renders `role="tablist"` on the container and each option as `<button role="tab" aria-selected>`. The explicit `role="tab"` overrides the implicit button role, so by-speaker tests MUST query `getByRole('tab', { name: /by speaker/i })`, NOT `getByRole('button', …)`.
- `TranscriptViewer.test.tsx` (existing) passes `showSummary={false}` in FOUR render calls — lines 21, 39, 53, 64. Removing `showSummary` from `TranscriptViewerProps` makes all four TS2322 errors; they MUST be deleted in the same edit (Task 1).
- `SpeakersPanel.tsx` ALREADY has, inside `labels.map(...)` (~line 526), a per-row string `const displayName = assignedName ?? label` plus a per-row `const assignedName = assignment?.contactName ?? assignedNames?.[label]` (~525) and `const dotColor = avatarColor(assignedName ?? label)` (~533). It also already renders an assigned-name badge `{assignedName && <span …>→ {assignedName}</span>}` on the stat line (~563). Task 5 must NOT introduce a component-scope `displayName` function — that name collides with the per-row string and would shadow inside the map. Task 5 uses the helper name `resolveName` instead and removes the redundant line-563 badge.
- `SpeakersPanel.tsx` raw-label sites confirmed: assignment chip jump-button span (~554) and non-jump fallback span (~557); popover confirmation `Assigned to {label}` (~595); merge dialog option `Merge into {target.label}` (~680, OUTSIDE `labels.map`); per-turn reassign label `{t.speaker}` (~817, OUTSIDE `labels.map`); reassign dialog option `Reassign to {target.label}` (~840, OUTSIDE `labels.map`).

---

### Task 1: Move the summary to the top of the reader (#5)

Remove the Summary collapsible block and its `summary`/`showSummary` props from `TranscriptViewer`; render the summary at the top of the `SourceReader` scroll area (below the existing alert banners, above `SpeakersPanel` + template chip + `TranscriptViewer`), keeping a default-expanded collapsible header, guarded so it only renders when a non-empty summary exists.

**Files:**
- Modify: `apps/electron/src/features/library/components/TranscriptViewer.tsx`
- Modify: `apps/electron/src/features/library/components/SourceReader.tsx`
- Test: `apps/electron/src/features/library/components/__tests__/TranscriptViewer.test.tsx` (existing — add a case)
- Test: `apps/electron/src/features/library/components/__tests__/SourceReader.summaryTop.test.tsx` (new)

**Interfaces:**
- Consumes (SourceReader, already in scope): `transcript.summary: string | null | undefined`.
- Produces: `SourceReader` renders an inline summary block guarded by `transcript.summary` with local state `const [summaryExpanded, setSummaryExpanded] = useState(true)`. The block header reads `Summary`.
- Removed from `TranscriptViewer`: props `showSummary?: boolean` and `summary?: string` (drop from `TranscriptViewerProps`, the destructured params, the `summaryExpanded`/`setSummaryExpanded` state, and the Summary JSX block ~238–258). `actionItems`/`showActionItems` REMAIN in `TranscriptViewer`. `SourceReader` stops passing `showSummary` and `summary` to `<TranscriptViewer>`.
- `TranscriptViewerProps` after this task: `{ transcript: string; turns?: Turn[]; speakerNames?: Record<string,string>; currentTimeMs?: number; onSeek: (startMs: number, endMs?: number) => void; showActionItems?: boolean; actionItems?: string[] }`.

**Note on RED ordering for this task:** because the existing `TranscriptViewer.test.tsx` passes `showSummary={false}` in four render calls (lines 21, 39, 53, 64), a strict "add failing test first, then implement" sequence is impossible — the moment the prop is removed from the interface the whole test file fails to *compile* (TS2322) regardless of the new assertion. So this task is structured as a **regression guard**, not strict RED-first: make the prop/JSX removal AND the four prop-deletions in one coherent edit, ADD the new guard test in the same pass, then run the file green. The new test documents the intended behavior (Summary absent, Action Items present) and guards against regression.

**Steps:**

- [ ] Edit `TranscriptViewer.test.tsx` first: delete the `showSummary={false}` prop from all FOUR render calls (lines 21, 39, 53, 64 — the prop is being removed from the interface in this same task, so these become TS errors otherwise), and append the new guard `describe` block. The file already imports `render, screen, vi` and `TranscriptViewer`. After deletion the four calls read e.g. `<TranscriptViewer transcript="ignored flat text" turns={makeTurns()} onSeek={vi.fn()} />` (line 21), the `speakerNames` call drops the trailing `showSummary={false}` line (39), the legacy-parser call drops it (53), and the plain-text call becomes `render(<TranscriptViewer transcript="Just some plain text." onSeek={vi.fn()} />)` (64). Then append:

```tsx
describe('TranscriptViewer — no summary section (QOL #5)', () => {
  it('does not render a Summary section even when a summary string would have been passed', () => {
    render(
      <TranscriptViewer
        transcript="Plain transcript body."
        actionItems={['Do the thing']}
        showActionItems
        onSeek={vi.fn()}
      />
    )
    expect(screen.queryByText('Summary')).not.toBeInTheDocument()
    // Action items remain owned by TranscriptViewer
    expect(screen.getByText('Action Items')).toBeInTheDocument()
    expect(screen.getByText('Do the thing')).toBeInTheDocument()
  })
})
```

- [ ] Implementation in `TranscriptViewer.tsx` (do this in the SAME pass as the test edit above — running vitest/typecheck between the two will report `Summary still rendered` or TS errors and is expected). Update the props interface — replace the existing `TranscriptViewerProps` body with:

```tsx
interface TranscriptViewerProps {
  transcript: string
  turns?: Turn[]
  speakerNames?: Record<string, string>
  currentTimeMs?: number
  onSeek: (startMs: number, endMs?: number) => void
  showActionItems?: boolean
  actionItems?: string[]
}
```

Update the function signature — replace the destructured params with (drop `showSummary`, `summary`):

```tsx
export function TranscriptViewer({
  transcript,
  turns,
  speakerNames,
  currentTimeMs,
  onSeek,
  showActionItems = true,
  actionItems
}: TranscriptViewerProps) {
```

Remove the now-unused summary state line `const [summaryExpanded, setSummaryExpanded] = useState(true)` (keep `actionItemsExpanded` and `transcriptExpanded`). Delete the entire Summary JSX block (the `{showSummary && summary && ( … )}` `<div>`, ~238–258), so the returned tree starts with the `{/* Action Items Section */}` block. `useState` import stays (still used by other state).

- [ ] Run it (passes): `cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.test.tsx`. Expected: all cases green, including the new one, and no TS2322 from the removed `showSummary` props (all four deletions done above).

> **Edit-direction note (typecheck ergonomics):** edit `TranscriptViewer.tsx` FIRST (prop removal + state removal + JSX deletion), THEN `SourceReader.tsx` (next steps). Doing it in this order means `typecheck:web` only fails transiently at the `<TranscriptViewer …>` call site in `SourceReader.tsx` until that call is updated — which is the next implementation step. Do NOT run `npm run typecheck` between the `TranscriptViewer.tsx` edit and the `SourceReader.tsx` edit; the cross-file prop break is expected and is resolved by step 5 below. Run the full gate only after both files are done.

- [ ] Write the failing test for the SourceReader summary-at-top in new file `SourceReader.summaryTop.test.tsx`. This stubs `SpeakersPanel`/`TranscriptViewer` (mirroring `SourceReader.speakers.test.tsx`) so we can assert DOM ORDER (summary before the panel/viewer):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceReader } from '../SourceReader'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Transcript } from '@/types'

vi.mock('@radix-ui/react-portal', () => ({
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))
vi.mock('@/components/AudioPlayer', () => ({ AudioPlayer: () => <div data-testid="audio-player" /> }))
vi.mock('@/components/RecordingLinkDialog', () => ({ RecordingLinkDialog: () => null }))
vi.mock('@/components/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
}))
vi.mock('../SpeakersPanel', () => ({
  SpeakersPanel: () => <div data-testid="speakers-panel" />,
}))
vi.mock('../TranscriptViewer', () => ({
  TranscriptViewer: ({ summary }: { summary?: string }) => (
    <div data-testid="transcript-viewer">
      <div data-testid="tv-summary-prop">{summary ?? 'NONE'}</div>
    </div>
  ),
}))

const mockGetForRecording = vi.fn()
const mockGetByRecordingId = vi.fn()
const mockGetSuggestions = vi.fn()

const baseRecording: UnifiedRecording = {
  id: 'rec-1',
  filename: 'meeting.hda',
  size: 1024,
  duration: 60,
  dateRecorded: new Date('2026-06-17T10:00:00Z'),
  transcriptionStatus: 'complete',
  location: 'local-only',
  localPath: '/tmp/meeting.hda',
  syncStatus: 'synced',
} as UnifiedRecording

function makeTranscript(over: Partial<Transcript> = {}): Transcript {
  return {
    id: 't-1',
    recording_id: 'rec-1',
    full_text: 'Some transcript body.',
    summary: 'This is the summary.',
    action_items: null,
    turns: JSON.stringify([{ speaker: 'A', startMs: 0, endMs: 4000, text: 'Hi.' }]),
    ...over,
  } as Transcript
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetForRecording.mockResolvedValue({ success: true, data: {} })
  mockGetByRecordingId.mockResolvedValue(makeTranscript())
  mockGetSuggestions.mockResolvedValue({ success: true, data: [] })
  Object.defineProperty(window, 'electronAPI', {
    value: {
      speakers: { getForRecording: mockGetForRecording, getSuggestions: mockGetSuggestions },
      transcripts: { getByRecordingId: mockGetByRecordingId },
      recordings: { isSummaryStale: vi.fn().mockResolvedValue(false) },
      summarizationTemplates: { latestRun: vi.fn().mockResolvedValue({ success: false }), list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    },
    writable: true,
    configurable: true,
  })
})

describe('SourceReader — summary at top (QOL #5)', () => {
  it('renders the summary block above the SpeakersPanel and does NOT pass summary to TranscriptViewer', async () => {
    render(<SourceReader recording={baseRecording} transcript={makeTranscript()} />)
    const summary = await screen.findByText('This is the summary.')
    expect(summary).toBeInTheDocument()
    // header present
    expect(screen.getByText('Summary')).toBeInTheDocument()
    // ordering: summary appears before BOTH the speakers panel and the transcript viewer
    // (spec places the summary above SpeakersPanel AND TranscriptViewer — assert both so an
    //  implementer cannot wedge the summary between the two and still pass).
    const panel = await screen.findByTestId('speakers-panel')
    const viewer = await screen.findByTestId('transcript-viewer')
    expect(summary.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(summary.compareDocumentPosition(viewer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // TranscriptViewer no longer receives a summary
    expect(screen.getByTestId('tv-summary-prop')).toHaveTextContent('NONE')
  })

  it('renders no Summary block when the transcript has no summary', async () => {
    render(<SourceReader recording={baseRecording} transcript={makeTranscript({ summary: null })} />)
    await screen.findByTestId('transcript-viewer')
    expect(screen.queryByText('Summary')).not.toBeInTheDocument()
  })
})
```

- [ ] Run it (fails): `cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReader.summaryTop.test.tsx`. Expected: the first case fails — `Summary`/`This is the summary.` not found in `SourceReader` (it is still rendered inside the stubbed-away `TranscriptViewer`), and `tv-summary-prop` shows the summary string because `SourceReader` still passes `summary={...}`.

- [ ] Minimal implementation in `SourceReader.tsx`.
  1. Add local state near the other reader state (after the title-editing state, ~line 97): `const [summaryExpanded, setSummaryExpanded] = useState(true)`.
  2. Ensure the lucide import includes `ChevronDown, ChevronRight` — add them to the existing `lucide-react` import line: `import { Calendar, Download, Trash2, Wand2, RefreshCw, Play, Square, Pencil, Check, Edit2, Link, X, ExternalLink, FolderOpen, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'`.
  3. Ensure `Eyebrow` is imported: add `import { Eyebrow } from '@/components/harbor/Eyebrow'` near the other `@/components/harbor` / `@/components` imports.
  4. Inside the scroll area (`<div className="flex-1 overflow-auto p-[var(--space-5)]">`, ~887), within the `{transcript ? ( <> … </> )` branch, insert the summary block AFTER the existing alert banners / `isLoadingSuggestions` block and BEFORE the `{/* Speakers panel … */}` block (i.e. right before `{hasStructuredTurns && (`):

```tsx
            {/* QOL #5: summary moved to the top of the reader (was inside TranscriptViewer). */}
            {transcript.summary && (
              <div className="mb-4">
                <button
                  onClick={() => setSummaryExpanded(!summaryExpanded)}
                  className="flex w-full items-center justify-between rounded-lg border border-border bg-surface-sunken p-3 transition-colors hover:bg-surface-hover"
                  aria-expanded={summaryExpanded}
                >
                  <Eyebrow tone="muted">Summary</Eyebrow>
                  {summaryExpanded ? (
                    <ChevronDown className="h-4 w-4 text-ink-muted" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-ink-muted" />
                  )}
                </button>
                {summaryExpanded && (
                  <div className="mt-2 rounded-lg border border-border bg-surface p-3 shadow-xs">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{transcript.summary}</p>
                  </div>
                )}
              </div>
            )}
```

  5. Update the `<TranscriptViewer … />` call (~968): remove the `showSummary={true}` and `summary={transcript.summary ?? undefined}` lines. The remaining props are `transcript`, `turns`, `speakerNames`, `currentTimeMs`, `onSeek`, `showActionItems={true}`, `actionItems={parseJsonArray<string>(transcript.action_items)}`.

- [ ] Run it (passes): `cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReader.summaryTop.test.tsx`. Expected: both cases green. Then run the full gate: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`. Expected: typecheck node+web clean, lint clean, all tests pass (no other component passes `showSummary`/`summary` to `TranscriptViewer` after this edit — verify by `Grep` for `showSummary` and `summary=` across `src/` if typecheck flags anything).

- [ ] Commit:

```
git add apps/electron/src/features/library/components/TranscriptViewer.tsx apps/electron/src/features/library/components/SourceReader.tsx apps/electron/src/features/library/components/__tests__/TranscriptViewer.test.tsx apps/electron/src/features/library/components/__tests__/SourceReader.summaryTop.test.tsx
git commit -m "$(cat <<'EOF'
feat(electron): move reader summary to top of SourceReader (QOL #5)

Remove the Summary block + showSummary/summary props from TranscriptViewer
and render the summary above SpeakersPanel/TranscriptViewer in SourceReader,
default-expanded, guarded on a non-empty summary.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9
EOF
)"
```

---

### Task 2: Return-to-top button on the transcript scroll container (#1)

Wrap the `TranscriptViewer` inner scroll container (`containerRef`, `max-h-[60vh] overflow-y-auto`) in a `relative` parent `<div>`; track `scrollTop > 300` via a `scroll` listener into a local `showTop` boolean; render an absolutely-positioned button on the PARENT (`absolute bottom-3 right-3`, NOT inside the scrolling child) that smooth-scrolls the container to the top. Works in both timeline and by-speaker views (same container).

**Files:**
- Create: `apps/electron/src/features/library/components/__tests__/transcriptViewerTestUtils.ts` (new — shared fixture; see Global Constraints)
- Modify: `apps/electron/src/features/library/components/TranscriptViewer.tsx`
- Test: `apps/electron/src/features/library/components/__tests__/TranscriptViewer.returnToTop.test.tsx` (new)

**Interfaces:**
- Consumes: the existing `containerRef = useRef<HTMLDivElement>(null)` and `transcriptExpanded` state already in `TranscriptViewer`.
- Produces: local state `const [showTop, setShowTop] = useState(false)`; a `useEffect` that attaches a `scroll` listener to `containerRef.current` setting `setShowTop(el.scrollTop > 300)`; an `ArrowUp`-icon `<button aria-label="Back to top">` rendered on the `relative` parent, hidden when `!showTop`, whose `onClick` calls `containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })`. `RETURN_TO_TOP_THRESHOLD = 300`.
- Icon import: add `ArrowUp` to the existing `lucide-react` import in `TranscriptViewer.tsx`.

**Steps:**

- [ ] Create the shared fixture module `transcriptViewerTestUtils.ts` (used by this task and Task 3). It contains NO `describe`/`it`:

```ts
import { fireEvent, screen } from '@testing-library/react'
import type { Turn } from '../../types/turns'

// Canonical two-speaker fixture: distinct text per turn so per-group visibility
// can be asserted; A appears twice so per-speaker collapse can hide both A lines.
export function makeTwoSpeakerTurns(): Turn[] {
  return [
    { speaker: 'A', startMs: 0, endMs: 4000, text: 'Alpha first line.' },
    { speaker: 'B', startMs: 4000, endMs: 9000, text: 'Bravo first line.' },
    { speaker: 'A', startMs: 9000, endMs: 12000, text: 'Alpha second line.' },
  ]
}

// SegmentedToggle renders each option as <button role="tab">; the explicit
// role="tab" overrides the implicit button role, so query by tab, not button.
export function switchToBySpeaker(): void {
  fireEvent.click(screen.getByRole('tab', { name: /by speaker/i }))
}
```

- [ ] Write the failing test in new file `TranscriptViewer.returnToTop.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TranscriptViewer } from '../TranscriptViewer'
import { makeTwoSpeakerTurns } from './transcriptViewerTestUtils'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('TranscriptViewer — return-to-top (QOL #1)', () => {
  it('hides the button at the top, shows it past the threshold, and scrolls to top on click', () => {
    render(<TranscriptViewer transcript="" turns={makeTwoSpeakerTurns()} onSeek={vi.fn()} />)
    // hidden at scrollTop 0 — conditional render: must be absent from DOM, not just invisible
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument()

    // the scroll container is the element with overflow-y-auto + max-h-[60vh]
    const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
    expect(container).toBeTruthy()
    const scrollTo = vi.fn()
    container.scrollTo = scrollTo as unknown as typeof container.scrollTo

    // simulate scrolling past the 300px threshold
    Object.defineProperty(container, 'scrollTop', { value: 500, configurable: true })
    fireEvent.scroll(container)

    const btn = screen.getByRole('button', { name: /back to top/i })
    expect(btn).toBeInTheDocument()

    fireEvent.click(btn)
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
    // exactly once — a double-fire (two listeners attached via a wrong deps array)
    // would make this fail and surface the bug.
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('hides the button again when scrolled back under the threshold', () => {
    render(<TranscriptViewer transcript="" turns={makeTwoSpeakerTurns()} onSeek={vi.fn()} />)
    const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
    Object.defineProperty(container, 'scrollTop', { value: 500, configurable: true })
    fireEvent.scroll(container)
    expect(screen.getByRole('button', { name: /back to top/i })).toBeInTheDocument()
    Object.defineProperty(container, 'scrollTop', { value: 100, configurable: true })
    fireEvent.scroll(container)
    // conditional render: must be absent from DOM, not just invisible (do NOT switch
    // the implementation to opacity-0/hidden — the spec uses conditional rendering).
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument()
  })
})
```

- [ ] Run it (fails): `cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.returnToTop.test.tsx`. Expected: fails because no `Back to top` button exists.

- [ ] Minimal implementation in `TranscriptViewer.tsx`.
  1. Add `ArrowUp` to the lucide import: `import { ArrowUp, ChevronDown, ChevronRight, ListOrdered, Users } from 'lucide-react'`.
  2. Add module-level constant above the component (after the parse helpers): `const RETURN_TO_TOP_THRESHOLD = 300`.
  3. Add state with the other `useState` calls: `const [showTop, setShowTop] = useState(false)`.
  4. Add an effect (after the existing auto-scroll `useEffect`) that wires the scroll listener. The dependency array is `[transcriptExpanded]` (NOT `[]` and NOT `[viewMode]`) — see the two notes below the snippet:

```tsx
  // QOL #1: show a floating "back to top" control once the transcript scrolls past
  // RETURN_TO_TOP_THRESHOLD. Listener lives on the scroll container (containerRef).
  // Deps = [transcriptExpanded]: containerRef's div only exists while the transcript
  // section is expanded. When collapsed, containerRef.current is null; re-binding on
  // re-expansion re-attaches to the freshly mounted element. Deps must NOT be [] (the
  // listener would never re-attach after a collapse/expand cycle) and need NOT include
  // viewMode (the scroll container is the same element across timeline/by-speaker — the
  // toggle swaps only its children — so the listener stays bound when the view changes).
  useEffect(() => {
    const el = containerRef.current
    if (!el) {
      setShowTop(false)
      return
    }
    const onScroll = () => setShowTop(el.scrollTop > RETURN_TO_TOP_THRESHOLD)
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [transcriptExpanded])
```

> **Deps rationale (do not "simplify" to `[]`):** `containerRef` mounts/unmounts with `transcriptExpanded`. With `[]`, after the user collapses then re-expands the transcript section the listener would silently fail to re-attach and the button would never appear again — a failure the tests above do not exercise (no test cycles `transcriptExpanded`). Conversely, do NOT add `viewMode` to the deps: the same scroll container element backs both timeline and by-speaker views (the `SegmentedToggle` only swaps the container's children), so the listener stays bound across a view switch and re-binding on `viewMode` would be churn.

  5. Wrap the existing scroll container so the button anchors to a `relative` parent (NOT the scrolling child). Replace the current opening of the transcript-body block:

```tsx
        {transcriptExpanded && (
          <div ref={containerRef} className="mt-2 max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-surface p-3 shadow-xs">
```

with:

```tsx
        {transcriptExpanded && (
          <div className="relative">
            <div ref={containerRef} className="mt-2 max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-surface p-3 shadow-xs">
```

  6. Find the matching close of that scroll container (the `</div>` that currently closes the `ref={containerRef}` div, just before the `)}` that ends `{transcriptExpanded && (…)}`). Add the button and the wrapper's closing `</div>` there. The end of the transcript-body block currently reads:

```tsx
            ) : (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{transcript}</p>
            )}
          </div>
        )}
```

Replace it with:

```tsx
            ) : (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{transcript}</p>
            )}
            </div>
            {showTop && (
              <button
                type="button"
                aria-label="Back to top"
                title="Back to top"
                onClick={() => containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface shadow-md transition-colors hover:bg-surface-hover"
              >
                <ArrowUp className="h-4 w-4 text-ink-muted" />
              </button>
            )}
          </div>
        )}
```

  (Net: one extra `</div>` closes the inner scroll container before the button; the final `</div>` closes the new `relative` wrapper.)

- [ ] Run it (passes): `cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.returnToTop.test.tsx`. Expected: both cases green. Also re-run the existing viewer test to confirm no regression: `cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.test.tsx`.

- [ ] Commit:

```
git add apps/electron/src/features/library/components/TranscriptViewer.tsx apps/electron/src/features/library/components/__tests__/TranscriptViewer.returnToTop.test.tsx apps/electron/src/features/library/components/__tests__/transcriptViewerTestUtils.ts
git commit -m "$(cat <<'EOF'
feat(electron): add return-to-top control to transcript scroll (QOL #1)

Wrap the transcript scroll container in a relative parent and pin an
ArrowUp button (bottom-right) that appears past 300px of scroll and
smooth-scrolls the container to the top. Works in both views.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9
EOF
)"
```

---

### Task 3: Per-speaker collapse in the By-Speaker view (#2)

Add a chevron toggle to each By-Speaker card header (avatar + name + stats row). Collapsing hides that speaker's per-speaker turn list (and its talk-time bar — see the note below); the header row stays visible. State: a local `Set<string>` of collapsed `g.key`s (default empty = all expanded). Other speakers are unaffected.

> **Deliberate deviation from spec 4.3 / AC3 (documented):** the spec wording says collapsing hides "only that speaker's turn list." This plan collapses BOTH the per-speaker turn list AND that card's talk-time bar under one `{!collapsed && (…)}` guard. Rationale: the talk-time bar is a stats decoration that reads as noise on a collapsed card, and keeping it visible while the list is hidden looks broken (a lone bar under a stats line). The card header (avatar + name + segment/percent stats) stays visible when collapsed, which preserves the AC3 intent — the speaker is still identifiable and the header row remains. If a reviewer insists on the literal reading, move the talk-time bar `<div>` above the `{!collapsed && (` guard; the test below does not assert on the bar so either layout passes.

**Files:**
- Modify: `apps/electron/src/features/library/components/TranscriptViewer.tsx`
- Test: `apps/electron/src/features/library/components/__tests__/TranscriptViewer.perSpeakerCollapse.test.tsx` (new)
- Reuse: `apps/electron/src/features/library/components/__tests__/transcriptViewerTestUtils.ts` (created in Task 2)

**Interfaces:**
- Consumes: the existing `speakerGroups.groups` array (each item has `key`, `name`, `color`, `segments`, `durationMs`, `segCount`, `pct`); per-card markup ~401–437.
- Produces: local state `const [collapsedSpeakers, setCollapsedSpeakers] = useState<Set<string>>(new Set())`; a `toggleSpeaker(key: string)` helper that clones the set and adds/removes `key`; a chevron `<button aria-expanded={!collapsed}>` in each card header; the per-speaker turn list (`<div className="flex flex-col gap-2">…`) rendered only when `!collapsedSpeakers.has(g.key)`.
- Reuses `ChevronDown`/`ChevronRight` already imported in `TranscriptViewer.tsx`.

**Steps:**

- [ ] Write the failing test in new file `TranscriptViewer.perSpeakerCollapse.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TranscriptViewer } from '../TranscriptViewer'
import { makeTwoSpeakerTurns, switchToBySpeaker } from './transcriptViewerTestUtils'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('TranscriptViewer — per-speaker collapse (QOL #2)', () => {
  it('shows each speaker turn list by default, hides only the toggled speaker, keeps the header', () => {
    render(<TranscriptViewer transcript="" turns={makeTwoSpeakerTurns()} onSeek={vi.fn()} />)
    // switchToBySpeaker() queries getByRole('tab', …): SegmentedToggle options are
    // role="tab", NOT button, so a getByRole('button', …) query would throw here.
    switchToBySpeaker()

    // both speakers' turns visible by default
    expect(screen.getByText('Alpha first line.')).toBeInTheDocument()
    expect(screen.getByText('Alpha second line.')).toBeInTheDocument()
    expect(screen.getByText('Bravo first line.')).toBeInTheDocument()

    // collapse speaker A (the per-card chevron IS a real <button>, so getByRole button is correct here)
    fireEvent.click(screen.getByRole('button', { name: /collapse speaker a/i }))

    // Assertions ordered content-gone → UI-state-updated so a failure pinpoints the cause:
    // both A turns must be ABSENT from the DOM (conditional render, not hidden) ...
    expect(screen.queryByText('Alpha first line.')).not.toBeInTheDocument()
    expect(screen.queryByText('Alpha second line.')).not.toBeInTheDocument()
    // B is unaffected ...
    expect(screen.getByText('Bravo first line.')).toBeInTheDocument()
    // ... and finally the header chevron re-labels to "expand" (a failure here is a labeling bug,
    // not a render bug).
    expect(screen.getByRole('button', { name: /expand speaker a/i })).toBeInTheDocument()
  })
})
```

- [ ] Run it (fails): `cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.perSpeakerCollapse.test.tsx`. Expected: fails — no `collapse speaker a` button exists; the turn lists are always rendered. (If `switchToBySpeaker` cannot find the `By speaker` tab, the fixture/`turns` shape is wrong — `makeTwoSpeakerTurns` has two distinct speakers so `canGroupBySpeaker` is true and the toggle renders.)

- [ ] Minimal implementation in `TranscriptViewer.tsx`.
  1. Add state with the other `useState` calls: `const [collapsedSpeakers, setCollapsedSpeakers] = useState<Set<string>>(new Set())`.
  2. Add a toggle helper inside the component body (e.g. after the `speakerGroups` memo):

```tsx
  const toggleSpeaker = (key: string) => {
    setCollapsedSpeakers((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
```

  3. In the per-speaker card (the `speakerGroups.groups.map((g) => ( … ))` block, ~401), capture the collapsed flag and add a chevron button to the header, then guard the turn list. Replace the card body from the header through the turn list. The current card is:

```tsx
                    {speakerGroups.groups.map((g) => (
                      <div key={g.key} className="rounded-lg border border-border bg-surface p-3 shadow-xs">
                        <div className="mb-3 flex items-center gap-3">
                          <PersonAvatar name={g.name} color={g.color} size={30} />
                          <div className="min-w-0 flex-1">
                            <span className="font-display text-[1.125rem] font-semibold tracking-[-0.01em] text-ink">
                              {g.name}
                            </span>
                            <div className="mt-0.5 font-mono text-[11px] text-ink-muted">
                              {formatTimestamp(g.durationMs / 1000)} · {g.segCount} segment{g.segCount === 1 ? '' : 's'} · {Math.round(g.pct * 100)}%
                            </div>
                          </div>
                        </div>
                        {/* per-speaker talk-time bar */}
                        <div className="mb-3.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.max(g.pct * 100, 1)}%`, background: g.color }}
                          />
                        </div>
                        <div className="flex flex-col gap-2">
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
                        </div>
                      </div>
                    ))}
```

Replace it with:

```tsx
                    {speakerGroups.groups.map((g) => {
                      const collapsed = collapsedSpeakers.has(g.key)
                      return (
                      <div key={g.key} className="rounded-lg border border-border bg-surface p-3 shadow-xs">
                        <div className="mb-3 flex items-center gap-3">
                          <PersonAvatar name={g.name} color={g.color} size={30} />
                          <div className="min-w-0 flex-1">
                            <span className="font-display text-[1.125rem] font-semibold tracking-[-0.01em] text-ink">
                              {g.name}
                            </span>
                            <div className="mt-0.5 font-mono text-[11px] text-ink-muted">
                              {formatTimestamp(g.durationMs / 1000)} · {g.segCount} segment{g.segCount === 1 ? '' : 's'} · {Math.round(g.pct * 100)}%
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => toggleSpeaker(g.key)}
                            aria-expanded={!collapsed}
                            aria-label={`${collapsed ? 'Expand' : 'Collapse'} speaker ${g.name}`}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-surface-hover"
                          >
                            {collapsed ? (
                              <ChevronRight className="h-4 w-4 text-ink-muted" />
                            ) : (
                              <ChevronDown className="h-4 w-4 text-ink-muted" />
                            )}
                          </button>
                        </div>
                        {!collapsed && (
                          <>
                            {/* per-speaker talk-time bar */}
                            <div className="mb-3.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                              <div
                                className="h-full rounded-full"
                                style={{ width: `${Math.max(g.pct * 100, 1)}%`, background: g.color }}
                              />
                            </div>
                            <div className="flex flex-col gap-2">
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
                            </div>
                          </>
                        )}
                      </div>
                      )
                    })}
```

  Note the `aria-label` uses `g.name`; the test's turns have no `speakerNames` so `g.name` falls back to the key (`A`/`B`), matching `/collapse speaker a/i` (case-insensitive). When names are assigned the label reads e.g. "Collapse speaker Alice" — still accessible.

- [ ] Run it (passes): `cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.perSpeakerCollapse.test.tsx`. Expected: green. Re-run the existing viewer test + the return-to-top test to confirm no regression: `cd apps/electron && npx vitest run src/features/library/components/__tests__/TranscriptViewer.test.tsx src/features/library/components/__tests__/TranscriptViewer.returnToTop.test.tsx`.

- [ ] Commit:

```
git add apps/electron/src/features/library/components/TranscriptViewer.tsx apps/electron/src/features/library/components/__tests__/TranscriptViewer.perSpeakerCollapse.test.tsx
git commit -m "$(cat <<'EOF'
feat(electron): collapsible per-speaker cards in by-speaker view (QOL #2)

Each by-speaker card header gets a chevron that collapses only that
speaker's turn list (local Set keyed on g.key, default expanded). Header
stays visible; other speakers unaffected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9
EOF
)"
```

---

### Task 4: Collapsible Speakers panel (#3)

Turn the `SpeakersPanel` `Speakers` header row into a chevron toggle (local `useState(true)`, default expanded). Collapsing hides the panel body (the voice-memory notice + per-label rows + per-turn reassign list + dialogs trigger area); the header — including the "Dismiss all suggestions" button when suggestions exist — stays visible.

**Files:**
- Create: `apps/electron/src/features/library/components/__tests__/speakersPanelTestUtils.ts` (new — shared mocks/fixture; see Global Constraints)
- Modify: `apps/electron/src/features/library/components/SpeakersPanel.tsx`
- Test: `apps/electron/src/features/library/components/__tests__/SpeakersPanel.collapse.test.tsx` (new)

**Interfaces:**
- Consumes: existing `visibleSuggestions`, `busy`, `dismissAllSuggestions`, `labels` already in scope.
- Produces: local state `const [panelExpanded, setPanelExpanded] = useState(true)`; the existing header row (`<div className="flex items-center justify-between"> <Eyebrow tone="muted">Speakers</Eyebrow> … </div>`) gains a chevron toggle button, and everything below the header is wrapped/guarded by `{panelExpanded && ( … )}`.
- Reuses `ChevronDown`/`ChevronRight` already imported in `SpeakersPanel.tsx`.

**Steps:**

- [ ] Create the shared mocks/fixture module `speakersPanelTestUtils.ts` (used by this task and Task 5). It contains NO `describe`/`it`. `setupSpeakersPanelMocks()` is the single update point if the `electronAPI` shape changes:

```ts
import { vi } from 'vitest'
import { useConfigStore } from '@/store/domain/useConfigStore'
import type { Turn } from '../../types/turns'

export function makeTurns(): Turn[] {
  return [
    { speaker: 'A', startMs: 0, endMs: 5000, text: 'Hello there.' },
    { speaker: 'B', startMs: 5000, endMs: 8000, text: 'Hi.' },
  ]
}

// Stubs window.electronAPI + resets useConfigStore. Call in beforeEach AFTER
// vi.clearAllMocks(). config:null leaves voiceprint capture disabled, so the
// "Voice memory is off …" notice renders as part of the panel body.
export function setupSpeakersPanelMocks(): void {
  useConfigStore.setState({ config: null })
  Object.defineProperty(window, 'electronAPI', {
    value: {
      contacts: {
        getForMeeting: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getAll: vi.fn().mockResolvedValue({ success: true, data: { contacts: [], total: 0 } }),
        create: vi.fn(),
      },
      speakers: {
        assign: vi.fn(), unassign: vi.fn(), merge: vi.fn(),
        getSuggestions: vi.fn(), dismissSuggestion: vi.fn(), acceptSuggestion: vi.fn(), setSelf: vi.fn(),
      },
      transcripts: { updateTurns: vi.fn() },
      voiceprints: { findBySource: vi.fn(), delete: vi.fn() },
      onVoiceprintCaptured: vi.fn(() => vi.fn()),
    },
    writable: true,
    configurable: true,
  })
}
```

> The `toast` mock (`vi.mock('@/components/ui/toaster', …)`) must stay in each test file's top-level module scope — `vi.mock` is hoisted per-file and cannot live in a helper. Only the `window`/store setup is shared.

- [ ] Write the failing test in new file `SpeakersPanel.collapse.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SpeakersPanel } from '../SpeakersPanel'
import { setupSpeakersPanelMocks, makeTurns } from './speakersPanelTestUtils'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  setupSpeakersPanelMocks()
})

describe('SpeakersPanel — collapsible panel (QOL #3)', () => {
  it('shows the body by default, hides it after toggling, keeps the header', async () => {
    render(
      <SpeakersPanel
        recordingId="rec-1"
        meetingId="meet-1"
        turns={makeTurns()}
        // Pass an assigned speaker so this collapse test also smoke-exercises the
        // Task-5 resolveName path (a crash in resolveName would surface here too).
        assignedSpeakers={{ A: { contactId: 'c-1', contactName: 'Alice' } }}
        assignedNames={{ A: 'Alice' }}
        onChanged={vi.fn()}
      />
    )
    // body visible: one assign control per label, plus the voice-memory notice
    expect(await screen.findByRole('button', { name: /assign contact to a/i })).toBeInTheDocument()
    expect(screen.getByText(/voice memory is off/i)).toBeInTheDocument()

    // toggle the panel collapsed
    fireEvent.click(screen.getByRole('button', { name: /collapse speakers panel/i }))

    // body hidden — assert TWO structurally distinct body elements are gone (the per-label
    // assign button AND the voice-memory notice) so a partial-collapse bug is caught.
    expect(screen.queryByRole('button', { name: /assign contact to a/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/voice memory is off/i)).not.toBeInTheDocument()
    // header remains (now an "expand" toggle)
    expect(screen.getByRole('button', { name: /expand speakers panel/i })).toBeInTheDocument()
    expect(screen.getByText('Speakers')).toBeInTheDocument()
  })
})
```

- [ ] Run it (fails): `cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.collapse.test.tsx`. Expected: fails — no `collapse speakers panel` toggle, body always rendered.

- [ ] Minimal implementation in `SpeakersPanel.tsx`.
  1. Add state with the other `useState` calls (near `turnsExpanded`, ~134): `const [panelExpanded, setPanelExpanded] = useState(true)`.
  2. Replace the header row (~510–517) and wrap the body. The current return opens:

```tsx
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Eyebrow tone="muted">Speakers</Eyebrow>
        {visibleSuggestions.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void dismissAllSuggestions()} disabled={busy}>
            Dismiss all suggestions
          </Button>
        )}
      </div>
      {!enableVoiceprintCapture && (
```

Replace the header `<div>` with one that includes the chevron toggle, and open a `{panelExpanded && (` wrapper just before the voice-memory notice:

```tsx
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setPanelExpanded((v) => !v)}
          aria-expanded={panelExpanded}
          aria-label={`${panelExpanded ? 'Collapse' : 'Expand'} speakers panel`}
          className="flex items-center gap-2 rounded-sm transition-colors hover:bg-surface-hover"
        >
          <Eyebrow tone="muted">Speakers</Eyebrow>
          {panelExpanded ? (
            <ChevronDown className="h-4 w-4 text-ink-muted" />
          ) : (
            <ChevronRight className="h-4 w-4 text-ink-muted" />
          )}
        </button>
        {visibleSuggestions.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void dismissAllSuggestions()} disabled={busy}>
            Dismiss all suggestions
          </Button>
        )}
      </div>
      {panelExpanded && (
      <>
      {!enableVoiceprintCapture && (
```

  3. Close the `{panelExpanded && (<> … </>)}` wrapper just before the dialogs. The body currently ends and the dialogs begin like this:

```tsx
      {/* Per-turn reassign (AC3): change one turn's speaker to another existing label.
          Collapsible — the list is long on real recordings. */}
      {!readOnly && turns.length > 0 && (
        <div className="space-y-1.5">
          …
        </div>
      )}

      <AlertDialog open={unbankDialogOpen} onOpenChange={setUnbankDialogOpen}>
```

Insert the closing `</>)}` after the per-turn reassign block's closing `)}` and before `<AlertDialog open={unbankDialogOpen}`:

```tsx
      {/* Per-turn reassign (AC3): change one turn's speaker to another existing label.
          Collapsible — the list is long on real recordings. */}
      {!readOnly && turns.length > 0 && (
        <div className="space-y-1.5">
          …
        </div>
      )}
      </>
      )}

      <AlertDialog open={unbankDialogOpen} onOpenChange={setUnbankDialogOpen}>
```

  (The dialogs stay outside the collapse so an in-flight un-bank/merge-warning dialog isn't unmounted by collapsing the panel.)

- [ ] Run it (passes): `cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.collapse.test.tsx`. Expected: green. Re-run the existing panel test to confirm no regression: `cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.test.tsx`.

- [ ] Commit:

```
git add apps/electron/src/features/library/components/SpeakersPanel.tsx apps/electron/src/features/library/components/__tests__/SpeakersPanel.collapse.test.tsx apps/electron/src/features/library/components/__tests__/speakersPanelTestUtils.ts
git commit -m "$(cat <<'EOF'
feat(electron): make the Speakers panel collapsible (QOL #3)

Header row gets a chevron toggle (local state, default expanded) that
hides the panel body; the header and Dismiss-all-suggestions button stay
visible. Dialogs remain mounted outside the collapse.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9
EOF
)"
```

---

### Task 5: Assigned names at the Speakers-panel label sites (#4)

Add a `resolveName(label)` helper resolving an assigned contact name; at each raw-label site (assignment chip, merge dialog options, per-turn reassign list, reassign dialog options), render the name as primary with the raw letter as a small muted tag when a name exists, else the letter alone. Transcript Timeline/By-Speaker views already resolve names — do NOT touch them.

> **CRITICAL naming constraint (verified against source):** `SpeakersPanel.tsx` ALREADY declares, inside `labels.map(({ label, … }) => { … })` (~525–526), a per-row `const assignedName = assignment?.contactName ?? assignedNames?.[label]` and `const displayName = assignedName ?? label` (a STRING used in the jump-button aria-label/title at ~549–550). The new helper therefore MUST be named `resolveName`, NOT `displayName` — a component-scope `const displayName = (label) => …` function would (a) collide with the per-row `const displayName` string inside the map (shadowing → `displayName(label)` would be calling a string), and (b) fail typecheck. The new `resolveName` function lives at component scope and is referenced ONLY at the sites OUTSIDE `labels.map` (merge dialog ~680, per-turn reassign ~817, reassign dialog ~840). The two sites INSIDE `labels.map` (assignment chip ~554/557) already have the per-row `assignedName` string in scope and reuse THAT — no `resolveName` call there. The popover confirmation (~595) is left unchanged (the name already shows in the avatar header directly above it; see step 4 of the implementation).

> **Duplicate-badge fix (Finding):** the existing stat-line badge `{assignedName && <span className="ml-2 font-medium text-ink">→ {assignedName}</span>}` (~563) renders the assigned name a SECOND time once the chip leads with the name. Remove that line-563 badge in this task so the name is not duplicated in the row (which would also break a `getByText('Alice')` single-match assumption).

**Files:**
- Modify: `apps/electron/src/features/library/components/SpeakersPanel.tsx`
- Test: `apps/electron/src/features/library/components/__tests__/SpeakersPanel.names.test.tsx` (new)
- Reuse: `apps/electron/src/features/library/components/__tests__/speakersPanelTestUtils.ts` (created in Task 4)

**Interfaces:**
- Consumes: props `assignedNames?: Record<string, string>` and `assignedSpeakers?: Record<string, { contactId: string; contactName: string }>` (already on `SpeakersPanelProps`); the existing per-row `assignedName` string inside `labels.map`.
- Produces: helper `const resolveName = (label: string): string | null => assignedSpeakers?.[label]?.contactName ?? assignedNames?.[label] ?? null` defined inside the component (after the `labels` memo / `readOnly` line). Name-leading render rule: when a name exists, render the name as primary text + the raw letter in a small muted `font-mono` tag carrying `data-testid="speaker-letter-tag"`; else render the letter alone.
- The sites (current raw markup → name-leading markup): assignment chip `{label}` (the `<span className="w-8 …">{label}</span>` in the jump button AND the non-jump fallback span, ~554/557 — use the per-row `assignedName`); REMOVE the stat-line `→ {assignedName}` badge (~563); merge dialog option `Merge into {target.label}` (~680 — use `resolveName`); per-turn reassign label `{t.speaker}` (~817 — use `resolveName`); reassign dialog option `Reassign to {target.label}` (~840 — use `resolveName`). The popover confirmation (~595) is unchanged.

**Steps:**

- [ ] Write the failing test in new file `SpeakersPanel.names.test.tsx`. This is a concrete RED: pre-implementation the assignment chip renders the bare letter `A` as the primary `w-8` mono span and there is no `speaker-letter-tag` element, so `getByTestId('speaker-letter-tag')` THROWS (RED). The duplicate stat-line `→ Alice` badge is removed in this task, so after implementation `Alice` appears exactly once in the chip:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { SpeakersPanel } from '../SpeakersPanel'
import { setupSpeakersPanelMocks, makeTurns } from './speakersPanelTestUtils'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  setupSpeakersPanelMocks()
})

describe('SpeakersPanel — assigned names at label sites (QOL #4)', () => {
  it('shows the assigned name leading a muted letter tag for an assigned speaker, letter for unassigned', async () => {
    render(
      <SpeakersPanel
        recordingId="rec-1"
        meetingId="meet-1"
        turns={makeTurns()}
        assignedSpeakers={{ A: { contactId: 'c-1', contactName: 'Alice' } }}
        assignedNames={{ A: 'Alice' }}
        onChanged={vi.fn()}
      />
    )
    // A is assigned -> the name leads in the chip (exactly once now that the
    // redundant stat-line badge is removed).
    const alice = await screen.findByText('Alice')
    expect(alice).toBeInTheDocument()

    // The raw letter is rendered as a dedicated muted tag (stable testid, not a
    // className sniff). There may be more than one such tag across the panel;
    // assert at least one exists and carries the letter 'A'.
    const letterTags = screen.getAllByTestId('speaker-letter-tag')
    expect(letterTags.length).toBeGreaterThan(0)
    const aTag = letterTags.find((n) => n.textContent === 'A')
    expect(aTag).toBeTruthy()

    // Ordering: within the chip, the name precedes the muted letter tag.
    // (name node comes BEFORE the letter tag in document order)
    expect(alice.compareDocumentPosition(aTag!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // B is unassigned -> shows the bare letter and the assign control keyed on the letter.
    expect(screen.getByRole('button', { name: /assign contact to b/i })).toBeInTheDocument()
    // 'Alice' must NOT appear as a standalone second node (no duplicate badge).
    expect(screen.getAllByText('Alice')).toHaveLength(1)
  })
})
```

- [ ] Run it (fails): `cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.names.test.tsx`. Expected: RED — `getAllByTestId('speaker-letter-tag')` throws "Unable to find an element by: [data-testid='speaker-letter-tag']" because the muted letter tag does not exist yet (the chip renders the bare `{label}` span). The `getAllByText('Alice')` length check would also fail today because the stat-line `→ Alice` badge is still present (two matches).

- [ ] Minimal implementation in `SpeakersPanel.tsx`.
  1. Add the helper `resolveName` (NOT `displayName` — see the CRITICAL naming constraint above) at component scope, after the `labels` memo / `readOnly` line (~179):

```tsx
  // QOL #4: resolve an assigned contact name for a diarization label, or null.
  // Named resolveName to avoid colliding with the per-row `const displayName`
  // string declared inside labels.map (~526).
  const resolveName = (label: string): string | null =>
    assignedSpeakers?.[label]?.contactName ?? assignedNames?.[label] ?? null
```

  2. Assignment chip — the per-row letter span(s) INSIDE `labels.map`. These sites already have the per-row `assignedName` string (`const assignedName = assignment?.contactName ?? assignedNames?.[label]`, ~525) in scope; reuse it (do NOT call `resolveName` here — `assignedName` is identical and avoids re-resolving). The jump-button variant currently is `<span className="w-8 shrink-0 font-mono text-[13px] font-semibold text-ink group-hover/jump:text-accent-2">{label}</span>` (~554); replace it with:

```tsx
                  <span className="flex shrink-0 items-center gap-1 font-semibold text-ink group-hover/jump:text-accent-2">
                    {assignedName ? (
                      <>
                        <span className="text-[13px]">{assignedName}</span>
                        <span data-testid="speaker-letter-tag" className="font-mono text-[11px] text-ink-muted">{label}</span>
                      </>
                    ) : (
                      <span className="w-8 font-mono text-[13px]">{label}</span>
                    )}
                  </span>
```

  The non-jump fallback span (~557) currently is `<span className="w-8 shrink-0 font-mono text-[13px] font-semibold text-ink">{label}</span>`; replace it with:

```tsx
                <span className="flex shrink-0 items-center gap-1 font-semibold text-ink">
                  {assignedName ? (
                    <>
                      <span className="text-[13px]">{assignedName}</span>
                      <span data-testid="speaker-letter-tag" className="font-mono text-[11px] text-ink-muted">{label}</span>
                    </>
                  ) : (
                    <span className="w-8 font-mono text-[13px]">{label}</span>
                  )}
                </span>
```

  3. Remove the redundant stat-line badge (~563): delete the line `{assignedName && <span className="ml-2 font-medium text-ink">→ {assignedName}</span>}` entirely. The chip now leads with the name, so this second copy is a duplicate (and would break the `getAllByText('Alice')` single-match assertion).

  4. Popover confirmation `Assigned to {label}` (~595) — UNCHANGED. The name already appears in the avatar header directly above this line (`{assignedName && (<div …><PersonAvatar …/><div>{assignedName}</div><div>Assigned to {label}</div></div>)}`), so the relationship is already clear. Touching it adds churn with no spec benefit.

  5. Merge dialog option `Merge into {target.label}` (~680, OUTSIDE `labels.map` — use `resolveName`). Replace the button body:

```tsx
                      {resolveName(target.label)
                        ? `Merge into ${resolveName(target.label)} (${target.label})`
                        : `Merge into ${target.label}`}
```

  Keep the `aria-label={`Merge into ${target.label}`}` unchanged (existing tests/labels key on the letter).

  6. Per-turn reassign list `{t.speaker}` (~817, OUTSIDE `labels.map` — use `resolveName`). Replace the `<span className="w-6 shrink-0 font-mono text-xs font-semibold text-ink">{t.speaker}</span>` with:

```tsx
              <span className="flex w-auto shrink-0 items-center gap-1 text-xs font-semibold text-ink">
                {resolveName(t.speaker) ? (
                  <>
                    <span>{resolveName(t.speaker)}</span>
                    <span data-testid="speaker-letter-tag" className="font-mono text-ink-muted">{t.speaker}</span>
                  </>
                ) : (
                  <span className="w-6 font-mono">{t.speaker}</span>
                )}
              </span>
```

  7. Reassign dialog option `Reassign to {target.label}` (~840, OUTSIDE `labels.map` — use `resolveName`). Replace the button body:

```tsx
                        {resolveName(target.label)
                          ? `Reassign to ${resolveName(target.label)} (${target.label})`
                          : `Reassign to ${target.label}`}
```

  Keep `aria-label={`Reassign to ${target.label}`}` unchanged.

- [ ] Run it (passes): `cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.names.test.tsx`. Expected: green. Re-run the existing panel test + the collapse test from Task 4 to confirm no regression (existing tests key assign/merge/reassign on the LETTER via aria-labels, which are unchanged): `cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.test.tsx src/features/library/components/__tests__/SpeakersPanel.collapse.test.tsx`.

- [ ] Run the full gate: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`. Expected: typecheck node+web clean, lint clean, ALL tests pass (this is the last task; the full suite must be green).

- [ ] Commit:

```
git add apps/electron/src/features/library/components/SpeakersPanel.tsx apps/electron/src/features/library/components/__tests__/SpeakersPanel.names.test.tsx
git commit -m "$(cat <<'EOF'
feat(electron): show assigned names at Speakers-panel label sites (QOL #4)

Add resolveName(label) and render the assigned contact name as primary
with a muted letter tag (data-testid=speaker-letter-tag) at the chip,
merge options, per-turn reassign list, and reassign options; unassigned
shows the letter. Remove the redundant stat-line name badge so the name
is not duplicated. Transcript views already map names — unchanged.
aria-labels keep the letter.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9
EOF
)"
```

---

## Sequencing notes

- Run tasks in order 1 → 5. Tasks 1–3 all touch `TranscriptViewer.tsx` (and Task 1 also `SourceReader.tsx`); they are ordered adjacently and each re-runs the prior viewer tests to catch regressions. Tasks 4–5 both touch `SpeakersPanel.tsx` and are ordered adjacently.
- Only the final task (Task 5) is required to run the full `npm run test:run` suite green; intermediate tasks run focused vitest plus the touched-file regressions, but each task MUST still pass `npm run typecheck` before its commit (the cheapest way: run the full gate at each task end — it is fast enough and catches cross-file prop breakage from Task 1).
- **Task 1 edit order:** edit `TranscriptViewer.tsx` (+ its test) BEFORE `SourceReader.tsx`. Do not run `npm run typecheck` between the two file edits — the `<TranscriptViewer>` call site in `SourceReader.tsx` will transiently fail until updated (this is expected; see the edit-direction note inside Task 1).
- **Task 5 depends on Task 4 being green first:** Task 5 edits the same `labels.map` row markup and header area as Task 4's collapse. Before starting Task 5, run Task 4's full suite — `cd apps/electron && npx vitest run src/features/library/components/__tests__/SpeakersPanel.collapse.test.tsx src/features/library/components/__tests__/SpeakersPanel.test.tsx` — as a regression gate. In particular, if Task 5 inadvertently restructures the header row, Task 4's `getByRole('button', { name: /collapse speakers panel/i })` could break; re-running Task 4's tests after the Task 5 edits (and before commit) catches it. The Task 5 "Run it (passes)" step already re-runs both `SpeakersPanel.test.tsx` and `SpeakersPanel.collapse.test.tsx`.
- **Shared test-util creation order:** `transcriptViewerTestUtils.ts` is created in Task 2 and imported by Task 3; `speakersPanelTestUtils.ts` is created in Task 4 and imported by Task 5. Each is created in the first task that consumes it, so no task imports a not-yet-created module.
