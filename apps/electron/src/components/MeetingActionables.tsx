import { useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Eyebrow } from '@/components/harbor/Eyebrow'
import { CheckCircle2, Circle, AlertCircle, Clock } from 'lucide-react'
import { formatDateTime } from '@/lib/utils'
import type { Actionable } from '@/types'

interface MeetingActionablesProps {
  actionables: Actionable[]
}

const STATUS_ICONS = {
  pending: Circle,
  in_progress: Clock,
  generated: CheckCircle2,
  shared: CheckCircle2,
  dismissed: AlertCircle
} as const

const STATUS_COLORS = {
  pending: 'text-ink-muted',
  in_progress: 'text-accent-strong',
  generated: 'text-success',
  shared: 'text-success',
  dismissed: 'text-danger'
} as const

export function MeetingActionables({ actionables }: MeetingActionablesProps) {
  // Group by status for better organization
  const groupedActionables = useMemo(() => {
    return {
      pending: actionables.filter(a => a.status === 'pending'),
      inProgress: actionables.filter(a => a.status === 'in_progress'),
      generated: actionables.filter(a => a.status === 'generated'),
      shared: actionables.filter(a => a.status === 'shared')
    }
  }, [actionables])

  const completedCount = groupedActionables.generated.length + groupedActionables.shared.length

  if (actionables.length === 0) {
    return (
      <Card className="bg-surface">
        <CardContent className="p-[var(--space-5)]">
          <Eyebrow className="mb-3">Actionables</Eyebrow>
          <p className="py-8 text-center text-sm text-ink-muted">
            No actionables found for this meeting.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="bg-surface">
      <CardContent className="space-y-4 p-[var(--space-5)]">
        <div className="flex items-center justify-between">
          <Eyebrow>Actionables</Eyebrow>
          <div className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
            <span>{actionables.length} total</span>
            {completedCount > 0 && (
              <span>· {completedCount} completed</span>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {actionables.map((actionable) => {
            const StatusIcon = STATUS_ICONS[actionable.status] || Circle
            const statusColor = STATUS_COLORS[actionable.status] || 'text-ink-muted'

            return (
              <div
                key={actionable.id}
                className="flex items-start gap-3 rounded-lg border border-border bg-surface-sunken p-3 transition-colors hover:border-border-strong"
              >
                <StatusIcon className={`mt-0.5 h-5 w-5 shrink-0 ${statusColor}`} />

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium leading-tight text-ink">{actionable.title}</p>
                    <Badge variant="primary" size="sm" className="shrink-0 capitalize">
                      {actionable.type}
                    </Badge>
                  </div>

                  {actionable.description && (
                    <p className="line-clamp-2 text-sm text-ink-muted">
                      {actionable.description}
                    </p>
                  )}

                  <div className="flex items-center gap-2 font-mono text-[10.5px] text-ink-muted">
                    <span className="capitalize">{actionable.status.replace('_', ' ')}</span>
                    <span>·</span>
                    <span>Created {formatDateTime(actionable.createdAt)}</span>
                    {actionable.generatedAt && (
                      <>
                        <span>·</span>
                        <span>Generated {formatDateTime(actionable.generatedAt)}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
