import { Badge } from '@/components/ui/badge'
import type { CaptureLabel } from '../types/captureMeta'

interface CaptureLabelChipsProps {
  labels: CaptureLabel[]
}

/**
 * Renders a row of category dot-chips from a CaptureLabel array.
 * Each chip is a Harbor Badge (size sm) with an optional leading colored dot.
 */
export function CaptureLabelChips({ labels }: CaptureLabelChipsProps) {
  if (labels.length === 0) return null

  return (
    <div className="flex items-center flex-wrap gap-1" aria-label="Capture labels">
      {labels.map((label) => (
        <Badge key={`${label.kind}-${label.text}`} variant="default" size="sm">
          {label.colorClass && (
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${label.colorClass}`}
              aria-hidden
            />
          )}
          {label.text}
        </Badge>
      ))}
    </div>
  )
}
