import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// Harbor pill/badge. Soft tonal variants for status, labels, insights, etc.
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-medium leading-none transition-colors',
  {
    variants: {
      variant: {
        default: 'border-border bg-surface-sunken text-ink',
        outline: 'border-border bg-transparent text-ink-muted',
        primary: 'border-transparent bg-accent-strong-soft text-accent-strong',
        accent: 'border-transparent bg-accent-2-soft text-accent-2',
        success: 'border-transparent bg-success-soft text-success',
        warning: 'border-transparent bg-warning-soft text-warning',
        danger: 'border-transparent bg-danger-soft text-danger'
      },
      size: {
        sm: 'px-2 py-1 text-[10px]',
        md: 'px-2.5 py-1 text-xs'
      }
    },
    defaultVariants: { variant: 'default', size: 'sm' }
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />
}

export { Badge, badgeVariants }
