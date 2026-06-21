import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users,
  Search,
  RefreshCw,
  Mail,
  Building,
  Briefcase,
  Clock,
  MessageSquare,
  Tag,
  ChevronRight,
  Filter,
  UserPlus,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Eyebrow } from '@/components/harbor/Eyebrow'
import { PersonAvatar, avatarColor } from '@/components/harbor/PersonAvatar'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import type { Person, PersonType } from '@/types/knowledge'
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/toaster'
import { QuickAddContact } from '@/components/QuickAddContact'

export function People() {
  const navigate = useNavigate()

  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<PersonType | 'all'>('all')
  const [totalCount, setTotalCount] = useState(0)

  // Pagination state
  const PAGE_SIZE = 30
  const [currentPage, setCurrentPage] = useState(0)

  // Delete confirmation state (replaces confirm())
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [sortBy, setSortBy] = useState<'name' | 'lastSeen' | 'interactions'>('name')

  // Quick-add contact dialog
  const [quickAddOpen, setQuickAddOpen] = useState(false)

  // Debounce: skip firing on initial mount
  const isFirstMount = useRef(true)

  const loadPeople = useCallback(async (page = 0) => {
    setLoading(true)
    try {
      const result = await window.electronAPI.contacts.getAll({
        search: searchQuery,
        type: typeFilter,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE
      })
      if (result.success) {
        // Server returns already-mapped Person objects from contacts-handlers.ts
        const contacts: Person[] = result.data.contacts
        setPeople(contacts)
        setTotalCount(result.data.total)
      }
    } catch (error) {
      console.error('Failed to load people:', error)
      toast.error('Failed to load people', error instanceof Error ? error.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [searchQuery, typeFilter])

  // Initial load: fire immediately
  useEffect(() => {
    loadPeople(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Subsequent changes: debounce search/filter and reset to first page
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false
      return
    }
    setCurrentPage(0)
    const timer = setTimeout(() => {
      loadPeople(0)
    }, 300)
    return () => clearTimeout(timer)
  }, [loadPeople])

  // Pagination helpers
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page)
    loadPeople(page)
  }, [loadPeople])

  const handleDeleteClick = useCallback((personId: string, personName: string, event: React.MouseEvent) => {
    event.stopPropagation()
    setDeleteTarget({ id: personId, name: personName })
    setDeleteDialogOpen(true)
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return

    try {
      const result = await window.electronAPI.contacts.delete(deleteTarget.id)
      if (result.success) {
        toast.success('Contact deleted', `${deleteTarget.name} has been removed`)
        await loadPeople(currentPage)
      } else {
        toast.error('Failed to delete contact', (result as any).error?.message || 'Unknown error')
      }
    } catch (error) {
      console.error('Failed to delete contact:', error)
      toast.error('Failed to delete contact', error instanceof Error ? error.message : 'An unexpected error occurred')
    }
    setDeleteDialogOpen(false)
    setDeleteTarget(null)
  }, [deleteTarget, loadPeople, currentPage])

  const sortedPeople = useMemo(() => {
    const sorted = [...people]
    switch (sortBy) {
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name))
        break
      case 'lastSeen':
        sorted.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
        break
      case 'interactions':
        sorted.sort((a, b) => b.interactionCount - a.interactionCount)
        break
    }
    return sorted
  }, [people, sortBy])

  /** Safely format a date string, returning fallback for invalid dates */
  const formatDate = (dateStr: string | null | undefined): string => {
    if (!dateStr) return 'Unknown'
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return 'Unknown'
    return date.toLocaleDateString()
  }

  /** Return "interaction" (singular) or "interactions" (plural) */
  const interactionLabel = (count: number): string => {
    return count === 1 ? '1 interaction' : `${count} interactions`
  }

  // Map person type → Harbor Badge variant (teal reserved for voice/match cues).
  const getTypeVariant = (type: PersonType): 'primary' | 'accent' | 'success' | 'warning' | 'default' => {
    switch (type) {
      case 'team': return 'primary'
      case 'candidate': return 'accent'
      case 'customer': return 'success'
      case 'external': return 'warning'
      default: return 'default'
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-surface px-[var(--space-6)] py-[var(--space-4)]">
        <div className="flex items-end justify-between gap-4">
          <div>
            <Eyebrow>Organization</Eyebrow>
            <h1 className="font-display text-[1.75rem] font-semibold tracking-[-0.02em] text-ink">People</h1>
            <p className="mt-1 text-sm text-ink-muted">Everyone mentioned in your knowledge base</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => loadPeople(currentPage)}>
              <RefreshCw className={cn("h-4 w-4 mr-2", loading && "animate-spin")} />
              Refresh
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={() => setQuickAddOpen(true)}
            >
              <UserPlus className="h-4 w-4 mr-2" />
              Add Person
            </Button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mt-4">
          <div className="relative flex-1 max-w-sm w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
            <Input
              placeholder="Search people..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9"
            />
          </div>

          <div className="flex items-center gap-4 overflow-x-auto pb-2 sm:pb-0 w-full sm:w-auto">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-ink-muted flex-shrink-0" />
              <div className="flex gap-1">
                {(['all', 'team', 'candidate', 'customer', 'external'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t)}
                    className={cn(
                      "px-3 py-1 rounded-full text-xs font-medium border transition-colors whitespace-nowrap",
                      typeFilter === t
                        ? "bg-accent-strong-soft border-transparent text-accent-strong"
                        : "bg-surface border-border text-ink-muted hover:bg-surface-hover hover:text-ink"
                    )}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 border-l border-border pl-4">
              <span className="text-xs text-ink-muted whitespace-nowrap">Sort by</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'name' | 'lastSeen' | 'interactions')}
                className="text-xs rounded-md border border-border bg-surface px-2 py-1 text-ink ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                aria-label="Sort contacts"
              >
                <option value="name">Name</option>
                <option value="lastSeen">Last Seen</option>
                <option value="interactions">Interactions</option>
              </select>
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-auto p-[var(--space-6)]">
        <div className="max-w-5xl mx-auto">
          {/* Result count indicator */}
          {!loading && totalCount > 0 && (
            <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-muted mb-4">
              Showing {Math.min(currentPage * PAGE_SIZE + 1, totalCount)}–{Math.min((currentPage + 1) * PAGE_SIZE, totalCount)} of {totalCount} {totalCount === 1 ? 'person' : 'people'}
            </p>
          )}
          {loading && people.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <RefreshCw className="h-8 w-8 animate-spin text-ink-muted" />
            </div>
          ) : sortedPeople.length === 0 ? (
            <Card>
              <CardContent className="py-16 text-center">
                <Users className="h-12 w-12 mx-auto mb-4 text-ink-muted opacity-50" />
                <h3 className="font-display text-[1.375rem] font-semibold tracking-[-0.01em] text-ink mb-2">No People Found</h3>
                <p className="text-sm text-ink-muted">
                  {searchQuery || typeFilter !== 'all'
                    ? 'Try changing your search or filter settings.'
                    : 'No contacts yet. Contacts are automatically created when recordings are transcribed.'}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {sortedPeople.map((person) => (
                <Card
                  key={person.id}
                  className="group hover:border-border-strong transition-all cursor-pointer overflow-hidden shadow-xs hover:shadow-md"
                  onClick={() => navigate(`/person/${person.id}`)}
                >
                  <CardHeader className="pb-3 bg-surface-sunken/40 group-hover:bg-surface-sunken/70 transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <PersonAvatar name={person.name} color={avatarColor(person.name)} size={40} className="rounded-xl" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <CardTitle className="text-base truncate text-ink">{person.name}</CardTitle>
                            {person.isSelf && (
                              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-accent-strong bg-accent-strong-soft px-1.5 py-0.5 rounded-full">
                                you
                              </span>
                            )}
                          </div>
                          <Badge variant={getTypeVariant(person.type)} size="sm" className="mt-1 uppercase tracking-[0.06em]">
                            {person.type}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 hover:bg-danger-soft hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => handleDeleteClick(person.id, person.name, e)}
                          title="Delete contact"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                        <ChevronRight className="h-4 w-4 text-ink-muted group-hover:text-ink transition-colors" />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-4 space-y-3">
                    {person.email && (
                      <div className="flex items-center gap-2 text-xs text-ink-muted">
                        <Mail className="h-3.5 w-3.5" />
                        <span className="truncate">{person.email}</span>
                      </div>
                    )}
                    {person.company && (
                      <div className="flex items-center gap-2 text-xs text-ink-muted">
                        <Building className="h-3.5 w-3.5" />
                        <span className="truncate">{person.company}</span>
                      </div>
                    )}
                    {person.role && (
                      <div className="flex items-center gap-2 text-xs text-ink-muted">
                        <Briefcase className="h-3.5 w-3.5" />
                        <span className="truncate">{person.role}</span>
                      </div>
                    )}

                    <div className="pt-2 flex items-center justify-between border-t border-border">
                      <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-accent-2">
                        <MessageSquare className="h-3.5 w-3.5" />
                        <span>{interactionLabel(person.interactionCount)}</span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-ink-muted">
                        <Clock className="h-3 w-3" />
                        <span>{formatDate(person.lastSeenAt)}</span>
                      </div>
                    </div>

                    {(person.tags?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {(person.tags ?? []).slice(0, 3).map(tag => (
                          <Badge key={tag} variant="default" size="sm" className="font-normal">
                            <Tag className="h-2.5 w-2.5" />
                            {tag}
                          </Badge>
                        ))}
                        {(person.tags?.length ?? 0) > 3 && (
                          <span className="text-[10px] text-ink-muted self-center">+{(person.tags?.length ?? 0) - 3} more</span>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Pagination controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-6">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === 0 || loading}
                  onClick={() => handlePageChange(currentPage - 1)}
                  aria-label="Previous page"
                >
                  Previous
                </Button>
                <span className="text-sm text-ink-muted px-2">
                  Page {currentPage + 1} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= totalPages - 1 || loading}
                  onClick={() => handlePageChange(currentPage + 1)}
                  aria-label="Next page"
                >
                  Next
                </Button>
              </div>
            )}
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation AlertDialog (replaces confirm()) */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contact</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {deleteTarget?.name}? This will permanently remove this contact and all their meeting associations. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <QuickAddContact
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        onCreated={() => { setQuickAddOpen(false); loadPeople(currentPage) }}
      />
    </div>
  )
}
export default People
