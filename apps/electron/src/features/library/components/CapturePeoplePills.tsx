import { PersonAvatar } from '@/components/harbor/PersonAvatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { CapturePerson } from '../types/captureMeta'

interface CapturePeoplePillsProps {
  people: CapturePerson[]
  /** Max visible pills before "+N" overflow. Default 3. */
  cap?: number
  /** Called when user clicks the overflow "+N" pill (e.g. to open source reader). */
  onOverflowClick?: () => void
}

/**
 * Renders a row of person avatar pills capped at `cap` with an overflow "+N" button.
 * People are derived from meeting attendees (slice 1) or diarized speakers (slice 2).
 */
export function CapturePeoplePills({ people, cap = 3, onOverflowClick }: CapturePeoplePillsProps) {
  if (people.length === 0) return null

  const visible = people.slice(0, cap)
  const overflow = people.slice(cap)
  const hasOverflow = overflow.length > 0

  return (
    <div
      className="flex items-center gap-1 flex-wrap"
      role="group"
      aria-label={`${people.length} people`}
    >
      {visible.map((person) => (
        <span
          key={person.name}
          className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-1.5 py-0.5"
          title={person.name}
        >
          <PersonAvatar name={person.name} size={16} />
          <span className="text-[10.5px] font-medium text-ink-muted leading-none truncate max-w-[80px]">
            {person.name}
          </span>
        </span>
      ))}

      {hasOverflow && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10.5px] font-medium text-ink-muted leading-none hover:bg-surface-hover transition-colors"
                onClick={onOverflowClick}
                aria-label="Show all attendees"
              >
                +{overflow.length}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">{overflow.map((p) => p.name).join(', ')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  )
}
