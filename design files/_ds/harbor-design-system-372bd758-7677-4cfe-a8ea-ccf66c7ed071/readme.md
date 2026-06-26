# Royal Forrest Design System

> **Calm from the storm.**

A **private family brand** — for personal/family use, not public distribution — built
around a single promise: a safe harbor, calm from the storm, for the people you love. The identity is
warm but steady: a deep-navy crescent that *embraces* a family beneath a roof, lifted
by a teal swoosh (the wave, finally calmed). It dresses the family's personal site, a
journal/keepsake app, slide decks, and the occasional event or activity materials.

The feeling to aim for: *sheltering, hopeful, steady — never clinical, never loud.*
Think the quiet relief of reaching harbor after a hard crossing.

> **Palette origin** — seeded from a Coolors palette the owner liked
> (`#2F6690 · #3A7CA5 · #D9DCD6 · #16425B · #81C3D7`), then anchored to the exact
> logo colors sampled from the mark: **navy `#103D65`** and **teal `#139D88`** (the
> swoosh). Everything in `tokens/colors.css` builds from those.

## Sources & provenance
- **Primary logo** provided by the owner — `assets/logo.png` (a navy crescent
  embracing a family under a roof, with a teal swoosh). It is the master mark; the
  navy + teal brand tokens are sampled directly from it.
- **Tagline:** “Calm from the storm.” Use it as the brand sign-off and the spine of
  the voice.
- **Brand brief inferred from the owner's cues:** family/community focus, kids'
  activities (cheer, soccer, competitive swim) and a **cancer-awareness** cause —
  reflected in the specialty icon set (see ICONOGRAPHY).
- **Fonts are Google Fonts substitutions** (see Caveats). Swap in licensed files if
  you have them.

---

## CONTENT FUNDAMENTALS — how Royal Forrest writes

The voice is a calm, caring person who has been through it too — warm, plain, and
steady. Reassurance without saccharine; hope without false promises.

- **Person & address.** Speak as *we* (the community/org) to *you* (the family). Warm
  and inclusive — “we've got you,” “you're not alone in this.”
- **Tone.** Warm, measured, a little understated. Confident without selling. Dry
  humor is welcome; exclamation marks are not.
- **Casing.** Sentence case **everywhere** — headings, buttons, labels, nav. Never
  Title Case UI. Reserve UPPERCASE for the mono eyebrow/overline only, and even then
  for short kickers ("Selected work", "Now").
- **Length.** Short sentences. Short paragraphs. Lots of breathing room. One idea per
  line. Cut adjectives before adding them.
- **Vocabulary.** Plain words over jargon. "Writing" not "content". "Work" not
  "portfolio assets". Light coastal/maritime metaphors are on-brand but use them like
  salt — *harbor, tide, drift, anchor, current* — never a whole themed paragraph.
- **Numbers & dates.** Lowercase, unfussy: "2026", "12 projects", "since 2019". Mono
  font for figures and metadata.
- **Buttons / CTAs.** Verb-first and quiet: "Read the note", "See the work", "Say
  hello", "Get the file". Not "LEARN MORE", not "Submit".
- **Emoji.** No. Not in UI, not in prose. Iconography carries that load (Lucide).
- **Examples**
  - Tagline / sign-off: *"Calm from the storm."*
  - Hero: *"A safe harbor for families weathering the hard seasons."*
  - Reassurance: *"You're not alone in this. We've got you."*
  - Empty state: *"Nothing here yet — and that's okay. Start when you're ready."*
  - Error toast: *"That didn't go through. Take a breath and try again."*
  - Eyebrow: `OUR FAMILIES · 2026`

---

## VISUAL FOUNDATIONS

**Palette & vibe.** Cool, watery blues from sky (`#81C3D7`) to deep navy (`#16425B`),
grounded by a soft sage-grey "mist" neutral (`#D9DCD6`). Imagery should feel *cool and
airy* — overcast coast, soft daylight, a little muted; avoid warm/orange grading.
Semantic colors are pulled toward the cool palette (a sea-green success, a sandy amber
warning, a muted coral danger) so nothing clashes.

**Color usage.** Ocean blue (`--accent`, `#2F6690`) is the single action color — one
primary action per view. The logo's deep **navy `#103D65`** (`--brand-navy`) anchors
headers, dark bands, and the mark's clear-space tile. The logo **teal `#139D88`**
(`--brand-teal` / `--accent-2`) is the *secondary* accent — the calmed-wave color —
used **sparingly**: small rules, active underlines, an awareness moment, the odd
highlight. Never let teal become a second competing button. Sky blue is the dark-theme
accent and the highlight/selection tint. Mist neutrals do the structural work. Never
introduce a hue outside the ramps; derive new shades with `color-mix`.

