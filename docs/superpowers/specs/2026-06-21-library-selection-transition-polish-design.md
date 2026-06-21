# Library selection + view-transition polish

**Status:** Design (approved). Small, presentation-only polish — two independent fixes in the Library page.
**Date:** 2026-06-21
**Area:** `apps/electron/src` — Library selection store + `TriPaneLayout`.

## Problem

When selecting a record in the Library:
1. **Ugly view transition.** Selecting a record hard-swaps the layout — the full-width list snaps to a ~300px rail and the detail pane pops in with no animation; the whole switch feels instant/janky.
2. **Bulk bar on a single open.** Opening one record immediately shows the bulk-actions bar ("Select all / 1 of 64 selected"). It should appear only for a deliberate multi-select, not when opening a single record.

## Part A — Decouple "open" from "bulk" (fixes #2)

### Root cause
`openDetail` (`Library.tsx`) calls `selectSingle(id)`, which sets **both** `selectedSourceId: id` (the open/detail record) **and** `selectedIds: new Set([id])` (the bulk set). `BulkActionsBar` renders whenever `selectedCount (= selectedIds.size) ≥ 1`, so opening one record makes the bar appear. (`selectSingle` is used *only* by `openDetail`; the Shift-range anchor is `lastSelectedRef`, independent of `selectedIds`.)

### Design
Make `selectedSourceId` (the open record) and `selectedIds` (the bulk-selection set) fully independent:
- Rename the store action `selectSingle` → **`openSource(id)`** (honest name — it opens the detail source) and change it to set **only** `selectedSourceId: id`; it no longer touches `selectedIds`.
- `openDetail` calls `openSource(id)`.
- No change to `BulkActionsBar` — its existing `if (selectedCount === 0) return null` gate is now correct:
  - **Plain-click open** → router calls `clearSelection()` (empties `selectedIds`) + `openSource(id)` → `selectedCount === 0` → **bar hidden**.
  - **Cmd/Ctrl-click** → `toggleSelection` grows `selectedIds` → bar shows (even at 1 — deliberate multi-select).
  - **Shift-click** → `selectRange` (anchored on `lastSelectedRef`) grows `selectedIds` → bar shows.
- Row tints become cleaner with no behavior change to the consumers: the open row is `isActiveSource` (blue) only; bulk rows are `isSelected` (teal). Today the open row is wrongly both.

### Files
- `src/store/useLibraryStore.ts` — rename `selectSingle` → `openSource`; body becomes `set({ selectedSourceId: id })`. Update the `SelectionSlice`/store type.
- `src/pages/Library.tsx` — update the import + the `openDetail` call (and its stale comment about "seeds selectedIds").
- Any other `selectSingle` references (none outside `openDetail` per grep).

### Tests
- `src/store/__tests__/useLibraryStore.test.ts` — update the `selectSingle` test: `openSource(id)` sets `selectedSourceId === id` and leaves `selectedIds.size === 0`; add an assertion that a subsequent `toggleSelection` is what populates `selectedIds`.
- Add/extend a Library selection test: plain-click open → `selectedCount === 0` (bar hidden); Cmd-click → `selectedCount === 1` (bar shown). (Where existing selection tests live.)

## Part B — Smooth the list → detail transition (fixes #1, Approach 1: tailwindcss-animate, no new deps)

### Root cause
`TriPaneLayout` renders a full-width list with the detail pane **unmounted** when `selectedSourceId == null`, and switches to a `ResizablePanelGroup` (rail + detail) on selection, with no transition on the swap. (The Assistant panel already uses `motion-safe:animate-in fade-in duration-150`; reuse that vocabulary.)

### Design
Use the existing `tailwindcss-animate` utilities (already a dependency, used by the Assistant panel) — all `motion-safe:` so reduced-motion users are unaffected:
1. **Detail pane eases in, not pops:** when the detail/reader pane mounts (selection made), give its wrapper `motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 motion-safe:duration-200`.
2. **Mask the list reflow:** wrap the rail+detail mode container in a short `motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200` so the new layout settles in rather than snapping — the list's width reflow happens under the fade.
3. **Ease the rail width where feasible:** add a CSS `transition` (width/flex-basis, ~200ms, `ease-out`) to the list rail container so the narrowing is a glide, not a jump, in the cases where the panel structure permits a transitionable width. (If `react-resizable-panels`' inline flex sizing makes this jumpy, the fade in step 2 still masks it; do not fight the library.)

Tune duration/slide distance live against the running app.

### Files
- `src/features/library/components/TriPaneLayout.tsx` — add the `motion-safe:animate-in …` classes to the detail-pane wrapper and the rail+detail mode container; add a width `transition` on the list rail container where applicable.

### Tests
Animation classes are presentation; assert their presence minimally if the file has component tests (e.g., the detail wrapper carries the `animate-in`/`fade-in` classes when a source is selected). No behavioral logic changes, so existing `TriPaneLayout` tests must stay green. Visual feel is validated live in the running app.

## Non-goals
- No new animation dependency (no framer-motion); the heavier true-width-tween alternative was considered and rejected as overkill.
- No change to the modifier-click routing, the Shift-range anchor, the Assistant drawer, or `BulkActionsBar`'s contents.
- No change to what counts as "selected" for bulk actions beyond the open/bulk decoupling above.

## Risks
- Part A: a consumer relying on `selectSingle` also setting `selectedIds` — grep confirms none outside `openDetail`; the store test pins the new contract.
- Part B: `react-resizable-panels` may not smoothly transition inline-flex widths — mitigated by masking the reflow with the layout fade rather than forcing a width tween.
