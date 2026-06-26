import * as React from 'react'
import { cn } from '@/lib/utils'

interface EyebrowProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 'accent' = teal (default, matches the prototype); 'muted' = grey overline. */
  tone?: 'accent' | 'muted'
}

/**
 * Harbor eyebrow / overline — mono, uppercase, wide tracking. Sits above
 * serif headings across Home, Library, Settings, etc.
 */
export function Eyebrow({ tone = 'accent', className, children, ...props }: EyebrowProps) {
  return (
    <div
      className={cn(
        'font-mono text-[10.5px] font-medium uppercase tracking-[0.12em]',
        tone === 'accent' ? 'text-accent-2' : 'text-ink-muted',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
