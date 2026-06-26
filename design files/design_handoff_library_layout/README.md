# Handoff: HiDock Library — responsive layout fix

## Overview
The **Library** screen in HiDock Meeting Intelligence currently renders as three
**fixed-width columns** that never reflow: a narrow capture list, a large detail
pane, and a docked Assistant pane. When the window is anything less than fully
maximized this produces the worst of both worlds — the list and its controls are
crushed into a cramped strip while a huge "No recording selected" detail pane and an
idle Assistant pane consume more than half the width doing nothing.

This handoff specifies a fix: drive the layout off **selection state and available
width** (a responsive master/detail pattern) and convert the Assistant from a docked
column into a **toggleable drawer**.

> **Goal in one line:** when nothing is selected, the list fills the window; the
> detail pane only exists when there's something to show; the Assistant is summoned,
> not permanently parked.

## About the design files
The files in this bundle are **design references created in HTML** — a working
prototype showing the intended layout and behavior, *not* production code to copy
verbatim. The task is to **recreate this behavior in the real HiDock codebase**
(Electron + React, going by the app) using its existing components, state, and
styling. Lift the *layout logic and breakpoints* from here; keep the app's own
component library and design tokens.

- `HiDock - Royal Forrest Redesign.dc.html` — the reference prototype. Its **"reader"**
  layout mode already demonstrates the Assistant-as-drawer behavior (toggle button in
  the detail header; slides in over the content with a scrim). Its **"workspace"** mode
  shows the old docked-column behavior for comparison. Toggle between them with the
  segmented control in the top strip.
- `problem-state.png` — screenshot of the current bug: cramped list + giant empty
  detail pane + idle Assistant column, all at once.

## Fidelity
**High-fidelity** for layout behavior and **medium** for exact pixel values — the real
app already carries its own tokens, so match this prototype's *structure, breakpoints,
and states*, not its precise colors. Visual styling should use the app's existing
design system.

---

## The three problems (and the fix for each)

### 1. The detail pane reserves ~45% of the window even when empty
**Now:** a fixed/flex detail column is always mounted; with no selection it shows a
centered "No recording selected" placeholder. That whole region is dead space.

**Fix — collapse on empty.** Make the detail pane conditional on there being a
selection. When `selectedId == null`:
- Do **not** render the detail pane at all.
- The capture list expands to **fill the full content width** (the area between the
  sidebar and the right edge).
