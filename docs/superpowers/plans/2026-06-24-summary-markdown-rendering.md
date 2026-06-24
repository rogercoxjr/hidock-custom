# Summary Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the (markdown) summary as formatted markdown via a shared, Harbor-styled `<Markdown>` component, and reuse it on all five surfaces that render markdown.

**Architecture:** One new presentational primitive `components/ui/markdown.tsx` wraps `react-markdown` + `remark-gfm` with a Harbor-tokened element map (no `prose`/typography plugin). Five call sites swap their bespoke/raw markdown rendering to `<Markdown>`. No main-process or behavior changes.

**Tech Stack:** React + TypeScript + Tailwind (Harbor tokens), `react-markdown@^10.1.0` (already installed), `remark-gfm@^4` (added in Task 1), Vitest + @testing-library/react.

## Global Constraints

- Styling uses existing Harbor Tailwind tokens only (`text-ink`, `text-ink-muted`, `text-foreground`, `surface-sunken`, `border`, `border-strong`, `accent-strong`, `accent-strong-hover`); no hex; no `@tailwindcss/typography`/`prose`.
- `<Markdown>` must NOT enable `rehype-raw` (no raw HTML rendering); rely on react-markdown's default URL sanitization.
- The markdown `strong` renderer MUST output a real `<strong>` element (an existing Chat test asserts `**bold**`→`<strong>`).
- Each markdown element renderer destructures and drops the `node` prop (`({ node, ...props }) => …`) so it isn't spread onto the DOM.
- Fenced code is detected as block via a `language-*` class; a language-less fenced or indented block falls back to inline styling (accepted, documented).
- No behavior changes; do not touch device/USB or main-process code.
- After every task the full gate is green: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`.
- Every commit ends with the standard footer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01CcSVaE8gqnwmXHaCtfTVN9`.

## File Structure

- **Create** `apps/electron/src/components/ui/markdown.tsx` — the shared `<Markdown>` primitive (react-markdown + remark-gfm + Harbor element map). One responsibility: render a markdown string as Harbor-styled React.
- **Create** `apps/electron/src/components/ui/__tests__/markdown.test.tsx` — component behavior + safety tests.
- **Modify** `apps/electron/package.json` — add `remark-gfm` dependency.
- **Modify** `apps/electron/src/features/library/components/SourceReader.tsx:998` — summary pane → `<Markdown>`.
- **Modify** `apps/electron/src/features/library/components/__tests__/SourceReader.summaryTop.test.tsx` — add a markdown-rendering assertion.
- **Modify** `apps/electron/src/pages/Chat.tsx` — assistant message → `<Markdown>`; move `whitespace-pre-wrap`; drop `react-markdown` import.
- **Modify** `apps/electron/src/pages/Actionables.tsx` — generated output → `<Markdown>`; drop `prose`/`react-markdown` import.
- **Modify** `apps/electron/src/pages/MeetingDetail.tsx:606` — summary → `<Markdown>`.
- **Modify** `apps/electron/src/features/library/components/SourceCard.tsx:302` — summary → `<Markdown>`.

---

### Task 1: Shared `<Markdown>` component + remark-gfm + tests

**Files:**
- Modify: `apps/electron/package.json` (add `remark-gfm`)
- Create: `apps/electron/src/components/ui/markdown.tsx`
- Test: `apps/electron/src/components/ui/__tests__/markdown.test.tsx`

**Interfaces:**
- Produces: `export function Markdown({ children, className }: { children: string; className?: string }): JSX.Element` from `@/components/ui/markdown`. Renders `children` (a markdown string) as Harbor-styled React inside a `<div>` carrying `text-sm leading-relaxed text-foreground` + any `className`.

- [ ] **Step 1: Install remark-gfm**

Run: `cd apps/electron && npm install remark-gfm@^4`
Expected: `package.json` gains `"remark-gfm": "^4.x.x"` under dependencies; `package-lock.json` updated; install succeeds.

- [ ] **Step 2: Write the failing test**

