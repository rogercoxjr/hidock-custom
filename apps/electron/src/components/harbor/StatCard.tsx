import * as React from 'react'
import { cn } from '@/lib/utils'

interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode
  value: React.ReactNode
  label: React.ReactNode
}

/**
 * Harbor stat tile — small teal icon, large serif number, muted label.
 * Used in the Home dashboard stat grid.
 */
export function StatCard({ icon, value, label, className, ...props }: StatCardProps) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface p-4 shadow-xs', className)}
      {...props}
    >
      {icon && (
        <span className="inline-flex h-[17px] w-[17px] items-center justify-center text-accent-2">
          {icon}
        </span>
      )}
      <div className="mb-px mt-2 font-display text-[1.75rem] font-semibold leading-none text-ink">
        {value}
      </div>
      <div className="text-xs text-ink-muted">{label}</div>
    </div>
  )
}
