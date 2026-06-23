# Reader Quality-of-Life Improvements — Design

**Date:** 2026-06-22
**App:** `apps/electron` (universal knowledge hub)
**Status:** proposed / approved for planning

## 1. Request in one sentence

Five focused quality-of-life tweaks to the Library reader's transcript experience: a return-to-top button, per-speaker collapse in the By-Speaker view, a collapsible Speakers panel, assigned-name display in the Speakers panel, and moving the summary to the top.

## 2. Scope

**In scope:** UI-only changes to three existing components — `SourceReader.tsx`, `TranscriptViewer.tsx`, `SpeakersPanel.tsx`. No backend, IPC, DB, or data-model changes. No new dependencies.

**Out of scope:** moving action items (only the summary moves); persisting collapse state across recordings/sessions; virtualizing the transcript; any change to how speaker names are assigned or stored; the separate stale-detail-pane refresh bug (tracked elsewhere).

## 3. Current-state anchors

(Line numbers approximate; re-locate during implementation.)

- **`apps/electron/src/features/library/components/SourceReader.tsx`** — top-to-bottom: metadata header (~434–602); action buttons (~605–877); sticky audio player (~879–884); then a single scrollable content area `overflow-auto` (~886) containing: staleness/error/suggestion alert banners, the loading indicator, **`SpeakersPanel`** (~944–955, rendered when `hasStructuredTurns`), the template chip, and **`TranscriptViewer`**.
- **`apps/electron/src/features/library/components/TranscriptViewer.tsx`** — renders a **Summary** collapsible block (~238–257), an **Action items** block, and the **Transcript**. The transcript has its own inner scroll container `ref={containerRef}` with `max-h-[60vh] overflow-y-auto` (~302). A `SegmentedToggle` switches `viewMode` between `'timeline'` and `'by-speaker'` (~306–319, shown only when `canGroupBySpeaker`). `speakerGroups` is derived via `useMemo` (~182–216); By-Speaker cards render at ~376–439, each with a header (avatar + `g.name` + stats) and a per-speaker turn list (~421–435). Timeline already resolves the display label: `speakerNames?.[segment.speaker] ?? segment.speaker` (~326–328); By-Speaker already uses `g.name = speakerNames?.[key] ?? key` (~203).
- **`apps/electron/src/features/library/components/SpeakersPanel.tsx`** — header is an `Eyebrow tone="muted">Speakers` inside a `flex items-center justify-between` row (~508–517). Raw diarization labels are shown at: the assignment chip button `{label}` (~554), the popover confirmation `Assigned to {label}` (~595), the merge dialog `Merge into {target.label}` (~680), the per-turn reassign list `{t.speaker}` (~817), and the reassign dialog `Reassign to {target.label}` (~840). Assigned names arrive as props `assignedNames: Record<string,string>` and `assignedSpeakers: Record<string,{contactId,contactName}>`.
- **Existing collapse pattern (reuse, do not add a dependency):** `useState(boolean)` + a full-width header button (`flex w-full items-center justify-between rounded-lg border border-border bg-surface-sunken p-3`) + `ChevronDown`/`ChevronRight` from lucide + `aria-expanded`, with the body conditionally rendered. Live examples: TranscriptViewer Summary (state ~150, markup ~240–257) and SpeakersPanel Turns (state ~134, markup ~797–810).
- **Speaker name source:** `SourceReader` fetches `speakerNames` via `window.electronAPI.speakers.getForRecording(recordingId)` and passes it down; it is empty until that async resolves.

## 4. Design

All five changes reuse the existing collapse pattern and local component state. No `useLibraryStore` changes — collapse state is local to the open reader and resets when a different recording is opened (default expanded). No new deps.

### 4.1 #5 — Move the summary to the top

- **Remove** the Summary block from `TranscriptViewer` (drop its `summary`/`showSummary` rendering and the corresponding props). Action items and the transcript remain in `TranscriptViewer`.
- **Render** the summary in `SourceReader`, at the top of the scroll area — above the `SpeakersPanel` and `TranscriptViewer`. The existing staleness/error/suggestion alert banners remain above the summary (they are conditional alerts). `SourceReader` already has the transcript/summary data it currently passes down, so it can render the summary directly.
- Keep the summary's collapsible header (`Summary` Eyebrow + chevron), default **expanded**. Extract the summary markup into a small local block/component to keep `SourceReader` readable.
- Only render the summary block when a summary exists (mirror the current `showSummary`/non-empty guard).

### 4.2 #1 — Return-to-top button (transcript)

- A floating button anchored bottom-right that stays **pinned** while the transcript scrolls. Wrap the existing `max-h-[60vh] overflow-y-auto` container (`containerRef`) in a `relative` parent `<div>` and position the button on that **parent** (`absolute bottom-3 right-3`), NOT inside the scrolling element — an `absolute`/static child of the scroll container would scroll away with the content. The button overlays the bottom-right of the transcript box.
- **Visibility:** shown only when `containerRef.current.scrollTop > 300`; tracked via a `scroll` listener on the container updating a local `showTop` boolean (throttled with `requestAnimationFrame` or a simple threshold check). Hidden at the top.
- **Action:** `containerRef.current.scrollTo({ top: 0, behavior: 'smooth' })`.
- Works in both `timeline` and `by-speaker` views (same container). Labeled with an up-arrow icon (lucide `ArrowUp` / `ChevronUp`) and an accessible name ("Back to top").

