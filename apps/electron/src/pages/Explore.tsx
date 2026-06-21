import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search,
  RefreshCw,
  FileText,
  Users,
  Folder,
  ChevronRight,
  TrendingUp,
  Zap,
  Clock,
  AlertCircle,
  ChevronLeft
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/utils'
import { toast } from '@/components/ui/toaster'
import { highlightMatch } from '@/utils/highlight'
import { Eyebrow } from '@/components/harbor/Eyebrow'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import { PersonAvatar } from '@/components/harbor/PersonAvatar'

// C-EXP-005: Loading skeleton for search results
function SearchResultSkeleton() {
  return (
    <div className="space-y-[var(--space-4)] animate-pulse">
      <div className="flex items-center justify-between border-b border-border pb-[var(--space-3)]">
        <div className="h-4 w-40 rounded bg-surface-sunken" />
        <div className="flex gap-1">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-7 w-16 rounded-md bg-surface-sunken" />
          ))}
        </div>
      </div>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded bg-surface-sunken" />
          <div className="h-4 w-24 rounded bg-surface-sunken" />
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-[13px] rounded-lg border border-border bg-surface p-[13px] shadow-xs">
            <div className="h-[34px] w-[34px] shrink-0 rounded-md bg-surface-sunken" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-3/4 rounded bg-surface-sunken" />
              <div className="h-3 w-1/2 rounded bg-surface-sunken" />
              <div className="h-3 w-28 rounded bg-surface-sunken" />
            </div>
            <div className="h-4 w-4 shrink-0 rounded-full bg-surface-sunken" />
          </div>
        ))}
      </div>
    </div>
  )
}

// C-EXP-003: Pagination constants
const SEARCH_PAGE_SIZE = 20

