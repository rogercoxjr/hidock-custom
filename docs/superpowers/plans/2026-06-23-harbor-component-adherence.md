# HiDock Library — Harbor Component Adherence (visual-only)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development to execute task-by-task.

**Goal:** Make the Electron Library/reader/sidebar match the Harbor design system at the **component** level — fix the three explicit brand-rule violations and bring the `ui/` primitives onto the Harbor specs — without changing any behavior or layout.

## Context

The user pointed at `design files/HiDock - Harbor Adherence Audit.dc.html` (+ the Royal Forrest / Tri-Pane design files) and asked to **enumerate what should be updated** to match the design, **without changing functionality**.

The audit's headline framing — *"0/13 Harbor components mounted, the fix is to load `_ds_bundle.js`"* — is a **design-doc artifact and is stale for the real app**. `_ds_bundle.js` is a Claude-design export bundle the React app can't (and shouldn't) load. Phase-1 exploration confirmed the Electron app already has:
- **Harbor tokens fully wired** (Royal Forrest Ph0): `apps/electron/src/index.css` + `tailwind.config.js` define `--accent`/`accent-strong`, `accent-strong-hover/-soft`, `surface-sunken`, `border-strong`, `border-brand`, `ring`, `--shadow-xs/sm/focus` (the focus token is a 3px soft ring), `radius-*`, `ease-spring`, tonal `--blue-200/900`.
- **A real `components/ui/` primitive library** — Button, Badge, Card, Input, Textarea, Select, Switch, Tabs/SegmentedToggle, Tooltip, Checkbox, and **Toast (fully built + used)**, plus `harbor/PersonAvatar`.

So several audit findings are **already resolved** and are dropped from this plan: the QA-Logs Switch is genuinely wired to `qaLogsEnabled` (not decorative — finding #10 stale), Toast exists and is used (#13), Checkbox exists (#13), SegmentedToggle already matches the Tabs-pill spec (#11). The remaining gap is: the primitives are painted with Harbor tokens but carry off-spec dimensions/states, and **three usages break stated brand rules.** This plan aligns them.

**Outcome:** Every control reads as a Harbor component — correct focus ring, sizes, states, dark tooltips, tonal avatars — and the three rule-breaks are gone. No functional or layout change.

### Decisions (locked with the user)
- **Full component adherence**, visual/styling only — *not* the tri-pane layout redesign.
- **Avatars: tonal but per-person** — keep a distinct hue per person (preserves the speaker cue) but from a calm, desaturated family with dark initials.
- **Filter chips: keep the pill shape** (`rounded-full`); only change the selected state from solid fill → soft tint.

## Scope / non-goals

**IN:** `ui/` primitives + their Library/reader/sidebar usages; the native-`<select>`→Radix-`Select` swap (behavior-equivalent); native `title=""`→`Tooltip` swap; PersonAvatar recolor.

**OUT (do not do here):**
- The Royal Forrest **tri-pane layout** (300px list rail, 1100px content breakpoint, slide-in drawer assistant, card grid, 860px reader) — separate effort, restructures the Library and touches behavior.
- Converting Checkbox to a native `<input>` or changing selection/queue/playback logic — behavior change.
- Re-adding tokens — they already exist; **reuse** them, never hardcode hex.

## Global constraints (every task inherits these)
- Reuse existing Tailwind aliases/tokens only: `accent-strong`, `accent-strong-hover`, `accent-strong-soft`, `accent-2`/`accent-2-soft`, `surface`/`surface-sunken`/`surface-hover`, `border`/`border-strong`/`border-brand`, `ring`, `shadow-xs`/`shadow-sm`, `radius-*`, `ease-spring`, and CSS vars `var(--neutral-900)`/`var(--neutral-0)`/`var(--blue-900)` where no alias exists.
- **3px soft focus ring** is expressed as `focus-visible:ring-[3px] focus-visible:ring-ring/40` — the Tailwind `ring` color is wrapped in `color-mix(...<alpha-value>...)` (tailwind.config.js:7,18), so `/40` yields `color-mix(var(--ring) 40%, transparent)`, matching the `--shadow-focus` token. (`ring-*` compiles to box-shadow → no layout reflow.)
- **No behavior changes.** The native→Radix Select swap must preserve the exact option set, values, and change handler. The avatar change is color-only. QA-logging gate rules unchanged.
- Update the co-located `__tests__` whose assertions reference changed classes; keep the rest of the suite green.
- Do **not** touch device/USB code.
- Gate after every task: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`.

---

## The enumeration

### P0 — Brand-rule violations (must-fix)

| # | Where | Current | Target | Rule |
|---|-------|---------|--------|------|
| 1 | **Colored left-border cards** — `features/library/components/SourceRow.tsx:151-153` | `border-l-2`, then `isSelected → bg-accent-2-soft border-l-accent-2`, `isActiveSource → bg-accent-strong-soft border-l-primary` | Drop the left bar entirely: base loses `border-l-2`; selected keeps `bg-accent-2-soft`, active keeps `bg-accent-strong-soft`, neither keeps `hover:bg-surface-hover`. Background tint alone conveys both states. Update the explanatory comment at :146-150. | "No colored left-border-accent cards." |
| 2 | **Solid-fill selected chips** — `features/library/components/LibraryFilters.tsx:48` | `chipActive = 'border-transparent bg-primary text-primary-foreground'` | `chipActive = 'border-border-brand bg-accent-strong-soft text-accent-strong'`. Keep `chipBase` `rounded-full` (pills). `chipInactive` unchanged. | Selected = soft accent tint, never a solid fill. |
| 3 | **Removed / 1px focus ring → 3px soft** — primitives, app-wide | `button.tsx:7`, `input.tsx:11`, `textarea.tsx:11`: `focus-visible:ring-1 focus-visible:ring-ring`; `select.tsx:19`: `focus:ring-1 focus:ring-ring`; **AssistantPanel composer**: inner `<textarea>` has `focus-visible:ring-0` and its bordered wrapper has no focus-within ring (`AssistantPanel.tsx` ~194-206) | All four primitives → `…ring-[3px] …ring-ring/40` (Select also adds `focus:border-border-brand`). For the composer, keep the inner textarea `ring-0` (borderless by design) but add `focus-within:ring-[3px] focus-within:ring-ring/40 focus-within:border-border-brand` to its bordered wrapper. | "Focus is always a 3px soft ring, never a removed outline." |

### P1 — Primitive spec alignment (`components/ui/`)

| # | File | Current → Target |
|---|------|------------------|
| 4 | **Button** `button.tsx:11,19,22-23` | default size `h-9 px-4 py-2` → `h-10 px-[18px] py-2` (40px / 0 18px); primary `shadow hover:bg-primary/90` → `shadow-xs hover:bg-accent-strong-hover`; add press state to base cva string: `active:translate-y-[0.5px] active:scale-[0.99]` (add `transition-transform` alongside `transition-colors`); icon sizes `icon:h-9 w-9`/`icon-sm:h-7 w-7` → `h-10 w-10`/`h-8 w-8` (Harbor 40/32). *Optional:* add a `soft` variant `bg-accent-strong-soft text-accent-strong hover:bg-accent-strong-soft/80`. Call-sites that pass an explicit `h-8`/`h-9` keep their override. |
| 5 | **Input / Textarea** `input.tsx:11`, `textarea.tsx:11` | `h-9` → `h-[42px]` (Textarea keeps `min-h-[60px]`); `border` (1px) → `border-[1.5px]`; add `hover:border-border-strong focus-visible:border-border-brand` (+ the P0 ring). Intentional compact override sites (Library search `h-8`) keep their height. |
| 6 | **Select primitive** `select.tsx:19` | `h-9` → `h-[42px]`; `border` → `border-[1.5px]`; add `hover:border-border-strong focus:border-border-brand` (+ P0 ring). Custom `ChevronDown` already present (no OS chevron). |
| 7 | **Card** `card.tsx:6` | `rounded-xl` (18px) → `rounded-lg` (12px). Resting `shadow` already = `--shadow-sm` (correct). Hover-lift (`translateY(-2px)`+`shadow-lg`+`border-strong`) is an *interactive-card* treatment → belongs on a SourceCard grid if/when the layout redesign lands; **not** added to the generic primitive (static panels must not lift). Note only. |
| 8 | **Badge** `badge.tsx:20-21` | Give a fixed height + 12px font: `sm:'h-[22px] px-2 text-xs'`, `md:'h-[22px] px-2.5 text-xs'` (currently `text-[10px]`/`py-1`). Variants unchanged. Note: slightly enlarges the tiny location/insight pills (on-spec); update tests asserting `text-[10px]`. |
| 9 | **Switch** `switch.tsx:11,19` + `components/layout/Layout.tsx` (~433) | track `h-5 w-9` → `h-[22px] w-[38px]`; thumb `h-4 w-4` → `h-[18px] w-[18px]`; checked `translate-x-4` → `translate-x-[16px]`; add `ease-spring` to the thumb's `transition-transform`. Then **remove** the `className="scale-75"` hack on the QA-Logs `<Switch>` in Layout. |
| 10 | **Tooltip** `tooltip.tsx:20,25` | Dark bubble: `bg-popover text-popover-foreground … border border-border` → `bg-[var(--neutral-900)] text-[var(--neutral-0)] … border-transparent`; add `<TooltipPrimitive.Arrow className="fill-[var(--neutral-900)]" />` inside Content. Confirm a `TooltipProvider` wraps the app root (SourceRow wraps locally at :213 today); add one at the root if missing so P2 #12 triggers work. |

### P2 — Usage swaps (align call-sites)

| # | Where | Change |
|---|-------|--------|
| 11 | **Native `<select>` → Radix `Select`** — `LibraryFilters.tsx` Sort / Quality / Status (`selectClass` :52-53 + the three `<select>`/`<option>` blocks ~248-258, 283-294, 300-310) | Replace each native control with `Select / SelectTrigger / SelectValue / SelectContent / SelectItem` from `@/components/ui/select` (map `value`→`onValueChange`; **same options, same handlers**). Gains the custom chevron + focus ring; removes the OS chevron. Delete `selectClass`. |
| 12 | **Native `title=""` → `Tooltip`** — SourceRow insight pill (`:202`), play/stop buttons (`:320`, `:330-336`); `Layout.tsx` device pill (`:249`) | Wrap each trigger: `<Tooltip><TooltipTrigger asChild>…</TooltipTrigger><TooltipContent>…</TooltipContent></Tooltip>`. The error indicator already uses this pattern (SourceRow:213) — follow it. |
| 13 | **Avatars tonal-but-per-person** — `components/harbor/PersonAvatar.tsx:5-19,58-59` | Replace the saturated `AVATAR_COLORS` (blue-600/teal/amber/coral/…) with a calm palette of **{bg, fg}** pairs drawn from the tonal family (e.g. bg `var(--blue-200)`/`var(--blue-300)`/`var(--brand-teal-soft)`/`var(--success-soft)`/`var(--warning-soft)` with dark fg `var(--blue-900)` etc.), so contrast holds. Keep the name-hash so each person gets a stable, distinct hue. Change the initials span from `text-white` to the pair's dark `fg`. `voiceBadge` teal pip stays (sparing accent). `size` prop unchanged. |
| 14 | *(optional)* **Insight pill → Badge** — SourceRow `:199-205` | The hand-rolled teal `rounded-full bg-accent-2-soft … text-accent-2` pill → `<Badge variant="accent" size="sm" className="font-mono">`. Consistency only; not required. |

---

## Files touched (summary)
- **Primitives:** `apps/electron/src/components/ui/{button,input,textarea,select,card,badge,switch,tooltip}.tsx`
- **Avatar:** `apps/electron/src/components/harbor/PersonAvatar.tsx`
- **Usages:** `apps/electron/src/features/library/components/{SourceRow,LibraryFilters,AssistantPanel}.tsx`, `apps/electron/src/components/layout/Layout.tsx`
- **Tests:** co-located `__tests__` asserting changed classes — at least `SourceRow`, `LibraryFilters`, `Switch`/`badge`, `PersonAvatar`, `Button` — update assertions to the new classes.

## Suggested task grouping (for subagent-driven execution)
- **T1 — P0 focus ring** (#3): 4 primitives + the composer wrapper. App-wide, isolated, high-impact.
- **T2 — P0 SourceRow left-border (#1) + chip fill (#2).**
- **T3 — P1 primitive sizing/state** (#4–#9): Button, Input/Textarea, Select, Card, Badge, Switch (+ drop `scale-75`).
- **T4 — Tooltip dark + provider (#10), then native-title sweep (#12).**
- **T5 — native `<select>` → Radix `Select` (#11).**
- **T6 — PersonAvatar tonal palette (#13).** (#14 folded in if cheap.)

Each task: make the edit, update its co-located tests, run the full gate green, commit.

## Verification

**Automated:** `cd apps/electron && npm run typecheck && npm run lint && npm run test:run` — all green after each task and at the end.

**Live (after merge to `main` + dev-server relaunch — the standing final step):**
- Keyboard-tab through search → sort → buttons: a **3px soft ring** appears on every control, including the **assistant composer** (no missing/1px outline anywhere).
- Open a recording and bulk-select rows: **no colored left bar** — the background tint alone marks selected/active.
- Toggle filter chips: selected reads as a **soft accent tint**, not solid blue; still pill-shaped.
- Open Sort / Quality / Status: a **styled Radix dropdown** with the custom chevron + focus ring (not the OS `<select>`).
- Hover the play / insight / device controls: a **dark tooltip bubble with an arrow** (not the slow OS title tooltip).
- QA-Logs switch in the sidebar: **larger** (no `scale-75`), thumb slides with a spring.
- Avatars across People / speakers / suggestions: **calm tonal per-person colors with dark initials**; the teal voiceprint pip is intact.
- Spot-check dense toolbars/filter bar for the slightly taller controls (40/42px) — confirm no clipping.
- Cross-reference the look against `design files/HiDock - Royal Forrest Redesign.dc.html`.
