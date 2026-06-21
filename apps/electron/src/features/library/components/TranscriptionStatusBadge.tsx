import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'

interface TranscriptionStatusBadgeProps {
  status: 'none' | 'pending' | 'processing' | 'complete' | 'error'
  compact?: boolean
  className?: string
}

// Human-readable status text mapping
const STATUS_LABELS: Record<string, string> = {
  none: 'Not transcribed',
  pending: 'Queued',
  processing: 'In Progress',
  complete: 'Transcribed',
  error: 'Failed'
}

// Harbor Badge variant per status
const STATUS_VARIANTS: Record<string, 'default' | 'warning' | 'success' | 'danger'> = {
  none: 'default',
  pending: 'warning',
  processing: 'warning',
  complete: 'success',
  error: 'danger'
}

// Compact dot colors (Harbor status tokens)
const DOT_STYLES: Record<string, string> = {
  none: 'bg-ink-muted/40',
  pending: 'bg-warning',
  processing: 'bg-warning animate-pulse',
  complete: 'bg-success',
  error: 'bg-danger'
}

export function TranscriptionStatusBadge({ status, compact, className }: TranscriptionStatusBadgeProps) {
  if (compact) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`inline-block h-2 w-2 rounded-full shrink-0 ${DOT_STYLES[status]} ${className || ''}`}
              aria-label={STATUS_LABELS[status]}
            />
          </TooltipTrigger>
          <TooltipContent>
            <p>{STATUS_LABELS[status]}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <Badge variant={STATUS_VARIANTS[status]} className={className}>
      {STATUS_LABELS[status]}
    </Badge>
  )
}
