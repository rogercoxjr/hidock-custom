import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { cn } from '@/lib/utils'

// Harbor-styled markdown. react-markdown renders no raw HTML by default and
// sanitizes URLs; we intentionally do NOT add rehype-raw. Each renderer drops
// `node` (prefixed _node to satisfy the no-unused-vars rule) so it is not
// spread onto the DOM element.
const components: Components = {
  h1: ({ node: _node, ...props }) => <h1 className="mt-4 mb-2 text-base font-semibold text-ink first:mt-0" {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className="mt-4 mb-2 text-sm font-semibold text-ink first:mt-0" {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold text-ink-muted first:mt-0" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mt-3 mb-1.5 text-sm font-semibold text-ink-muted first:mt-0" {...props} />,
  p: ({ node: _node, ...props }) => <p className="mb-2 last:mb-0" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="mb-2 list-disc space-y-1 pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="mb-2 list-decimal space-y-1 pl-5" {...props} />,
  li: ({ node: _node, ...props }) => <li className="leading-relaxed" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-ink" {...props} />,
  em: ({ node: _node, ...props }) => <em className="italic" {...props} />,
  del: ({ node: _node, ...props }) => <del className="line-through opacity-70" {...props} />,
  a: ({ node: _node, ...props }) => (
    <a className="text-accent-strong underline underline-offset-2 hover:text-accent-strong-hover" {...props} />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-2 border-l-2 border-border-strong pl-3 text-ink-muted" {...props} />
  ),
  hr: () => <hr className="my-3 border-border" />,
  pre: ({ node: _node, ...props }) => (
    <pre className="mb-2 overflow-x-auto rounded-md bg-surface-sunken p-3 text-[0.85em]" {...props} />
  ),
  code: ({ node: _node, className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? '')
    return isBlock ? (
      <code className={className} {...props}>{children}</code>
    ) : (
      <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.85em]" {...props}>{children}</code>
    )
  },
  table: ({ node: _node, ...props }) => (
    <div className="mb-2 overflow-x-auto">
      <table className="w-full border-collapse text-[0.95em]" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="border-b border-border-strong" {...props} />,
  th: ({ node: _node, ...props }) => <th className="px-2 py-1 text-left font-semibold text-ink" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border-t border-border px-2 py-1 align-top" {...props} />,
  // GFM task-list checkbox: keep react-markdown's disabled attr, add readOnly to
  // avoid React's controlled-without-onChange warning.
  input: ({ node: _node, ...props }) => <input {...props} readOnly className="mr-1 align-middle accent-accent-strong" />,
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
