# Markdown Rendering for the Summary Pane (+ shared `<Markdown>`) — Design

**Date:** 2026-06-24
**App:** `apps/electron` (universal knowledge hub)
**Status:** proposed / awaiting user review

## 1. Request in one sentence

The summary is returned as markdown but the summary pane shows it as raw text (`## Heading`, `**bold**`, `- lists` appear literally); render it as formatted markdown — via a shared, Harbor-styled `<Markdown>` component reused across every surface that renders markdown.

## 2. Background (why) + current state

- The reader's summary pane renders the summary as a plain paragraph: `SourceReader.tsx:998`
  `<p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{transcript.summary}</p>` — no markdown parsing at all, so markup shows literally.
- `react-markdown@^10.1.0` is already a dependency and already used (bare, no plugins) for assistant answers (`Chat.tsx:1176`) and generated outputs (`Actionables.tsx:683`). Both wrap it in `prose prose-sm max-w-none`, but **`@tailwindcss/typography` is NOT installed** (not in `package.json`/`node_modules`; tailwind plugins are only `tailwindcss-animate` + `@tailwindcss/container-queries`), so those `prose` classes are **inert** — headings/lists are flattened there too (only bold/italic render via browser defaults).
- Two more surfaces render the summary as raw markdown: `MeetingDetail.tsx:606` and `SourceCard.tsx:302` (both `<p className="text-sm text-foreground">{…summary}</p>`).
- The shipped `action_items` **output template emits a GFM pipe table** (`electron/main/services/output-templates.ts:107-111`), rendered at the Actionables surface. CommonMark-only react-markdown renders that table as garbled pipes — already broken today.

**Outcome:** one shared `<Markdown>` component (react-markdown + remark-gfm + a Harbor-tokened element map) used on all five surfaces; markdown renders correctly and identically everywhere; the action-items table renders as a real table.

## 3. Decisions (locked with user)

- **Shared component**, used on all **5 surfaces** (summary pane, assistant chat, generated outputs, MeetingDetail summary, SourceCard summary).
- **Add `remark-gfm`** so tables / task lists / strikethrough / autolinks render (the action-items output needs it; summary templates may use it).
- **Harbor-tokened `components` map**, NOT the `@tailwindcss/typography` plugin (no generic `prose` styling; on-brand, dark-mode-correct via tokens).
- Safety: **no `rehype-raw`** (react-markdown renders no raw HTML by default and sanitizes URLs).

## 4. Design

### 4.1 New shared component — `apps/electron/src/components/ui/markdown.tsx`

A `<Markdown>{content}</Markdown>` component: a wrapper `<div>` (base `text-sm leading-relaxed text-foreground`, merges an optional `className`) containing `<ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>`.

`MD_COMPONENTS` maps each element to Harbor classes (all tokens verified to exist + theme in dark mode):