**The logo.** `assets/logo.png` is the master mark and always appears on a white (or
very light) rounded tile so the navy crescent and teal swoosh keep their contrast in
both themes — never place the full-color logo directly on navy. Keep generous
clear-space (≈ the height of the roof) around it; don't recolor or stretch it. At tiny
sizes (favicon, dense nav) the navy “H” monogram tile is the fallback.

**Typography.** Three families: **Newsreader** (display serif — headings, hero lines,
the occasional italic pull-quote), **Hanken Grotesk** (UI + body), **JetBrains Mono**
(eyebrows, metadata, numerics, code). Display is set tight (`-0.02em`) and large; body
is comfortable at 1.55 line-height. Headings default to the serif via base styles.

**Spacing & density.** 4px base grid, *balanced-to-airy*. Generous section padding
(`--space-8`/`--space-9`), comfortable control padding, real whitespace around
headings. Content rails cap reading width (`--container-md` ≈ 768px for prose).

**Backgrounds.** Mostly flat — `--bg` (off-white mist) in light, near-black in dark.
**No gradient fills** as decoration. The one allowed soft touch is a very subtle
vertical wash on hero/section bands using `color-mix` between `--bg` and `--blue-50`.
No textures, no patterns, no noise. Full-bleed photography is welcome on portfolio
surfaces; keep it cool-toned.

**Borders.** Hairline `1px` in `--border` (mist-200) for structure; `--border-strong`
on hover. Brand-blue border (`--border-brand`) signals selected/active. Controls use
a `1.5px` border for a touch more presence.

**Corner radii.** Medium and soft — `8px` is the default control radius, `12px` for
cards, `18px+` for large panels, pill (`999px`) for badges and switches. Nothing
sharp-cornered, nothing bubble-round.

**Shadows / elevation.** Cool, **navy-tinted** soft shadows (`rgba(14,44,61,…)`) —
never neutral grey or black. They're subtle: `--shadow-sm` for resting cards,
`--shadow-lg` for hover lift and popovers, `--shadow-xl` for modals. Dark theme leans
on borders and raised surfaces more than shadow.

**Motion.** Quick and gentle. `--dur-fast` (120ms) for hovers, `--dur` (200ms) for
most transitions, `--dur-slow` (360ms) for larger moves. Default easing `--ease-out`;
toggles/thumbs use `--ease-spring` for a tiny bit of life. Fades and short slides
(4–8px) — no big bounces, no infinite decorative loops. All motion respects
`prefers-reduced-motion`.

**Hover / press states.** Hover: filled buttons darken one step (`--accent-hover`);
ghost/secondary fill with a sunken/hover surface; cards lift `-2px` and gain
`--shadow-lg`. Press: a barely-there `scale(0.99)` + 0.5px nudge on buttons, `0.93`
on icon buttons. Links shift to `--accent-hover`. Focus is always a 3px soft ring
(`--shadow-focus`), never a removed outline.

**Transparency & blur.** Used sparingly: sticky top bars get a translucent surface +
`backdrop-filter: blur(--blur-md)`; modal overlays use a navy-tinted `--overlay`. No
frosted glass everywhere.

**Cards.** White (light) / `neutral-900` (dark) surface, `1px` mist border, `12px`
radius, `--shadow-sm` at rest. Optional full-bleed media on top. Interactive cards
lift and strengthen their border on hover. No colored left-border-accent cards.

**Layout rules.** Centered content within max-width rails; sticky header with blur;
sidebars use sunken surfaces. Fixed elements (header, toast stack) sit above content
with elevation, not borders alone.

**Theming.** Full light + dark via `[data-theme="dark"]`. Components only read
semantic aliases (`--surface`, `--text-strong`, `--accent`…) so they flip themes for
free. `color-scheme` is set per theme.

---

## ICONOGRAPHY

