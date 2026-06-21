/**
 * Calendar header with navigation, sync controls, and view toggles
 */

import { memo } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw, RotateCw, Calendar as CalendarIcon, List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Eyebrow } from '@/components/harbor/Eyebrow'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import type { CalendarViewType } from '@/lib/calendar-utils'

interface CalendarHeaderProps {
  title: string
  showListView: boolean
  calendarView: CalendarViewType
  calendarSyncing: boolean
  lastSync: string | null
  autoSyncEnabled: boolean
  hideEmptyMeetings: boolean
  // C-CAL-007: Sync interval display (configurable via Settings)
  syncIntervalMinutes?: number
  formatLastSync: () => string
  onNavigatePrev: () => void
  onNavigateNext: () => void
  onGoToToday: () => void
  onSync: () => Promise<void>
  onAutoSyncToggle: (enabled: boolean) => void
  onHideEmptyToggle: (enabled: boolean) => void
  onViewToggle: (showList: boolean) => void
  onCalendarViewChange: (view: CalendarViewType) => void
}

export const CalendarHeader = memo(function CalendarHeader({
  title,
  showListView,
  calendarView,
  calendarSyncing,
  lastSync,
  autoSyncEnabled,
  hideEmptyMeetings,
  formatLastSync,
  onNavigatePrev,
  onNavigateNext,
  onGoToToday,
  onSync,
  onAutoSyncToggle,
  syncIntervalMinutes,
  onHideEmptyToggle,
  onViewToggle,
  onCalendarViewChange,
}: CalendarHeaderProps) {
  return (
    <header className="flex flex-shrink-0 items-center gap-4 border-b border-border px-[var(--space-5)] pb-[var(--space-3)] pt-[var(--space-4)]">
      <div className="min-w-0">
        <Eyebrow>Calendar</Eyebrow>
        <h1 className="mt-1 truncate font-display text-[1.75rem] font-semibold tracking-[-0.02em] text-ink">
          {title}
        </h1>
      </div>

      {/* Date navigation - only show in calendar view */}
      {!showListView && (
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={onNavigatePrev}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={onGoToToday}>
            Today
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={onNavigateNext}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-4">
        {/* Sync status */}
        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
          {calendarSyncing ? (
            <span className="flex items-center gap-1.5">
              <RefreshCw className="h-3 w-3 animate-spin text-accent-2" />
              Syncing…
            </span>
          ) : (
            <>
              {lastSync && (
                <span className="flex items-center gap-1.5">
                  <RotateCw className="h-[13px] w-[13px] text-success" />
                  synced {formatLastSync()}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={onSync}
                title="Clear cache and resync calendar"
                className="h-6 w-6 text-ink-muted hover:text-ink"
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            </>
          )}
          <Switch
            id="auto-sync-header"
            checked={autoSyncEnabled}
            onCheckedChange={onAutoSyncToggle}
            className="scale-75"
          />
          <Label
            htmlFor="auto-sync-header"
            className="cursor-pointer font-mono text-[11px] text-ink-muted"
            title={syncIntervalMinutes ? `Auto-sync every ${syncIntervalMinutes} minutes` : 'Auto-sync'}
          >
            auto{syncIntervalMinutes ? ` (${syncIntervalMinutes}m)` : ''}
          </Label>
        </div>

        {/* Hide empty meetings toggle */}
        <div className="flex items-center gap-2">
          <Switch
            id="hide-empty"
            checked={hideEmptyMeetings}
            onCheckedChange={onHideEmptyToggle}
            className="scale-75"
          />
          <Label htmlFor="hide-empty" className="cursor-pointer font-mono text-[11px] text-ink-muted">
            hide empty
          </Label>
        </div>

        {/* Calendar/List toggle */}
        <SegmentedToggle<'calendar' | 'list'>
          size="sm"
          aria-label="Calendar or list view"
          value={showListView ? 'list' : 'calendar'}
          onChange={(v) => onViewToggle(v === 'list')}
          options={[
            { value: 'calendar', label: 'Week', icon: <CalendarIcon className="h-3.5 w-3.5" />, title: 'Calendar view' },
            { value: 'list', label: 'List', icon: <List className="h-3.5 w-3.5" />, title: 'List view' },
          ]}
        />

        {/* View mode buttons (only for calendar view) */}
        {!showListView && (
          <SegmentedToggle<CalendarViewType>
            size="sm"
            aria-label="Calendar range"
            value={calendarView}
            onChange={onCalendarViewChange}
            options={[
              { value: 'day', label: 'Day' },
              { value: 'workweek', label: 'Work' },
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month' },
            ]}
          />
        )}
      </div>
    </header>
  )
})
