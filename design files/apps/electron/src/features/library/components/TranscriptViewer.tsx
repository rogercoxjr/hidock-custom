/**
 * TranscriptViewer Component
 *
 * A reusable component for displaying transcripts with interactive timestamps.
 * Parses timestamps, renders TimeAnchor components, highlights the current segment,
 * and auto-scrolls during playback.
 */

import { useEffect, useRef, useMemo, useState } from 'react'
import { TimeAnchor } from './TimeAnchor'
import { ChevronDown, ChevronRight, ListOrdered, Users } from 'lucide-react'
import { Eyebrow } from '@/components/harbor/Eyebrow'
import { PersonAvatar, avatarColor } from '@/components/harbor/PersonAvatar'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import { formatTimestamp } from '../utils/formatTimestamp'
import type { Turn } from '../types/turns'

interface TranscriptViewerProps {
  transcript: string
  turns?: Turn[]
  speakerNames?: Record<string, string>
  currentTimeMs?: number
  onSeek: (startMs: number, endMs?: number) => void
  showSummary?: boolean
  showActionItems?: boolean
  summary?: string
  actionItems?: string[]
}

interface TranscriptSegment {
  startMs: number
  endMs?: number
  text: string
  speaker?: string
}

type ViewMode = 'timeline' | 'by-speaker'

/**
 * Parse speaker name from text.
 * Supports formats: "Speaker Name:" or "[Speaker Name]" at the start of text
 */
function parseSpeaker(text: string): { speaker: string | undefined; remainingText: string } {
  // Try "Speaker Name:" format
  const colonMatch = text.match(/^([A-Z][^:]*?):\s*(.*)/)
  if (colonMatch) {
    return { speaker: colonMatch[1].trim(), remainingText: colonMatch[2].trim() }
  }

  // Try "[Speaker Name]" format
  const bracketMatch = text.match(/^\[([^\]]+)\]\s*(.*)/)
  if (bracketMatch) {
    return { speaker: bracketMatch[1].trim(), remainingText: bracketMatch[2].trim() }
  }

  return { speaker: undefined, remainingText: text }
}

/**
 * Parse timestamps from transcript text.
 * Supports formats: [MM:SS], [HH:MM:SS], MM:SS, HH:MM:SS
 */
function parseTimestamp(timestampStr: string): number | null {
  // Remove brackets if present
  const cleaned = timestampStr.replace(/[[\]]/g, '').trim()

  // Split by colons
  const parts = cleaned.split(':').map(part => parseInt(part, 10))

  if (parts.some(isNaN)) {
    return null
  }

  let totalSeconds = 0

  if (parts.length === 2) {
    // MM:SS format
    const [minutes, seconds] = parts
    totalSeconds = minutes * 60 + seconds
  } else if (parts.length === 3) {
    // HH:MM:SS format
    const [hours, minutes, seconds] = parts
    totalSeconds = hours * 3600 + minutes * 60 + seconds
  } else {
    return null
  }

  return totalSeconds * 1000 // Convert to milliseconds
}

/**
 * Parse transcript into segments with timestamps.
 * Detects timestamps in formats: [MM:SS], [HH:MM:SS], bare MM:SS, HH:MM:SS at line start
 */
function parseTranscriptSegments(transcript: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []

  // Regex to match timestamps at the start of a line (with optional brackets)
  // Matches: [00:15], [00:15:30], 00:15, 00:15:30 at line start
  const timestampRegex = /^(\[?\d{1,2}:\d{2}(?::\d{2})?\]?)\s+(.*)$/gm

  let match: RegExpExecArray | null

  while ((match = timestampRegex.exec(transcript)) !== null) {
    const [, timestampStr, text] = match
    const startMs = parseTimestamp(timestampStr)

    if (startMs !== null) {
      // Set endMs of previous segment
      if (segments.length > 0) {
        segments[segments.length - 1].endMs = startMs
      }

      // Parse speaker name from text
      const { speaker, remainingText } = parseSpeaker(text.trim())

      segments.push({
        startMs,
        text: remainingText,
        speaker
      })
    }
  }

  // If no timestamps found, return entire transcript as single segment
  if (segments.length === 0) {
    return [{
      startMs: 0,
      text: transcript.trim()
    }]
  }

  return segments
}