export function Explore() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'all' | 'knowledge' | 'people' | 'projects'>('all')

  // C-EXP-004: Ref for autofocus on the search input
  const searchInputRef = useRef<HTMLInputElement>(null)

  // C-EXP-002: Search performance timing
  const [searchDurationMs, setSearchDurationMs] = useState<number | null>(null)

  // C-EXP-003: Pagination state
  const [resultPage, setResultPage] = useState(1)

  // B-EXP-005: AbortController ref for cancelling pending requests on unmount
  const abortControllerRef = useRef<AbortController | null>(null)
  // B-EXP-005: Cancelled ref for unmount detection (AbortController may not be supported by IPC)
  const cancelledRef = useRef(false)

  // B-EXP-004: Wrap handleSearch in useCallback with proper deps
  const handleSearch = useCallback(async () => {
    if (!query.trim()) return

    // B-EXP-005: Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const controller = new AbortController()
    abortControllerRef.current = controller

    setLoading(true)
    setSearchError(null)
    setSearchDurationMs(null)
    // C-EXP-003: Reset pagination on new search
    setResultPage(1)
    // C-EXP-002: Start timing
    const searchStart = performance.now()
    try {
      const result = await window.electronAPI.rag.globalSearch(query, 10)

      // B-EXP-005: Check if component unmounted or request was superseded
      if (controller.signal.aborted || cancelledRef.current) return

      // C-EXP-002: Record search duration
      const elapsed = Math.round(performance.now() - searchStart)
      setSearchDurationMs(elapsed)

      // Unwrap Result<> wrapper
      if (result.success) {
        setResults(result.data)
      } else {
        // Handle error from Result wrapper
        const errorMsg = result.error.message || 'Search failed'
        setSearchError(errorMsg)
        toast.error('Search failed', errorMsg)
        setResults({ knowledge: [], people: [], projects: [] })
      }
    } catch (error) {
      // B-EXP-005: Don't update state if cancelled
      if (controller.signal.aborted || cancelledRef.current) return

      console.error('Search failed:', error)
      const message = error instanceof Error ? error.message : 'An unexpected error occurred'
      setSearchError(message)
      toast.error('Search failed', message)
      setResults({ knowledge: [], people: [], projects: [] })
    } finally {
      if (!controller.signal.aborted && !cancelledRef.current) {
        setLoading(false)
      }
    }
  }, [query])

  useEffect(() => {
    // C-EXP-M04: Clear stale results when query is empty
    if (!query.trim()) {
      setResults(null)
      setSearchDurationMs(null)
    }
    // Debounce search by 300ms
    const timer = setTimeout(() => {
      if (query.trim()) handleSearch()
    }, 300)
    return () => clearTimeout(timer)
  }, [query, handleSearch])

  // B-EXP-005: Cancel pending requests on unmount
  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])

  // C-EXP-004: Focus search input on mount
  useEffect(() => {
    // Small delay to ensure DOM is ready after route transition
    const timer = setTimeout(() => {
      searchInputRef.current?.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  // C-EXP-M03: Reset pagination when active tab changes
  useEffect(() => {
    setResultPage(1)
  }, [activeTab])

  // C-EXP-M01: Clear search error when query changes so stale errors don't persist
  useEffect(() => {
    if (searchError) {
      setSearchError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const totalResults = results
    ? results.knowledge.length + results.people.length + results.projects.length
    : 0

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Search hero */}
      <header className="border-b border-border px-[var(--space-6)] pb-[var(--space-7)] pt-[var(--space-6)] bg-[color-mix(in_oklch,var(--bg)_65%,var(--blue-50))]">
        <div className="mx-auto max-w-[760px]">
          <Eyebrow className="mb-1.5">Explore</Eyebrow>
          <h1 className="mb-1.5 font-display text-[2.25rem] font-semibold tracking-[-0.02em] text-ink">Explore knowledge</h1>
          <p className="mb-[var(--space-4)] text-[14.5px] text-ink-muted">
            Search across every capture, person, and project — one place to find what was said.
          </p>

          <form onSubmit={(e) => { e.preventDefault(); handleSearch(); }} className="relative flex items-center">
            <Search className="absolute left-[18px] h-[19px] w-[19px] text-ink-muted" />
            {/* C-EXP-004: Search input with ref for autofocus */}
            <input
              ref={searchInputRef}
              placeholder="Search anything — “Amazon Connect”, “Mario”, “API decisions”…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-xl border-[1.5px] border-border bg-surface py-4 pl-12 pr-12 text-[16px] text-ink shadow-md outline-none placeholder:text-ink-muted focus-visible:border-border-brand"
            />
            {loading && (
              <div className="absolute right-[18px]">
                <RefreshCw className="h-5 w-5 animate-spin text-ink-muted" />
              </div>
            )}
          </form>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-[880px] px-[var(--space-6)] pb-[var(--space-8)] pt-[var(--space-5)] space-y-[var(--space-5)]">

          {searchError && (
            <div className="flex items-center gap-3 rounded-lg border border-danger/40 bg-danger-soft p-4 text-sm">
              <AlertCircle className="h-5 w-5 flex-shrink-0 text-danger" />
              <div>
                <p className="font-semibold text-danger">Search failed</p>
                <p className="mt-0.5 text-ink-muted">{searchError}</p>
              </div>
            </div>
          )}

          {!results && !loading && !searchError && (
            <div className="grid grid-cols-1 gap-[var(--space-4)] md:grid-cols-[1.2fr_1fr]">
              {/* Recurring topics */}
              <div className="rounded-xl border border-border-brand bg-accent-strong-soft p-[var(--space-5)]">
                <div className="mb-[var(--space-3)] flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-accent-strong" />
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--accent-soft-text)]">
                    Recurring topics
                  </span>
                </div>
                <p className="mb-[var(--space-3)] text-[13px] leading-relaxed text-ink-muted">
                  Themes that keep coming up across your recent captures.
                </p>
                <div className="flex flex-wrap gap-[7px]">
                  {['Amazon Connect', 'API Design', 'Migration', 'Q1 Planning', 'Security'].map(t => (
                    <button
                      key={t}
                      onClick={() => setQuery(t)}
                      className="rounded-full border border-border bg-surface px-[13px] py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:border-border-strong"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quick actions */}
              <div className="rounded-xl border border-border bg-surface p-[var(--space-5)]">
                <div className="mb-[var(--space-3)] flex items-center gap-2">
                  <Zap className="h-4 w-4 text-accent-2" />
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                    Quick actions
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => { setQuery('summarize recent recordings'); }}
                    className="flex items-center justify-between gap-2.5 rounded-md border border-border bg-surface px-[13px] py-[11px] text-left text-[13px] text-ink transition-colors hover:bg-surface-hover"
                  >
                    <span>Summarize recent activity</span>
                    <ChevronRight className="h-[15px] w-[15px] text-ink-muted" />
                  </button>
                  <button
                    onClick={() => { setQuery('find unresolved tasks and action items'); }}
                    className="flex items-center justify-between gap-2.5 rounded-md border border-border bg-surface px-[13px] py-[11px] text-left text-[13px] text-ink transition-colors hover:bg-surface-hover"
                  >
                    <span>Find unresolved tasks</span>
                    <ChevronRight className="h-[15px] w-[15px] text-ink-muted" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* C-EXP-005: Loading skeleton during search */}
          {loading && !results && (
            <SearchResultSkeleton />
          )}

          {results && (
            <div className="space-y-[var(--space-4)]">
              <div className="flex items-center gap-[11px] border-b border-border pb-[var(--space-3)]">
                <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-muted">
                  {totalResults} results
                </span>
                {/* C-EXP-002: Search performance metrics */}
                {searchDurationMs !== null && (
                  <span className="rounded-full bg-surface-sunken px-2 py-0.5 font-mono text-[10px] text-ink-muted">
                    {searchDurationMs}ms
                  </span>
                )}
                <div className="flex-1" />
                <SegmentedToggle
                  size="sm"
                  aria-label="Filter results by type"
                  value={activeTab}
                  onChange={(t) => setActiveTab(t)}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'knowledge', label: 'Knowledge' },
                    { value: 'people', label: 'People' },
                    { value: 'projects', label: 'Projects' }
                  ]}
                />
              </div>

              <div className="space-y-[var(--space-5)]">
                {/* Knowledge Section */}
                {(activeTab === 'all' || activeTab === 'knowledge') && results.knowledge.length > 0 && (() => {
                  // C-EXP-003: Paginate knowledge results
                  const knowledgeStart = (resultPage - 1) * SEARCH_PAGE_SIZE
                  const paginatedKnowledge = results.knowledge.slice(knowledgeStart, knowledgeStart + SEARCH_PAGE_SIZE)
                  const knowledgeTotalPages = Math.ceil(results.knowledge.length / SEARCH_PAGE_SIZE)
                  return (
                  <div className="space-y-[var(--space-2)]">
                    <div className="flex items-center gap-2 text-ink-muted">
                      <FileText className="h-[15px] w-[15px]" />
                      <h3 className="font-mono text-[11px] uppercase tracking-[0.1em]">Knowledge ({results.knowledge.length})</h3>
                    </div>
                    <div className="flex flex-col gap-2">
                      {/* B-EXP-002: Navigate to /library with selectedId in navigation state */}
                      {paginatedKnowledge.map(k => (
                        <button
                          key={k.id}
                          onClick={() => navigate('/library', { state: { selectedId: k.id } })}
                          className="group flex w-full items-center gap-[13px] rounded-lg border border-border bg-surface p-[13px_15px] text-left shadow-xs transition-colors hover:border-border-strong"
                        >
                          <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md bg-surface-sunken text-accent-2">
                            <FileText className="h-[17px] w-[17px]" />
                          </div>
                          <div className="min-w-0 flex-1">
                            {/* B-EXP-001: Highlight matching terms (highlightMatch HTML-escapes input to prevent XSS) */}
                            <div
                              className="truncate text-[13.5px] font-semibold text-ink [&_mark]:rounded-sm [&_mark]:bg-warning-soft [&_mark]:px-0.5 [&_mark]:text-warning"
                              dangerouslySetInnerHTML={{ __html: highlightMatch(k.title || '', query) }}
                            />
                            <div
                              className="mt-0.5 truncate text-[12px] text-ink-muted [&_mark]:rounded-sm [&_mark]:bg-warning-soft [&_mark]:px-0.5 [&_mark]:text-warning"
                              dangerouslySetInnerHTML={{ __html: highlightMatch(k.summary || 'No summary available', query) }}
                            />
                            <div className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-ink-muted">
                              <Clock className="h-3 w-3" />
                              <span>{formatDateTime(k.capturedAt)}</span>
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" />
                        </button>
                      ))}
                    </div>
                    {/* C-EXP-003: Knowledge pagination controls */}
                    {knowledgeTotalPages > 1 && (
                      <div className="flex items-center justify-end gap-1 pt-1">
                        <Button variant="outline" size="sm" disabled={resultPage <= 1} onClick={() => setResultPage(p => Math.max(1, p - 1))}>
                          <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <span className="px-2 text-xs text-ink-muted">Page {resultPage} of {knowledgeTotalPages}</span>
                        <Button variant="outline" size="sm" disabled={resultPage >= knowledgeTotalPages} onClick={() => setResultPage(p => Math.min(knowledgeTotalPages, p + 1))}>
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                  )
                })()}

                {/* People Section */}
                {(activeTab === 'all' || activeTab === 'people') && results.people.length > 0 && (
                  <div className="space-y-[var(--space-2)]">
                    <div className="flex items-center gap-2 text-ink-muted">
                      <Users className="h-[15px] w-[15px]" />
                      <h3 className="font-mono text-[11px] uppercase tracking-[0.1em]">People ({results.people.length})</h3>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {results.people.map(p => (
                        <button
                          key={p.id}
                          onClick={() => navigate(`/person/${p.id}`)}
                          className="group flex items-center gap-[11px] rounded-lg border border-border bg-surface p-[11px_13px] text-left shadow-xs transition-colors hover:border-border-strong"
                        >
                          <PersonAvatar name={p.name} size={36} />
                          <div className="min-w-0 flex-1">
                            {/* B-EXP-001: Highlight matching terms in people names */}
                            <div
                              className="truncate text-[13px] font-semibold text-ink [&_mark]:rounded-sm [&_mark]:bg-warning-soft [&_mark]:px-0.5 [&_mark]:text-warning"
                              dangerouslySetInnerHTML={{ __html: highlightMatch(p.name || '', query) }}
                            />
                            <p className="text-[11px] text-ink-muted">{p.type}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Projects Section */}
                {(activeTab === 'all' || activeTab === 'projects') && results.projects.length > 0 && (
                  <div className="space-y-[var(--space-2)]">
                    <div className="flex items-center gap-2 text-ink-muted">
                      <Folder className="h-[15px] w-[15px]" />
                      <h3 className="font-mono text-[11px] uppercase tracking-[0.1em]">Projects ({results.projects.length})</h3>
                    </div>
                    <div className="flex flex-col gap-2">
                      {/* B-EXP-002: Navigate to /projects with selectedId in navigation state */}
                      {results.projects.map(pr => (
                        <button
                          key={pr.id}
                          onClick={() => navigate('/projects', { state: { selectedId: pr.id } })}
                          className="group flex w-full items-center gap-3 rounded-lg border border-border bg-surface p-[12px_15px] text-left shadow-xs transition-colors hover:border-border-strong"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-2-soft text-accent-2">
                            <Folder className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            {/* B-EXP-001: Highlight matching terms in project names */}
                            <div
                              className="truncate text-[13.5px] font-semibold text-ink [&_mark]:rounded-sm [&_mark]:bg-warning-soft [&_mark]:px-0.5 [&_mark]:text-warning"
                              dangerouslySetInnerHTML={{ __html: highlightMatch(pr.name || '', query) }}
                            />
                            <span className="mt-0.5 block font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-muted">{pr.status}</span>
                          </div>
                          <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* C-EXP-M05: Show empty state per-tab when the active tab has no results */}
                {totalResults === 0 && !loading && (
                  <div className="py-[var(--space-7)] text-center text-ink-muted">
                    <Search className="mx-auto mb-[var(--space-3)] h-[34px] w-[34px] opacity-40" />
                    <p className="text-[13.5px]">No matches for "{query}".</p>
                  </div>
                )}
                {totalResults > 0 && !loading && activeTab !== 'all' && (() => {
                  const tabHasResults =
                    (activeTab === 'knowledge' && results.knowledge.length > 0) ||
                    (activeTab === 'people' && results.people.length > 0) ||
                    (activeTab === 'projects' && results.projects.length > 0)
                  if (!tabHasResults) {
                    return (
                      <div className="py-[var(--space-6)] text-center text-ink-muted">
                        <Search className="mx-auto mb-[var(--space-3)] h-[30px] w-[30px] opacity-40" />
                        <p className="text-[13.5px]">No {activeTab} results for "{query}".</p>
                        <p className="mt-1 text-xs text-ink-muted">Try the "all" tab to see results in other categories.</p>
                      </div>
                    )
                  }
                  return null
                })()}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
export default Explore