Create `apps/electron/src/components/ui/__tests__/markdown.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Markdown } from '../markdown'

describe('Markdown', () => {
  it('renders headings as heading elements (not literal "##")', () => {
    render(<Markdown>{'## Section title'}</Markdown>)
    const h = screen.getByText('Section title')
    expect(h.tagName).toBe('H2')
  })

  it('renders bold as <strong> (Chat test depends on this)', () => {
    render(<Markdown>{'**bold**'}</Markdown>)
    expect(screen.getByText('bold').tagName).toBe('STRONG')
  })

  it('renders unordered lists as <ul><li>', () => {
    render(<Markdown>{'- one\n- two'}</Markdown>)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('one').closest('li')).toBeTruthy()
  })

  it('styles inline code with the pill class; language-tagged block code without it', () => {
    const { container } = render(<Markdown>{'inline `x` text\n\n```js\nblock\n```'}</Markdown>)
    const inline = screen.getByText('x')
    expect(inline.tagName).toBe('CODE')
    expect(inline.className).toContain('bg-surface-sunken')
    expect(inline.className).toContain('px-1')
    const pre = container.querySelector('pre')
    expect(pre).toBeTruthy()
    expect(pre?.querySelector('code')?.className ?? '').not.toContain('px-1')
  })

  it('renders GFM tables (locks remark-gfm)', () => {
    render(<Markdown>{'| A | B |\n|---|---|\n| 1 | 2 |'}</Markdown>)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('A').tagName).toBe('TH')
    expect(screen.getByText('1').tagName).toBe('TD')
  })

  it('renders GFM strikethrough and task-list checkboxes', () => {
    const { container } = render(<Markdown>{'~~gone~~\n\n- [ ] todo'}</Markdown>)
    expect(screen.getByText('gone').tagName).toBe('DEL')
    expect(container.querySelector('input[type="checkbox"]')).toBeTruthy()
  })

  it('styles links with the accent class', () => {
    render(<Markdown>{'[link](https://example.com)'}</Markdown>)
    const a = screen.getByText('link')
    expect(a.tagName).toBe('A')
    expect(a.className).toContain('text-accent-strong')
  })

  it('does not render raw HTML (no rehype-raw)', () => {
    const { container } = render(<Markdown>{'<script>alert(1)</script> and <b>x</b>'}</Markdown>)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  it('neutralizes javascript: URLs', () => {
    render(<Markdown>{'[x](javascript:alert(1))'}</Markdown>)
    const a = screen.getByText('x')
    expect((a.getAttribute('href') ?? '')).not.toContain('javascript:')
  })

  it('merges a passed className onto the wrapper', () => {
    const { container } = render(<Markdown className="text-[13.5px]">{'hi'}</Markdown>)
    expect(container.firstElementChild?.className).toContain('text-[13.5px]')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/electron && npx vitest run src/components/ui/__tests__/markdown.test.tsx`
Expected: FAIL — `Failed to resolve import "../markdown"` (the component does not exist yet).

- [ ] **Step 4: Create the component**

Create `apps/electron/src/components/ui/markdown.tsx`:

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { cn } from '@/lib/utils'