export function TranscriptViewer({
  transcript,
  turns,
  speakerNames,
  currentTimeMs,
  onSeek,
  showSummary = true,
  showActionItems = true,
  summary,
  actionItems
}: TranscriptViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeSegmentRef = useRef<HTMLDivElement>(null)

  const [summaryExpanded, setSummaryExpanded] = useState(true)
  const [actionItemsExpanded, setActionItemsExpanded] = useState(true)
  const [transcriptExpanded, setTranscriptExpanded] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('timeline')

  const hasStructuredTurns = !!turns && turns.length > 0

  // Parse transcript into segments (structured turns take precedence)
  const segments = useMemo(() => {
    if (hasStructuredTurns) {
      return turns!.map((t) => ({
        startMs: t.startMs,
        endMs: t.endMs,
        text: t.text,
        speaker: t.speaker
      }))
    }
    return parseTranscriptSegments(transcript)
  }, [hasStructuredTurns, turns, transcript])

  // Find current segment index based on currentTimeMs
  const currentSegmentIndex = useMemo(() => {
    if (currentTimeMs === undefined) return -1

    return segments.findIndex((seg, i) => {
      const isAfterStart = currentTimeMs >= seg.startMs
      const isBeforeEnd = i === segments.length - 1 || (seg.endMs && currentTimeMs < seg.endMs)
      return isAfterStart && isBeforeEnd
    })
  }, [segments, currentTimeMs])

  // Group segments per speaker for the by-speaker view (presentation grouping
  // derived from the same segment data — no extra data source).
  const speakerGroups = useMemo(() => {
    const order: string[] = []
    const map = new Map<string, { label: string; durationMs: number; segments: TranscriptSegment[] }>()
    let totalDurationMs = 0

    for (const seg of segments) {
      const key = seg.speaker ?? 'Unknown'
      const segDuration = seg.endMs && seg.endMs > seg.startMs ? seg.endMs - seg.startMs : 0
      totalDurationMs += segDuration
      if (!map.has(key)) {
        order.push(key)
        map.set(key, { label: key, durationMs: 0, segments: [] })
      }
      const entry = map.get(key)!
      entry.durationMs += segDuration
      entry.segments.push(seg)
    }

    const groups = order.map((key) => {
      const entry = map.get(key)!
      const name = speakerNames?.[key] ?? key
      return {
        key,
        name,
        durationMs: entry.durationMs,
        segCount: entry.segments.length,
        pct: totalDurationMs > 0 ? entry.durationMs / totalDurationMs : 0,
        color: avatarColor(name),
        segments: entry.segments
      }
    })

    return { groups, totalDurationMs }
  }, [segments, speakerNames])

  // Auto-scroll to current segment during playback (timeline view only)
  useEffect(() => {
    if (viewMode === 'timeline' && currentSegmentIndex >= 0 && activeSegmentRef.current) {
      activeSegmentRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      })
    }
  }, [currentSegmentIndex, viewMode])

  // If transcript has no timestamps, render as plain text
  const hasTimestamps = hasStructuredTurns || segments.length > 1 || (segments.length === 1 && segments[0].startMs > 0)

  // The by-speaker grouping only makes sense for structured, timestamped turns.
  const canGroupBySpeaker = hasStructuredTurns && hasTimestamps
  const effectiveView: ViewMode = canGroupBySpeaker ? viewMode : 'timeline'

  return (
    <div className="space-y-4">
      {/* Summary Section */}
      {showSummary && summary && (
        <div>
          <button
            onClick={() => setSummaryExpanded(!summaryExpanded)}
            className="flex w-full items-center justify-between rounded-lg border border-border bg-surface-sunken p-3 transition-colors hover:bg-surface-hover"
            aria-expanded={summaryExpanded}
          >
            <Eyebrow tone="muted">Summary</Eyebrow>
            {summaryExpanded ? (
              <ChevronDown className="h-4 w-4 text-ink-muted" />
            ) : (
              <ChevronRight className="h-4 w-4 text-ink-muted" />
            )}
          </button>
          {summaryExpanded && (
            <div className="mt-2 rounded-lg border border-border bg-surface p-3 shadow-xs">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{summary}</p>
            </div>
          )}
        </div>
      )}

      {/* Action Items Section */}
      {showActionItems && actionItems && actionItems.length > 0 && (
        <div>
          <button
            onClick={() => setActionItemsExpanded(!actionItemsExpanded)}
            className="flex w-full items-center justify-between rounded-lg border border-border bg-surface-sunken p-3 transition-colors hover:bg-surface-hover"
            aria-expanded={actionItemsExpanded}
          >
            <Eyebrow tone="muted">Action Items</Eyebrow>
            {actionItemsExpanded ? (
              <ChevronDown className="h-4 w-4 text-ink-muted" />
            ) : (
              <ChevronRight className="h-4 w-4 text-ink-muted" />
            )}
          </button>
          {actionItemsExpanded && (
            <div className="mt-2 rounded-lg border border-border bg-surface p-3 shadow-xs">
              <ul className="list-inside list-disc space-y-1 text-sm text-foreground">
                {actionItems.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Full Transcript Section */}
      <div>
        <button
          onClick={() => setTranscriptExpanded(!transcriptExpanded)}
          className="flex w-full items-center justify-between rounded-lg border border-border bg-surface-sunken p-3 transition-colors hover:bg-surface-hover"
          aria-expanded={transcriptExpanded}
        >
          <Eyebrow tone="muted">Full Transcript</Eyebrow>
          {transcriptExpanded ? (
            <ChevronDown className="h-4 w-4 text-ink-muted" />
          ) : (
            <ChevronRight className="h-4 w-4 text-ink-muted" />
          )}
        </button>
        {transcriptExpanded && (
          <div ref={containerRef} className="mt-2 max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-surface p-3 shadow-xs">
            {hasTimestamps ? (
              <div className="space-y-4">
                {/* View-mode toggle (timeline / by speaker) — only when grouping is meaningful */}
                {canGroupBySpeaker && (
                  <div className="flex items-center justify-end">
                    <SegmentedToggle<ViewMode>
                      size="sm"
                      aria-label="Transcript view"
                      value={viewMode}
                      onChange={setViewMode}
                      options={[
                        { value: 'timeline', label: 'Timeline', icon: <ListOrdered className="h-3.5 w-3.5" />, title: 'Timeline view' },
                        { value: 'by-speaker', label: 'By speaker', icon: <Users className="h-3.5 w-3.5" />, title: 'Group by speaker' }
                      ]}
                    />
                  </div>
                )}

                {effectiveView === 'timeline' ? (
                  /* ============ TIMELINE VIEW ============ */
                  <div className="space-y-1">
                    {segments.map((segment, i) => {
                      const isActive = i === currentSegmentIndex
                      const speakerLabel = segment.speaker
                        ? (speakerNames?.[segment.speaker] ?? segment.speaker)
                        : undefined
                      const dotColor = segment.speaker ? avatarColor(speakerLabel ?? segment.speaker) : undefined
                      return (
                        <div
                          key={i}
                          ref={isActive ? activeSegmentRef : null}
                          className={`flex gap-3 rounded-md border-l-2 px-3 py-2 transition-colors ${
                            isActive
                              ? 'border-primary bg-accent-strong-soft/40'
                              : 'border-transparent hover:bg-surface-hover'
                          }`}
                        >
                          {/* left gutter: mono accent timestamp */}
                          <div className="flex w-12 flex-none flex-col items-start gap-1 pt-0.5">
                            <TimeAnchor
                              startMs={segment.startMs}
                              endMs={segment.endMs}
                              isActive={isActive}
                              onSeek={onSeek}
                              className="px-0 text-[11px] no-underline hover:underline"
                            >
                              {null}
                            </TimeAnchor>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="mb-0.5 flex items-center gap-2">
                              {segment.speaker && (
                                hasStructuredTurns ? (
                                  <span data-testid="speaker-badge" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                                    <span
                                      className="inline-block h-2 w-2 flex-none rounded-full"
                                      style={{ background: dotColor }}
                                    />
                                    {speakerLabel}
                                  </span>
                                ) : (
                                  <span className="text-[13px] font-semibold text-ink">
                                    {segment.speaker}
                                  </span>
                                )
                              )}
                            </div>
                            <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-foreground">{segment.text}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  /* ============ BY-SPEAKER VIEW ============ */
                  <div className="flex flex-col gap-4">
                    {/* talk-time distribution */}
                    <div className="rounded-lg border border-border bg-surface-sunken p-3">
                      <div className="mb-2.5 flex items-center gap-2">
                        <Users className="h-3.5 w-3.5 text-accent-2" />
                        <Eyebrow tone="muted">Talk time</Eyebrow>
                        <span className="ml-auto font-mono text-[11px] text-ink-muted">
                          {speakerGroups.groups.length} speaker{speakerGroups.groups.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface">
                        {speakerGroups.groups.map((g) => (
                          <div
                            key={g.key}
                            className="h-full first:rounded-l-full last:rounded-r-full"
                            style={{ width: `${Math.max(g.pct * 100, 1)}%`, background: g.color }}
                            title={`${g.name} · ${Math.round(g.pct * 100)}%`}
                          />
                        ))}
                      </div>
                    </div>

                    {/* per-speaker cards */}
                    {speakerGroups.groups.map((g) => (
                      <div key={g.key} className="rounded-lg border border-border bg-surface p-3 shadow-xs">
                        <div className="mb-3 flex items-center gap-3">
                          <PersonAvatar name={g.name} color={g.color} size={30} />
                          <div className="min-w-0 flex-1">
                            <span className="font-display text-[1.125rem] font-semibold tracking-[-0.01em] text-ink">
                              {g.name}
                            </span>
                            <div className="mt-0.5 font-mono text-[11px] text-ink-muted">
                              {formatTimestamp(g.durationMs / 1000)} · {g.segCount} segment{g.segCount === 1 ? '' : 's'} · {Math.round(g.pct * 100)}%
                            </div>
                          </div>
                        </div>
                        {/* per-speaker talk-time bar */}
                        <div className="mb-3.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.max(g.pct * 100, 1)}%`, background: g.color }}
                          />
                        </div>
                        <div className="flex flex-col gap-2">
                          {g.segments.map((seg, j) => (
                            <div key={j} className="flex gap-3 rounded-md px-2 py-1 transition-colors hover:bg-surface-hover">
                              <TimeAnchor
                                startMs={seg.startMs}
                                endMs={seg.endMs}
                                onSeek={onSeek}
                                className="w-11 flex-none px-0 text-[11px] no-underline hover:underline"
                              >
                                {null}
                              </TimeAnchor>
                              <div className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-foreground">{seg.text}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{transcript}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