### 4.3 #2 — Per-speaker collapse (By-Speaker view)

- Each By-Speaker card header (avatar + name + stats row, ~`389–420`) gets a chevron toggle. Collapsing hides only that speaker's turn list (~`421–435`); the header row stays visible.
- State: a local `Set<string>` of collapsed speaker keys (keyed on `g.key`), default **expanded** (empty set = all expanded). Toggle adds/removes the key.
- Header row becomes a button (or gets a chevron button) with `aria-expanded`; the turn list renders only when the key is not collapsed.

### 4.4 #3 — Collapsible Speakers panel

- The `Speakers` header row (~508–517) becomes a chevron toggle (reuse the pattern). Collapsing hides the panel body (everything below the header); the header stays.
- State: a local `useState(true)` in `SpeakersPanel` (default **expanded**), `aria-expanded` on the toggle. The "Dismiss all suggestions" button in the header remains visible/usable in the header row regardless of collapse (or moves inside the body — implementer's call to keep the header clean; default: keep it in the header when there are suggestions).

### 4.5 #4 — Assigned names in the Speakers panel

- Add a small helper in `SpeakersPanel`: `displayName(label) => assignedSpeakers?.[label]?.contactName ?? assignedNames?.[label] ?? null`.
- **Render rule:** when `displayName(label)` is non-null, show the **name as primary** with the raw letter as a small muted tag beside it (e.g. name in normal weight + the letter in `text-ink-muted`/smaller, or a subtle chip). When null (unassigned), show the **letter** as today.
- Apply at the raw-label sites: assignment chip button (~554), popover confirmation (~595), merge dialog (~680), per-turn reassign list (~817), reassign dialog (~840). For the per-turn list, resolve from the turn's `speaker` label.
- Transcript Timeline and By-Speaker views already resolve names — no change there.
- Unassigned speakers always show the letter (so you can still identify and assign tracks).

## 5. Defaults & decisions

- All three collapses (summary, per-speaker, Speakers panel) default **expanded**.
- Collapse state is **local to the open reader**, not persisted across recordings or app restarts.
- Return-to-top threshold ≈ **300px** of scroll.
- Speaker labels keep the letter visible wherever a track must be identified for assignment/merge/reassign; the name leads when assigned.

## 6. Error handling / edge cases

- `speakerNames` empty (names not yet loaded or none assigned): everything shows letters — correct. Once the async resolves and props update, names appear (existing re-render path).
- No structured turns / not diarized: the By-Speaker view and SpeakersPanel don't render (existing `hasStructuredTurns` / `canGroupBySpeaker` guards); per-speaker collapse and Speakers-collapse simply don't appear. Return-to-top still applies to the timeline/plain transcript scroll container.
- No summary: the top summary block is not rendered (guarded).
- A speaker assigned then unassigned: `displayName` returns null → falls back to the letter.

## 7. Testing

Component tests (Vitest + Testing Library), one focused area each:

1. **Summary at top:** `SourceReader` renders the summary block above the `SpeakersPanel`/transcript and `TranscriptViewer` no longer renders a Summary section; when there is no summary, no summary block renders.
2. **Return-to-top:** the button is hidden at `scrollTop = 0`, appears after a scroll past the threshold (simulate by setting `scrollTop` and dispatching `scroll`), and clicking it calls `scrollTo({ top: 0, ... })`; present in both views.
3. **Per-speaker collapse:** a speaker's turn list is visible by default, hidden after toggling its chevron, and the header row stays visible; another speaker's list is unaffected.
4. **Speakers collapse:** the panel body is visible by default and hidden after toggling the header; the header remains.
5. **Assigned names:** a speaker with an assigned name renders the name (with the letter tag) at each panel site; an unassigned speaker renders the letter; transcript views unchanged.

## 8. Acceptance criteria

1. Opening a recording shows the **summary at the top** of the reader (above Speakers + transcript), still collapsible; it is no longer rendered inside `TranscriptViewer`.
2. Scrolling the transcript reveals a **return-to-top** control that smooth-scrolls the transcript container to the top; it is hidden at the top and works in Timeline and By-Speaker views.
3. In the **By-Speaker** view, each speaker can be **collapsed/expanded** individually; the header row stays visible when collapsed.
4. The **Speakers** panel can be **collapsed/expanded** from its header.
5. In the **Speakers** panel, assigned speakers show the **name** (with a muted letter tag) at every label site; unassigned speakers show the letter.
6. All collapses default expanded; collapse state does not persist across recordings.
7. `npm run typecheck` (node+web) + lint clean; the five component tests pass.
