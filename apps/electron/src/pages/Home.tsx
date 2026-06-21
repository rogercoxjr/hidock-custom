import { useEffect, useMemo, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Mic,
  FileText,
  Users,
  ListTodo,
  Sparkles,
  ChevronRight
} from 'lucide-react'
import { Eyebrow } from '@/components/harbor/Eyebrow'
import { StatCard } from '@/components/harbor/StatCard'
import { useUnifiedRecordings } from '@/hooks/useUnifiedRecordings'
import { useContactsStore } from '@/store/domain/useContactsStore'
import { getRelativeTime } from '@/lib/utils'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Actionable } from '@/types/knowledge'

const RECENTS_LIMIT = 5
const TASKS_LIMIT = 4

/** Time-of-day greeting based on the current hour. */
function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/** Display title for a capture — prefers the knowledge title, falls back to filename. */
function recordingTitle(rec: UnifiedRecording): string {
  return rec.title?.trim() || rec.filename
}

export default function Home() {
  const navigate = useNavigate()

  // Recordings (captures) — drives the captures stat and the "Jump back in" recents.
  const { recordings, loading: recordingsLoading } = useUnifiedRecordings()

  // People — count of contacts for the stat row.
  const contactCount = useContactsStore((s) => s.total)
  const loadContacts = useContactsStore((s) => s.loadContacts)
  useEffect(() => {
    // Read-only load to populate the count (mirrors People page data source).
    loadContacts()
  }, [loadContacts])

  // Open actions — replicate the read-only loader the Actionables page uses
  // (window.electronAPI.actionables.getAll → Actionable[]). We only display a
  // few open (pending / in_progress) items here; full management lives on /actionables.
  const [actionables, setActionables] = useState<Actionable[]>([])
  const [actionablesLoading, setActionablesLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const data = await window.electronAPI?.actionables?.getAll?.()
        if (!cancelled && Array.isArray(data)) setActionables(data)
      } catch (err) {
        console.error('[Home] Failed to load actionables:', err)
      } finally {
        if (!cancelled) setActionablesLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const openActions = useMemo(
    () => actionables.filter((a) => a.status === 'pending' || a.status === 'in_progress'),
    [actionables]
  )

  // Most-recent captures for "Jump back in" (recordings are already sorted newest-first).
  const recents = useMemo(() => recordings.slice(0, RECENTS_LIMIT), [recordings])
  const tasks = useMemo(() => openActions.slice(0, TASKS_LIMIT), [openActions])

  // Stat tiles — captures, people, open actions, captured insights (transcribed captures).
  const transcribedCount = useMemo(
    () => recordings.filter((r) => r.transcriptionStatus === 'complete').length,
    [recordings]
  )

  // Open a recording in the Library: navigate with selectedId so Library's
  // location.state handler selects it (same mechanism Actionables uses for "View Source").
  const openRecording = useCallback(
    (rec: UnifiedRecording) => {
      navigate('/library', { state: { selectedId: rec.id } })
    },
    [navigate]
  )

  const stats = [
    { icon: <Mic className="h-full w-full" />, value: recordings.length, label: 'captures', href: '/library' },
    { icon: <Users className="h-full w-full" />, value: contactCount, label: 'people', href: '/people' },
    { icon: <ListTodo className="h-full w-full" />, value: openActions.length, label: 'open actions', href: '/actionables' },
    { icon: <Sparkles className="h-full w-full" />, value: transcribedCount, label: 'transcribed', href: '/library' }
  ]

  const showRecentsSkeleton = recordingsLoading && recordings.length === 0

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-[1080px] px-[var(--space-6)] pb-[var(--space-8)] pt-[var(--space-6)]">
        {/* Greeting */}
        <Eyebrow>Calm from the noise</Eyebrow>
        <h1 className="mb-[var(--space-5)] mt-1.5 font-display text-[2.25rem] font-semibold tracking-[-0.02em] text-ink">
          {getGreeting()}, Roger
        </h1>

        {/* Stat row */}
        <div className="mb-[var(--space-5)] grid grid-cols-2 gap-[var(--space-3)] sm:grid-cols-4">
          {stats.map((st) => (
            <button
              key={st.label}
              type="button"
              onClick={() => navigate(st.href)}
              className="text-left transition-colors"
              title={st.label}
            >
              <StatCard
                icon={st.icon}
                value={st.value}
                label={st.label}
                className="h-full transition-colors hover:border-border-strong"
              />
            </button>
          ))}
        </div>

        {/* Body: recents (left) + actions/flagged (right) */}
        <div className="grid grid-cols-1 items-start gap-[var(--space-4)] lg:grid-cols-[1.5fr_1fr]">
          {/* Jump back in */}
          <div>
            <div className="mb-[var(--space-3)] flex items-baseline gap-[var(--space-3)]">
              <h2 className="m-0 font-display text-[1.375rem] font-semibold tracking-[-0.01em] text-ink">
                Jump back in
              </h2>
              <button
                type="button"
                onClick={() => navigate('/library')}
                className="font-mono text-[11px] text-[var(--accent-soft-text)] transition-colors hover:text-ink"
              >
                all captures
              </button>
            </div>

            <div className="flex flex-col gap-[var(--space-2)]">
              {showRecentsSkeleton ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-lg border border-border bg-surface p-[13px] shadow-xs"
                  >
                    <div className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-surface-sunken" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="h-3.5 w-2/3 animate-pulse rounded bg-surface-sunken" />
                      <div className="h-2.5 w-1/3 animate-pulse rounded bg-surface-sunken" />
                    </div>
                  </div>
                ))
              ) : recents.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-surface-sunken/40 px-[var(--space-4)] py-[var(--space-5)] text-center">
                  <Mic className="mx-auto mb-2 h-7 w-7 text-ink-muted opacity-40" />
                  <p className="text-sm text-ink-muted">
                    No captures yet. Sync your device to get started.
                  </p>
                </div>
              ) : (
                recents.map((rec) => (
                  <button
                    key={rec.id}
                    type="button"
                    onClick={() => openRecording(rec)}
                    className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface p-[13px] text-left shadow-xs transition-colors hover:border-border-strong"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-accent-2">
                      <Mic className="h-[17px] w-[17px]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-semibold text-ink">
                        {recordingTitle(rec)}
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-ink-muted">
                        {getRelativeTime(rec.dateRecorded)}
                        {rec.transcriptionStatus === 'complete' && (
                          <span className="text-accent-2"> · transcribed</span>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" />
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Open actions */}
          <div className="flex flex-col gap-[var(--space-4)]">
            <div>
              <div className="mb-[var(--space-3)] flex items-baseline gap-[var(--space-3)]">
                <h2 className="m-0 font-display text-[1.375rem] font-semibold tracking-[-0.01em] text-ink">
                  Open actions
                </h2>
                <button
                  type="button"
                  onClick={() => navigate('/actionables')}
                  className="font-mono text-[11px] text-[var(--accent-soft-text)] transition-colors hover:text-ink"
                >
                  all actions
                </button>
              </div>

              <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
                {actionablesLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2.5 border-b border-border px-[14px] py-[11px] last:border-b-0"
                    >
                      <div className="mt-px h-4 w-4 shrink-0 animate-pulse rounded-sm bg-surface-sunken" />
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="h-3 w-3/4 animate-pulse rounded bg-surface-sunken" />
                        <div className="h-2.5 w-1/2 animate-pulse rounded bg-surface-sunken" />
                      </div>
                    </div>
                  ))
                ) : tasks.length === 0 ? (
                  <div className="px-[var(--space-4)] py-[var(--space-5)] text-center">
                    <ListTodo className="mx-auto mb-2 h-7 w-7 text-ink-muted opacity-40" />
                    <p className="text-sm text-ink-muted">
                      No open actions. Suggestions appear as you capture knowledge.
                    </p>
                  </div>
                ) : (
                  tasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => navigate('/actionables')}
                      className="flex w-full items-start gap-2.5 border-b border-border px-[14px] py-[11px] text-left transition-colors last:border-b-0 hover:bg-surface-hover"
                    >
                      <span className="mt-px h-4 w-4 shrink-0 rounded-sm border-[1.5px] border-border-strong" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] leading-snug text-ink">{task.title}</div>
                        <div className="mt-0.5 font-mono text-[10.5px] text-ink-muted">
                          {task.type.replace(/_/g, ' ')}
                          {task.suggestedRecipients.length > 0 && (
                            <span className="text-accent-2">
                              {' '}
                              · {task.suggestedRecipients.length} recipient
                              {task.suggestedRecipients.length > 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Recently flagged — deferred: there is no per-recording VoiceMark /
                bookmark data source in the renderer yet (no voicemark/marks data
                model exists). Surfacing recently transcribed captures instead so
                the right rail stays useful without fabricating flags. */}
            {transcribedCount > 0 && (
              <div>
                <h2 className="m-0 mb-[var(--space-3)] font-display text-[1.375rem] font-semibold tracking-[-0.01em] text-ink">
                  Recently transcribed
                </h2>
                <div className="flex flex-col gap-[var(--space-2)]">
                  {recordings
                    .filter((r) => r.transcriptionStatus === 'complete')
                    .slice(0, 3)
                    .map((rec) => (
                      <button
                        key={rec.id}
                        type="button"
                        onClick={() => openRecording(rec)}
                        className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-[13px] py-2.5 text-left shadow-xs transition-colors hover:border-border-strong"
                      >
                        <FileText className="h-[15px] w-[15px] shrink-0 text-accent-2" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] text-ink">{recordingTitle(rec)}</div>
                          <div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-muted">
                            {getRelativeTime(rec.dateRecorded)}
                          </div>
                        </div>
                      </button>
                    ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