- Use that width: switch the list to the **multi-column card grid** the existing
  grid/list toggle already supports, or to roomy full-width rows (see #2). No centered
  empty-state placeholder floating in a void.

When `selectedId != null`, the detail pane mounts and the list collapses to a rail
(see Layout states below).

### 2. The list rows are all controls, no content
**Now:** each row crams ~8 always-visible micro-icons (checkbox · device · status dot ·
quality/mic · transcript · edit · play · delete) into a ~290px strip, leaving no room
for the recording's **name, date, and duration** — the only things a user scans for.

**Fix — content first, actions on demand.**
- Row primary line: **capture title** (truncate with ellipsis).
- Row secondary line (mono, muted): **date · duration · status**.
- Keep **only** the checkbox (left) and a single **play** button (right) always visible.
- Collapse transcript / edit / download / delete into **one overflow (⋯) menu** revealed
  on hover/focus, or a row-level kebab. Bulk actions (download all, process, delete) move
  to a **selection action bar** that appears only when ≥1 checkbox is ticked.
- Status (on-device / downloaded / transcribed / synced) becomes a small colored
  **pill or dot with a label**, not a bare ambiguous dot.

### 3. The Assistant is a permanently docked third column
**Now:** ~320px is always reserved for the Assistant even when it reads "Select a
recording first."

**Fix — make it a drawer/toggle.**
- Remove the docked column. Add an **"Assistant" toggle** (button in the detail header,
  and/or the existing sidebar nav item) that opens the panel.
- Open state: panel slides in from the right as an **overlay drawer** (~380px,
  `max-width: 86%`) above the content, with a navy-tinted scrim behind it on narrow
  widths. A close (×) button in the drawer header dismisses it.
- It never reserves width when closed. Default **closed**.
- (Optional, large screens only ≥1440px: allow it to dock as a column for power users,
  but closed-by-default and dismissible — never the default cramped state.)

---

## Layout states (master/detail state machine)

Let `W = content width` (window minus sidebar) and `selectedId`.

| Condition | List | Detail | Assistant |
|---|---|---|---|
| `selectedId == null` | **full width** (card grid or roomy rows) | not rendered | drawer, closed |
| `selectedId != null`, `W ≥ 1100px` | rail, fixed **300px** (compact 248px) | fills remaining width | drawer, toggled |
| `selectedId != null`, `W < 1100px` | **hidden**; detail is full-bleed with a **back arrow** (← Library) in its header | full width | drawer, toggled (over detail) |

Breakpoint: **1100px** of *content* width (measure the content region, not
`window.innerWidth`, so it's correct whether the sidebar is expanded or collapsed). The
prototype watches width and flips a `narrow` flag — mirror that with a
`ResizeObserver` on the content container in the real app.

Transitions: list rail collapse and drawer slide use ~200–360ms ease-out. Respect
`prefers-reduced-motion`.

---

## Interactions & behavior
- **Select a capture** → set `selectedId`; detail mounts. On `W < 1100px` this is a
  full push to the detail "screen."
- **Back / deselect** (back arrow on narrow, or Esc, or clicking the selected row again)
  → `selectedId = null`; list returns to full width.
- **Toggle Assistant** → `assistantOpen = !assistantOpen`; drawer slides in/out. Opening
  while no capture is selected should prompt "Select a recording first" inside the drawer
  (don't reserve layout for it).
- **Row hover/focus** → reveal the overflow (⋯) action menu.
- **Checkbox tick** → show the selection action bar (count + bulk actions); hide it at 0.
- **Scrim click / Esc** → close the Assistant drawer.

## State management
```
selectedId: string | null     // null = list-only, full width
assistantOpen: boolean         // drawer open/closed; default false
contentNarrow: boolean         // derived from ResizeObserver, W < 1100px
viewMode: 'grid' | 'list'      // existing toggle; default to 'grid' when list is full-width
selectedFiles: Set<id>         // drives the bulk selection action bar
```
Derived: `showDetail = selectedId != null`, `listIsRail = showDetail && !contentNarrow`,
`listIsHidden = showDetail && contentNarrow`.

## Responsive specifics
- Measure the **content container**, not the viewport — the left sidebar can be
  expanded or icon-collapsed.
- List rail: `flex: none; width: 300px` (compact `248px` in dense/reader mode).
- Full-width list grid: `repeat(auto-fill, minmax(300px, 1fr))`, `gap: 16px`.
- Assistant drawer: `position: absolute; inset: 0 0 0 auto; width: 380px; max-width: 86%;`
  `transform: translateX(105%)` when closed → `0` when open; `box-shadow: var(--shadow-xl)`.

## Design tokens
Use the app's existing tokens. For reference, the prototype uses the Royal Forrest set:
- Radii: control `8px`, card `12px`, panel `18px+`, pill `999px`.
- Borders: hairline `1px var(--border)`; controls `1.5px`.
- Shadows: navy-tinted (`rgba(14,44,61,…)`) — `--shadow-sm` resting card,
  `--shadow-lg` hover/popover, `--shadow-xl` drawer/modal.
- Motion: `120ms` hover, `200ms` default, `360ms` larger moves; ease-out.
- Status pills: on-device (neutral/sunken), downloaded (accent-soft), transcribed
  (success-soft), synced (brand-teal-soft).

## Files
- `HiDock - Royal Forrest Redesign.dc.html` — reference prototype (open in a browser;
  switch its top-strip layout control between "reader" and "workspace" to see the
  drawer vs. docked Assistant).
- `problem-state.png` — the current broken state.

## Notes for the implementer
- The single most important change is **#1**: stop reserving the detail pane when
  nothing is selected. That alone removes the "ridiculous whitespace."
- Don't introduce a new design system — reuse HiDock's existing components and tokens.
- The Assistant column should default **closed**. If product wants a docked option,
  gate it behind ≥1440px and keep it dismissible.
