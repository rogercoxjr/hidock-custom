/**
 * Stats bar with clickable filter chips for recording location
 */

import { memo } from 'react'
import { Cloud, HardDrive, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

type LocationFilter = 'all' | 'device-only' | 'local-only' | 'both'
type SortOption = 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc' | 'size-desc'

interface RecordingStats {
  total: number
  deviceOnly: number
  localOnly: number
  both: number
}

interface CalendarStatsBarProps {
  stats: RecordingStats
  locationFilter: LocationFilter
  sortBy: SortOption
  showListView: boolean
  deviceConnected: boolean
  onLocationFilterChange: (filter: LocationFilter) => void
  onSortChange: (sort: SortOption) => void
}

const chipBase =
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] transition-colors'

export const CalendarStatsBar = memo(function CalendarStatsBar({
  stats,
  locationFilter,
  sortBy,
  showListView,
  deviceConnected,
  onLocationFilterChange,
  onSortChange,
}: CalendarStatsBarProps) {
  return (
    <div className="flex flex-shrink-0 items-center gap-[var(--space-4)] border-b border-border bg-surface-sunken px-[var(--space-5)] py-[9px] font-mono text-[11px] text-ink-muted">
      {/* All recordings chip */}
      <button
        onClick={() => onLocationFilterChange('all')}
        className={cn(
          chipBase,
          locationFilter === 'all'
            ? 'bg-accent-strong-soft text-[var(--accent-soft-text)]'
            : 'text-ink-muted hover:bg-surface-hover'
        )}
      >
        <span className="font-semibold text-ink">{stats.total}</span>
        recording{stats.total !== 1 ? 's' : ''}
      </button>

      {/* Device-only chip */}
      {stats.deviceOnly > 0 && (
        <button
          onClick={() => onLocationFilterChange(locationFilter === 'device-only' ? 'all' : 'device-only')}
          className={cn(
            chipBase,
            locationFilter === 'device-only'
              ? 'bg-warning-soft text-warning'
              : 'text-ink-muted hover:bg-surface-hover'
          )}
        >
          <Cloud className="h-3 w-3 text-warning" />
          {stats.deviceOnly} on device
        </button>
      )}

      {/* Downloaded chip */}
      {stats.localOnly > 0 && (
        <button
          onClick={() => onLocationFilterChange(locationFilter === 'local-only' ? 'all' : 'local-only')}
          className={cn(
            chipBase,
            locationFilter === 'local-only'
              ? 'bg-accent-strong-soft text-[var(--accent-soft-text)]'
              : 'text-ink-muted hover:bg-surface-hover'
          )}
        >
          <HardDrive className="h-3 w-3 text-accent-strong" />
          {stats.localOnly} downloaded
        </button>
      )}

      {/* Synced chip */}
      {stats.both > 0 && (
        <button
          onClick={() => onLocationFilterChange(locationFilter === 'both' ? 'all' : 'both')}
          className={cn(
            chipBase,
            locationFilter === 'both'
              ? 'bg-success-soft text-success'
              : 'text-ink-muted hover:bg-surface-hover'
          )}
        >
          <Check className="h-3 w-3 text-success" />
          {stats.both} synced
        </button>
      )}

      {!deviceConnected && <span className="ml-1 text-ink-muted">(device not connected)</span>}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Legend — only in calendar view */}
      {!showListView && (
        <div className="hidden items-center gap-[var(--space-4)] md:flex">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-[11px] w-[11px] rounded-[3px] bg-accent-strong" />
            recording
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-[11px] w-[11px] rounded-[3px] border-[1.5px] border-dashed border-border-strong" />
            meeting · no recording
          </span>
        </div>
      )}

      {/* Sort dropdown - only in list view */}
      {showListView && (
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">Sort:</span>
          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as SortOption)}
            className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11px] text-ink"
          >
            <option value="date-desc">Newest first</option>
            <option value="date-asc">Oldest first</option>
            <option value="name-asc">Name A-Z</option>
            <option value="name-desc">Name Z-A</option>
            <option value="size-desc">Largest first</option>
          </select>
        </div>
      )}
    </div>
  )
})

// Export types for use in parent components
export type { LocationFilter, SortOption, RecordingStats }
