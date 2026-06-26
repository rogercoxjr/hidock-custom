import { Filter, Cloud, HardDrive, Check, Search, ArrowUpDown, ChevronUp, ChevronDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import {
  FilterMode,
  SemanticLocationFilter,
  ExclusiveLocationFilter
} from '@/types/unified-recording'
import type { SortBy, SortOrder } from '@/store/useLibraryStore'
import type { LabelDefinition } from '@/types'
import { dotClassForToken } from '@/features/library/utils'

interface LibraryFiltersProps {
  stats: {
    total: number
    deviceOnly: number
    localOnly: number
    both: number
    onSource: number
    locallyAvailable: number
  }
  filterMode: FilterMode
  semanticFilter: SemanticLocationFilter
  exclusiveFilter: ExclusiveLocationFilter
  categoryFilter: string
  /** Smart Labels taxonomy (AppConfig.labels.items) driving the category chips. */
  categories: LabelDefinition[]
  qualityFilter: string
  statusFilter: string
  searchQuery: string
  sortBy?: SortBy
  sortOrder?: SortOrder
  onFilterModeChange: (mode: FilterMode) => void
  onSemanticFilterChange: (filter: SemanticLocationFilter) => void
  onExclusiveFilterChange: (filter: ExclusiveLocationFilter) => void
  onCategoryFilterChange: (filter: string) => void
  onQualityFilterChange: (filter: string) => void
  onStatusFilterChange: (filter: string) => void
  onSearchQueryChange: (query: string) => void
  onSortByChange?: (sortBy: SortBy) => void
  onSortOrderChange?: (order: SortOrder) => void
}

// Harbor pill-chip (matches prototype `hd-chip`). Active = solid primary, inactive = surface + border.
const chipBase =
  'rounded-full px-3 py-1.5 text-xs font-semibold transition-colors border inline-flex items-center gap-1.5'
const chipActive = 'border-transparent bg-primary text-primary-foreground'
const chipInactive = 'border-border bg-surface text-foreground hover:border-border-strong hover:text-ink'

// Harbor select control
const selectClass =
  'h-8 rounded-md border border-border bg-surface px-3 py-1 text-xs text-ink'

export function LibraryFilters({
  stats,
  filterMode,
  semanticFilter,
  exclusiveFilter,
  categoryFilter,
  categories,
  qualityFilter,
  statusFilter,
  searchQuery,
  sortBy,
  sortOrder,
  onFilterModeChange,
  onSemanticFilterChange,
  onExclusiveFilterChange,
  onCategoryFilterChange,
  onQualityFilterChange,
  onStatusFilterChange,
  onSearchQueryChange,
  onSortByChange,
  onSortOrderChange
}: LibraryFiltersProps) {
  // Determine active filter value based on mode
  const activeFilter = filterMode === 'semantic' ? semanticFilter : exclusiveFilter
  const handleFilterChange =
    filterMode === 'semantic' ? onSemanticFilterChange : onExclusiveFilterChange

  // Count active filters for the badge
  const activeFilterCount = [
    activeFilter !== 'all',
    categoryFilter !== 'all',
    qualityFilter !== 'all',
    statusFilter !== 'all',
    searchQuery.length > 0
  ].filter(Boolean).length

  return (
    <div className="flex flex-col gap-4 mt-4">
      <div className="flex flex-wrap items-center gap-4">
        {/* Active filter count badge */}
        {activeFilterCount > 0 && (
          <Badge
            variant="primary"
            size="md"
            aria-label={`${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active`}
          >
            {activeFilterCount} active
          </Badge>
        )}
        {/* Filter mode toggle */}
        <div className="flex items-center gap-2" role="group" aria-label="Filter mode">
          <span className="text-xs font-medium text-ink-muted">Mode:</span>
          <SegmentedToggle
            size="sm"
            aria-label="Filter mode"
            value={filterMode}
            onChange={onFilterModeChange}
            options={[
              {
                value: 'semantic',
                label: 'All Matching',
                title: 'Show all files matching the filter (e.g., Device shows all files from any device)'
              },
              {
                value: 'exclusive',
                label: 'Exact Only',
                title: 'Show only files in exact location (e.g., Device Only shows files not downloaded)'
              }
            ]}
          />
        </div>

        {/* Location filter */}
        <div className="flex items-center gap-2" role="group" aria-label="Location filter">
          <Filter className="h-4 w-4 text-ink-muted" />
          <div className="flex flex-wrap gap-1.5" data-testid="location-filter">
            <button
              onClick={() => handleFilterChange('all' as SemanticLocationFilter & ExclusiveLocationFilter)}
              className={`${chipBase} ${activeFilter === 'all' ? chipActive : chipInactive}`}
              aria-pressed={activeFilter === 'all'}
              aria-label="All locations"
            >
              All ({stats.total})
            </button>
            {filterMode === 'semantic' ? (
              <>
                <button
                  onClick={() => onSemanticFilterChange('on-source')}
                  className={`${chipBase} ${semanticFilter === 'on-source' ? chipActive : chipInactive}`}
                  aria-pressed={semanticFilter === 'on-source'}
                  aria-label="On device"
                >
                  <Cloud className="h-3 w-3 inline mr-1" />
                  Device ({stats.onSource})
                </button>
                <button
                  onClick={() => onSemanticFilterChange('locally-available')}
                  className={`${chipBase} ${semanticFilter === 'locally-available' ? chipActive : chipInactive}`}
                  aria-pressed={semanticFilter === 'locally-available'}
                  aria-label="Locally available"
                >
                  <HardDrive className="h-3 w-3 inline mr-1" />
                  Locally Available ({stats.locallyAvailable})
                </button>
                <button
                  onClick={() => onSemanticFilterChange('synced')}
                  className={`${chipBase} ${semanticFilter === 'synced' ? chipActive : chipInactive}`}
                  aria-pressed={semanticFilter === 'synced'}
                  aria-label="Synced to both"
                >
                  <Check className="h-3 w-3 inline mr-1" />
                  Synced ({stats.both})
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => onExclusiveFilterChange('source-only')}
                  className={`${chipBase} ${exclusiveFilter === 'source-only' ? chipActive : chipInactive}`}
                  aria-pressed={exclusiveFilter === 'source-only'}
                  aria-label="Device only"
                >
                  <Cloud className="h-3 w-3 inline mr-1" />
                  Device Only ({stats.deviceOnly})
                </button>
                <button
                  onClick={() => onExclusiveFilterChange('local-only')}
                  className={`${chipBase} ${exclusiveFilter === 'local-only' ? chipActive : chipInactive}`}
                  aria-pressed={exclusiveFilter === 'local-only'}
                  aria-label="Local only"
                >
                  <HardDrive className="h-3 w-3 inline mr-1" />
                  Local Only ({stats.localOnly})
                </button>
                <button
                  onClick={() => onExclusiveFilterChange('synced')}
                  className={`${chipBase} ${exclusiveFilter === 'synced' ? chipActive : chipInactive}`}
                  aria-pressed={exclusiveFilter === 'synced'}
                  aria-label="Synced to both"
                >
                  <Check className="h-3 w-3 inline mr-1" />
                  Synced ({stats.both})
                </button>
              </>
            )}
          </div>
        </div>

        {/* Category filter — data-driven from the Smart Labels taxonomy */}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category filter">
          {[{ id: 'all', name: 'All', color: undefined } as { id: string; name: string; color?: string }, ...categories].map((cat) => {
            const isActive = categoryFilter === cat.id
            return (
              <button
                key={cat.id}
                onClick={() => onCategoryFilterChange(cat.id)}
                className={`${chipBase} ${isActive ? chipActive : chipInactive}`}
                aria-pressed={isActive}
                aria-label={`Filter by ${cat.name}`}
              >
                {/* Per-label color dot (omitted for the All chip). On the active solid
                    chip the dot turns white so it stays visible against the fill. */}
                {cat.id !== 'all' && (
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-full ${isActive ? 'bg-white' : dotClassForToken(cat.color)}`}
                  />
                )}
                {cat.name}
              </button>
            )
          })}
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
          <Input
            placeholder="Search captures..."
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            className="pl-9 h-8"
            aria-label="Search captures"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {/* Sort Controls */}
        {onSortByChange && onSortOrderChange && (
          <div className="flex items-center gap-2">
            <ArrowUpDown className="h-4 w-4 text-ink-muted" />
            <span className="text-xs font-medium text-ink-muted">Sort:</span>
            <select
              value={sortBy ?? 'date'}
              onChange={(e) => onSortByChange(e.target.value as SortBy)}
              className={selectClass}
              aria-label="Sort by"
            >
              <option value="date">Date</option>
              <option value="name">Name</option>
              <option value="duration">Duration</option>
              <option value="quality">Quality</option>
            </select>
            <button
              onClick={() => onSortOrderChange(sortOrder === 'asc' ? 'desc' : 'asc')}
              className="h-8 px-2 rounded-md border border-border bg-surface text-xs font-medium text-ink hover:bg-surface-hover transition-colors inline-flex items-center gap-1"
              aria-label={`Sort ${sortOrder === 'asc' ? 'ascending' : 'descending'}`}
              title={`Currently ${sortOrder === 'asc' ? 'ascending' : 'descending'} - click to toggle`}
            >
              {sortOrder === 'asc' ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" />
                  Asc
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" />
                  Desc
                </>
              )}
            </button>
          </div>
        )}

        {/* Quality Filter */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink-muted">Quality:</span>
          <select
            value={qualityFilter}
            onChange={(e) => onQualityFilterChange(e.target.value)}
            className={selectClass}
            aria-label="Filter by quality rating"
          >
            <option value="all">All Ratings</option>
            <option value="valuable">Valuable</option>
            <option value="archived">Archived</option>
            <option value="low-value">Low-Value</option>
            <option value="unrated">Unrated</option>
          </select>
        </div>

        {/* Status Filter */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink-muted">Status:</span>
          <select
            value={statusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value)}
            className={selectClass}
            aria-label="Filter by processing status"
          >
            <option value="all">All Statuses</option>
            <option value="processing">Processing</option>
            <option value="ready">Ready</option>
            <option value="enriched">Enriched</option>
          </select>
        </div>
      </div>
    </div>
  )
}