Two tiers: a calm **core** set and a small **specialty** set for this community's
world (kids' activities + the awareness cause).

- **Core system: [Lucide](https://lucide.dev)** — chosen for its even **2px stroke**,
  round caps/joins, and calm geometric-humanist shapes that match Hanken + the soft
  radii. Delivery: CDN, pinned
  `https://unpkg.com/lucide@0.456.0/dist/umd/lucide.min.js`. Markup is
  `<i data-lucide="anchor"></i>` then `lucide.createIcons()`. In React/JSX, inline the
  SVG paths directly (stroke `currentColor`, width `2`).
- **Specialty set (custom):** four glyphs the brand needs that Lucide doesn't carry,
  drawn to Lucide's spec (24×24, 2px stroke, round joins, `currentColor`) and stored
  in `assets/icons/`:
  - `awareness-ribbon.svg` — **cancer-awareness ribbon** (the cause)
  - `cheer-pom.svg` — **cheer** pom burst
  - `soccer-ball.svg` — **soccer**
  - `competitive-swim.svg` — **competitive swim** (swimmer + lane water)
  These usually carry the **teal** accent (`--brand-teal`) when they represent an
  activity/cause, or `currentColor` inline in text. They are **custom and flagged** —
  if you adopt a licensed activity/awareness icon set, swap these out and keep the
  same names. See `guidelines/iconography.card.html` for both tiers.
- **Rules.** Icons inherit `currentColor` and size to the text (`1em`–`1.15rem` in
  UI). Keep stroke weight uniform — don't mix filled icon sets in. **No emoji, no
  unicode glyphs as icons.** If a core icon is missing from Lucide, pick the nearest
  Lucide match before reaching elsewhere.
- **Logo.** The master mark is `assets/logo.png` — a navy crescent embracing a family
  under a roof, with a teal swoosh. Always on a white/very-light rounded tile, never
  recolored or stretched, with generous clear-space. Pair it with the **"Calm from the
  storm"** tagline in JetBrains Mono uppercase. A navy "H" monogram tile is the
  small-size fallback. See `guidelines/brand-logo.card.html`.

---

## INDEX — what's in this folder

**Foundations**
- `styles.css` — the single entry point consumers link. `@import`s only.
- `tokens/fonts.css` — `@font-face` / webfont imports (Google Fonts).
- `tokens/colors.css` — brand + neutral + semantic ramps and the light/dark aliases.
- `tokens/typography.css` — families, scale, weights, leading, tracking.
- `tokens/spacing.css` — 4px spacing scale + layout rails.
- `tokens/effects.css` — radii, borders, shadows, blur, motion.
- `tokens/base.css` — resets + element defaults wired to tokens.

> **Note on the runtime namespace.** The compiled component bundle exposes components
> under `window.HarborDesignSystem_372bd7` — an internal id fixed when the project was
> first created. It does not affect the brand, which is **Royal Forrest**; just use
> that namespace verbatim in code that reads the components.

**Components** (React; `window.HarborDesignSystem_372bd7.<Name>`)
- `core/` — `Button`, `IconButton`, `Badge`, `Tag`, `Avatar`, `Card`
- `forms/` — `Input`, `Select`, `Checkbox`, `Switch`
- `navigation/` — `Tabs`
- `feedback/` — `Toast`, `Tooltip`
  Each has a `.d.ts` (props), `.prompt.md` (usage), and a directory `@dsCard` HTML.

**Specimen cards** (`guidelines/*.card.html`) — populate the Design System tab:
colors (brand/neutral/semantic/aliases), type (display/body/mono), spacing
(scale/radii/shadows/motion), brand (logo + tagline, iconography).

**Assets** (`assets/`)
- `logo.png` — the primary mark (navy crescent + family + teal swoosh).
- `icons/` — the custom specialty set: `awareness-ribbon`, `cheer-pom`,
  `soccer-ball`, `competitive-swim` (SVG, Lucide-spec).

**UI kits** (`ui_kits/`)
- `portfolio/` — personal site / portfolio screens.
- `app/` — a small writing-app dashboard.

**Templates** (`templates/` — starting points consuming projects can copy)
- `personal-site/` — calm coastal landing page.
- `writing-app/` — three-column writing/journal app shell.
  Each loads Royal Forrest via `ds-base.js` (one line to repoint when copied).

**Other**
- `SKILL.md` — makes this folder usable as a downloadable Claude Code skill.

---

## CAVEATS
- **Specialty icons are custom** (drawn to Lucide's spec): the cancer-awareness
  ribbon, cheer, soccer, and competitive-swim glyphs in `assets/icons/`. They're a
  faithful first pass — if you have a licensed activity/awareness icon set, swap them
  in under the same filenames.
- **Core icons are Lucide via CDN.** Swap if you adopt a different core set.
- **Fonts are Google Fonts stand-ins** (Newsreader / Hanken Grotesk / JetBrains Mono).
  If you have licensed brand fonts, drop them in `assets/fonts/` and replace the
  `@import` in `tokens/fonts.css` with local `@font-face` rules.
- The brand essence (family/community, “calm from the storm,” the awareness cause)
  was inferred from your logo + cues. It feels right, but tell me where it's off.