// Harbor-styled markdown. react-markdown renders no raw HTML by default and
// sanitizes URLs; we intentionally do NOT add rehype-raw. Each renderer drops
// `node` so it is not spread onto the DOM element.
const components: Components = {
  h1: ({ node, ...props }) => <h1 className="mt-4 mb-2 text-base font-semibold text-ink first:mt-0" {...props} />,
  h2: ({ node, ...props }) => <h2 className="mt-4 mb-2 text-sm font-semibold text-ink first:mt-0" {...props} />,
  h3: ({ node, ...props }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold text-ink-muted first:mt-0" {...props} />,
  h4: ({ node, ...props }) => <h4 className="mt-3 mb-1.5 text-sm font-semibold text-ink-muted first:mt-0" {...props} />,
  p: ({ node, ...props }) => <p className="mb-2 last:mb-0" {...props} />,
  ul: ({ node, ...props }) => <ul className="mb-2 list-disc space-y-1 pl-5" {...props} />,
  ol: ({ node, ...props }) => <ol className="mb-2 list-decimal space-y-1 pl-5" {...props} />,
  li: ({ node, ...props }) => <li className="leading-relaxed" {...props} />,
  strong: ({ node, ...props }) => <strong className="font-semibold text-ink" {...props} />,
  em: ({ node, ...props }) => <em className="italic" {...props} />,
  del: ({ node, ...props }) => <del className="line-through opacity-70" {...props} />,
  a: ({ node, ...props }) => (
    <a className="text-accent-strong underline underline-offset-2 hover:text-accent-strong-hover" {...props} />
  ),
  blockquote: ({ node, ...props }) => (
    <blockquote className="my-2 border-l-2 border-border-strong pl-3 text-ink-muted" {...props} />
  ),
  hr: () => <hr className="my-3 border-border" />,
  pre: ({ node, ...props }) => (
    <pre className="mb-2 overflow-x-auto rounded-md bg-surface-sunken p-3 text-[0.85em]" {...props} />
  ),
  code: ({ node, className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? '')
    return isBlock ? (
      <code className={className} {...props}>{children}</code>
    ) : (
      <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.85em]" {...props}>{children}</code>
    )
  },
  table: ({ node, ...props }) => (
    <div className="mb-2 overflow-x-auto">
      <table className="w-full border-collapse text-[0.95em]" {...props} />
    </div>
  ),
  thead: ({ node, ...props }) => <thead className="border-b border-border-strong" {...props} />,
  th: ({ node, ...props }) => <th className="px-2 py-1 text-left font-semibold text-ink" {...props} />,
  td: ({ node, ...props }) => <td className="border-t border-border px-2 py-1 align-top" {...props} />,
  // GFM task-list checkbox: keep react-markdown's disabled attr, add readOnly to
  // avoid React's controlled-without-onChange warning.
  input: ({ node, ...props }) => <input {...props} readOnly className="mr-1 align-middle accent-accent-strong" />,
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('text-sm leading-relaxed text-foreground', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
```

If TypeScript objects to a specific renderer's prop types, type that renderer's parameter with the element's intrinsic props (e.g. `(props: React.HTMLAttributes<HTMLElement>) => …`); do not loosen to `any`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/electron && npx vitest run src/components/ui/__tests__/markdown.test.tsx`
Expected: PASS (all cases). If the "block code without pill" case fails, confirm the test uses a language-tagged fence (```` ```js ````), per the Global Constraints code-detection rule.

- [ ] **Step 6: Full gate**

Run: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`
Expected: typecheck (node+web) 0 errors, lint 0 errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/electron/package.json apps/electron/package-lock.json \
        apps/electron/src/components/ui/markdown.tsx \
        apps/electron/src/components/ui/__tests__/markdown.test.tsx
git commit -m "feat(electron): shared Harbor <Markdown> component (react-markdown + remark-gfm)"
```

---

### Task 2: Render the summary pane as markdown (SourceReader)

**Files:**
- Modify: `apps/electron/src/features/library/components/SourceReader.tsx` (~line 998)
- Test: `apps/electron/src/features/library/components/__tests__/SourceReader.summaryTop.test.tsx`

**Interfaces:**
- Consumes: `Markdown` from `@/components/ui/markdown` (Task 1).

- [ ] **Step 1: Add a failing markdown-rendering test**

In `SourceReader.summaryTop.test.tsx`, add this case inside the existing `describe('SourceReader — summary at top (QOL #5)', …)` block (the existing plain-text tests stay unchanged — "This is the summary." still resolves to one `<p>`):

```tsx
  it('renders the summary as formatted markdown (headings/lists), not literal markup', async () => {
    render(
      <SourceReader
        recording={baseRecording}
        transcript={makeTranscript({ summary: '## Decisions\n\n- ship it\n- follow up' })}
      />
    )
    const heading = await screen.findByText('Decisions')
    expect(heading.tagName).toBe('H2')
    expect(screen.getByText('ship it').closest('li')).toBeTruthy()
    // not rendered as literal markdown text
    expect(screen.queryByText('## Decisions')).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReader.summaryTop.test.tsx`
Expected: FAIL — the summary currently renders inside a `<p whitespace-pre-wrap>` as literal text, so `getByText('Decisions')` finds nothing / `## Decisions` is present.

- [ ] **Step 3: Add the import**

In `SourceReader.tsx`, add to the imports (near the other `@/components/ui/*` imports):

```tsx
import { Markdown } from '@/components/ui/markdown'
```

- [ ] **Step 4: Swap the summary element**

In `SourceReader.tsx` around line 998, replace:

```tsx
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{transcript.summary}</p>
```

with:

```tsx
                    <Markdown>{transcript.summary}</Markdown>
```

Leave the surrounding container, the `summaryExpanded` collapse, the `transcript.summary &&` guard, and the "Summary" header untouched.

- [ ] **Step 5: Run the summary tests to verify they pass**

Run: `cd apps/electron && npx vitest run src/features/library/components/__tests__/SourceReader.summaryTop.test.tsx`
Expected: PASS — the new markdown case passes AND the two existing cases ("This is the summary." present; no Summary block when null) still pass.

- [ ] **Step 6: Full gate**

Run: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/electron/src/features/library/components/SourceReader.tsx \
        apps/electron/src/features/library/components/__tests__/SourceReader.summaryTop.test.tsx
git commit -m "feat(electron): render reader summary pane as markdown via <Markdown>"
```

---

### Task 3: Retrofit assistant chat + generated outputs

**Files:**
- Modify: `apps/electron/src/pages/Chat.tsx` (import line 3; bubble ~1167; assistant branch ~1174-1177)
- Modify: `apps/electron/src/pages/Actionables.tsx` (import line 3; output ~682-683)

**Interfaces:**
- Consumes: `Markdown` from `@/components/ui/markdown` (Task 1).

- [ ] **Step 1: Chat.tsx — swap import**

In `Chat.tsx`, remove:

```tsx
import ReactMarkdown from 'react-markdown'
```

and add (near the other `@/components/ui/*` imports):

```tsx
import { Markdown } from '@/components/ui/markdown'
```

- [ ] **Step 2: Chat.tsx — move `whitespace-pre-wrap` off the shared bubble**

In the message bubble (~line 1167), the shared wrapper className currently begins with `'whitespace-pre-wrap rounded-lg px-3.5 py-[11px] text-[13.5px] leading-relaxed'`. Remove the leading `whitespace-pre-wrap ` from that string (block markdown supplies its own whitespace; the user branch will carry pre-wrap instead).

- [ ] **Step 3: Chat.tsx — swap the assistant branch and add pre-wrap to the user branch**

Replace the assistant/user conditional (~1174-1180):

```tsx
                        {message.role === 'assistant' ? (
                          <div className="prose prose-sm max-w-none leading-relaxed text-[13.5px]">
                            <ReactMarkdown>{message.content}</ReactMarkdown>
                          </div>
                        ) : (
                          <p className="leading-relaxed">{message.content}</p>
                        )}
```

with:

```tsx
                        {message.role === 'assistant' ? (
                          <Markdown className="text-[13.5px]">{message.content}</Markdown>
                        ) : (
                          <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
                        )}
```

- [ ] **Step 4: Run the existing Chat markdown test to verify it still passes**

Run: `cd apps/electron && npx vitest run src/pages/__tests__/Chat.test.tsx`
Expected: PASS — `should render messages with markdown formatting` still finds `Bold text` as `<strong>` (via `<Markdown>`).

- [ ] **Step 5: Actionables.tsx — swap import**

In `Actionables.tsx`, remove `import ReactMarkdown from 'react-markdown'` and add `import { Markdown } from '@/components/ui/markdown'`.

- [ ] **Step 6: Actionables.tsx — swap the output renderer**

Replace (~682-683):

```tsx
          <div className="prose prose-sm max-w-none dark:prose-invert bg-surface-sunken p-[var(--space-4)] rounded-md border border-border">
            <ReactMarkdown>{generatedOutput?.content || ''}</ReactMarkdown>
          </div>
```

with (keep the container; drop the inert `prose`/`dark:prose-invert`):

```tsx
          <div className="bg-surface-sunken p-[var(--space-4)] rounded-md border border-border">
            <Markdown>{generatedOutput?.content || ''}</Markdown>
          </div>
```

(The action-items output template emits a GFM pipe table; `<Markdown>` + remark-gfm now renders it as a real table. Table rendering is locked by `markdown.test.tsx` from Task 1; a dedicated Actionables-dialog UI test is disproportionate and out of scope.)

- [ ] **Step 7: Full gate**

Run: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`
Expected: all green; no remaining `react-markdown` import in Chat.tsx or Actionables.tsx (`grep -n "react-markdown" src/pages/Chat.tsx src/pages/Actionables.tsx` returns nothing).

- [ ] **Step 8: Commit**

```bash
git add apps/electron/src/pages/Chat.tsx apps/electron/src/pages/Actionables.tsx
git commit -m "feat(electron): assistant chat + generated outputs use shared <Markdown>"
```

---

### Task 4: Retrofit MeetingDetail + SourceCard summaries

**Files:**
- Modify: `apps/electron/src/pages/MeetingDetail.tsx` (~line 606)
- Modify: `apps/electron/src/features/library/components/SourceCard.tsx` (~line 302)

**Interfaces:**
- Consumes: `Markdown` from `@/components/ui/markdown` (Task 1).

- [ ] **Step 1: MeetingDetail.tsx — import + swap**

Add `import { Markdown } from '@/components/ui/markdown'` (near other component imports). Replace (~606):

```tsx
                              <p className="text-sm text-foreground">{recording.transcript.summary}</p>
```

with:

```tsx
                              <Markdown>{recording.transcript.summary}</Markdown>
```

Leave the `recording.transcript.summary &&` guard, the container, and the "Summary" label untouched.

- [ ] **Step 2: SourceCard.tsx — import + swap**

Add `import { Markdown } from '@/components/ui/markdown'` (near other component imports). Replace (~302):

```tsx
                    <p className="text-sm text-foreground">{transcript.summary}</p>
```

with:

```tsx
                    <Markdown>{transcript.summary}</Markdown>
```

Leave the `transcript.summary &&` guard, the container, and the "Summary" label untouched.

- [ ] **Step 3: Full gate**

Run: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`
Expected: all green. (No dedicated tests for these two surfaces — they are one-line swaps to the Task-1-tested component; existing MeetingDetail/SourceCard tests, if any, must still pass.)

- [ ] **Step 4: Commit**

```bash
git add apps/electron/src/pages/MeetingDetail.tsx \
        apps/electron/src/features/library/components/SourceCard.tsx
git commit -m "feat(electron): MeetingDetail + SourceCard summaries use shared <Markdown>"
```

---

## Verification (end-to-end, after all tasks)

**Automated:** `cd apps/electron && npm run typecheck && npm run lint && npm run test:run` — all green, including `markdown.test.tsx` (incl. the table case) and the new SourceReader markdown assertion.

**Live (after merge to `main` + dev-server relaunch — the standing final step):**
- Open a recording whose summary contains markdown (e.g. a template-driven summary with `##` headings / `-` bullets / `**bold**`): the reader summary pane shows formatted headings, lists, and bold — not literal `##`/`-`/`**`.
- The same recording's summary on the **MeetingDetail** page and the **SourceCard** inline summary render identically formatted.
- Ask the assistant something: the answer renders formatted markdown (lists, bold) in the chat bubble.
- Generate the **Action Items** output: it renders as a real table (Owner / Action / Due Date / Status), not a row of pipes.
- Spot-check light + dark mode: headings/links/code/table read correctly with Harbor colors.