| Element | Classes |
|---|---|
| `h1` | `mt-4 mb-2 text-base font-semibold text-ink first:mt-0` |
| `h2` | `mt-4 mb-2 text-sm font-semibold text-ink first:mt-0` |
| `h3` | `mt-3 mb-1.5 text-sm font-semibold text-ink-muted first:mt-0` |
| `p` | `mb-2 last:mb-0` |
| `ul` | `mb-2 list-disc space-y-1 pl-5` |
| `ol` | `mb-2 list-decimal space-y-1 pl-5` |
| `li` | `leading-relaxed` (spread props so GFM's `task-list-item` class survives) |
| `strong` | `font-semibold text-ink` — **MUST render a real `<strong>`** (a Chat test depends on this) |
| `em` | `italic` |
| `del` | `line-through opacity-70` (GFM strikethrough) |
| `a` | `text-accent-strong underline underline-offset-2 hover:text-accent-strong-hover` |
| `blockquote` | `my-2 border-l-2 border-border-strong pl-3 text-ink-muted` — neutral border (intentional; not an accent, so it does not break the "no colored left-border" rule) |
| `hr` | `my-3 border-border` |
| `pre` | `mb-2 overflow-x-auto rounded-md bg-surface-sunken p-3 text-[0.85em]` |
| `code` | block vs inline detected via `className` (see 4.2) |
| `table` | wrapped: `<div className="mb-2 overflow-x-auto"><table className="w-full border-collapse text-[0.95em]" …/></div>` |
| `thead` | `border-b border-border-strong` |
| `th` | `px-2 py-1 text-left font-semibold text-ink` |
| `td` | `border-t border-border px-2 py-1 align-top` |
| `input` | `mr-1 align-middle accent-accent-strong`, force `disabled` (GFM task-list checkboxes) |

### 4.2 Inline vs block code (react-markdown v10 — no `inline` prop)

v10 removed the `inline` prop from the `code` renderer; both inline `` `x` `` and fenced blocks render through `code`, with fenced code's `<code>` nested in `<pre>`. Detect block code by the `language-*` class GFM/CommonMark adds to fenced code:
```tsx
code({ className, children, ...props }) {
  const isBlock = /language-/.test(className ?? '')
  return isBlock
    ? <code className={className} {...props}>{children}</code>            // styled by <pre>; no inline pill
    : <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.85em]" {...props}>{children}</code>
}
```
**Known limitation (accepted):** a fenced block *without* a language tag, or an *indented* (4-space) block, has no `language-*` class and would get the inline-pill class (a minor cosmetic redundancy inside the `<pre>`, not a correctness issue). LLM output uses language-tagged fenced blocks (and rarely any code), so this is acceptable; documented rather than fixed.

### 4.3 Safety

`react-markdown` renders **no raw HTML** by default (we do NOT add `rehype-raw`) and sanitizes URLs (`defaultUrlTransform` blocks `javascript:` etc.). LLM-generated summaries/answers/outputs therefore cannot inject markup. Malformed markdown degrades to text rather than throwing; every target route is already wrapped by the page-level `ErrorBoundary` (`App.tsx`), so a (rare) throw degrades that page to its fallback rather than white-screening — acceptable; no dedicated boundary required.

### 4.4 Dependency

Add `remark-gfm` (`^4`, compatible with react-markdown 10; pure JS, no CSP concern). `npm install` in `apps/electron`.

### 4.5 Wiring (5 surfaces) — each a small swap to `<Markdown>`

1. **`SourceReader.tsx:998`** — replace the `<p className="whitespace-pre-wrap …">{transcript.summary}</p>` with `<Markdown>{transcript.summary}</Markdown>` (the component supplies `text-sm leading-relaxed text-foreground`; drop `whitespace-pre-wrap`). Keep the `transcript.summary &&` guard + `summaryExpanded` collapse + surrounding container.
2. **`Chat.tsx:1174-1177`** — assistant branch: replace the inert `<div className="prose prose-sm max-w-none …"><ReactMarkdown>…` with `<Markdown className="text-[13.5px]">{message.content}</Markdown>`. Move `whitespace-pre-wrap` off the shared bubble wrapper (`:1167`) and onto the **user** branch `<p>` (`:1179`) so it preserves user newlines without fighting block markdown. Remove the now-unused `import ReactMarkdown` (`:3`).
3. **`Actionables.tsx:682-683`** — keep the container (`bg-surface-sunken p-[var(--space-4)] rounded-md border border-border`); drop `prose prose-sm max-w-none dark:prose-invert`; swap `<ReactMarkdown>` → `<Markdown>`. Remove the now-unused `import ReactMarkdown` (`:3`).
4. **`MeetingDetail.tsx:606`** — replace `<p className="text-sm text-foreground">{recording.transcript.summary}</p>` with `<Markdown>{recording.transcript.summary}</Markdown>`.
5. **`SourceCard.tsx:302`** — replace `<p className="text-sm text-foreground">{transcript.summary}</p>` with `<Markdown>{transcript.summary}</Markdown>`.

## 5. Testing

- **New `src/components/ui/__tests__/markdown.test.tsx`:** `## H`→`<h2>` (not literal "##"); `**b**`→`<strong>`; `*i*`→`<em>`; `- a\n- b`→`<ul><li>×2`; `1. a`→`<ol>`; inline `` `x` ``→`<code>` with the inline pill class; fenced block → `<pre><code>` **without** the inline pill; **GFM table** (`| a | b |` …) → a `<table>` (proves remark-gfm is wired); `~~s~~`→`<del>`; `- [ ] task`→a disabled checkbox `<input>`; `[x](https://e.com)`→`<a>` with `text-accent-strong`; **raw `<script>…` in input is NOT rendered as a `<script>` element** (safety).
- **Update `SourceReader.summaryTop.test.tsx`:** the single-line fixture ("This is the summary.") now renders inside a `<p>` via `<Markdown>`; `findByText('This is the summary.')` still resolves to one element and the DOM-position assertion holds. Keep the fixture single-paragraph (multi-element markdown would split text across nodes and break `findByText`); if it must change, assert via a wrapper `data-testid` instead.
- **`Chat.test.tsx` (existing `**bold**`→`<strong>`):** passes unchanged because `MD_COMPONENTS.strong` renders `<strong>`. No edit; this is the constraint noted in 4.1.
- **New Actionables-output test:** there is currently **no** Actionables test. Add one that renders the generated-output view with content containing the action-items GFM table and asserts a `<table>` renders (locks the remark-gfm decision against regression).
- **Smoke (light):** MeetingDetail + SourceCard render `<Markdown>` for a summary containing a heading (markdown parsed, not literal).
- Gate: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run` green.

## 6. Acceptance criteria

1. The reader summary pane renders markdown formatting (headings, bold/italic, ordered/unordered lists, inline + fenced code, blockquotes, links, GFM tables, strikethrough, task lists) instead of literal markup.
2. The same `<Markdown>` renders identically on the assistant-chat, generated-output, MeetingDetail, and SourceCard surfaces; the action-items output table renders as a real table.
3. Styling uses Harbor tokens (correct in light + dark); no `@tailwindcss/typography` / `prose` dependency.
4. No raw HTML from markdown is executed/rendered (no `rehype-raw`); `javascript:` URLs are neutralized.
5. `npm run typecheck` (node+web) + lint clean; all tests pass, including the new `markdown.test.tsx`, the updated `SourceReader.summaryTop.test.tsx`, the existing Chat bold test, and the new Actionables-table test.

## 7. Out of scope

`@tailwindcss/typography`; external-link open handling (open in OS browser); markdown editing; the Explore search-result preview (`Explore.tsx:348`, truncated plaintext via `highlightMatch`); transcript export formatting.
