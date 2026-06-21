import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  Mail,
  Briefcase,
  Clock,
  MessageSquare,
  Tag,
  Calendar,
  Edit,
  RefreshCw,
  ExternalLink,
  Bot,
  Check,
  X,
  Trash2,
  User,
  AudioWaveform,
  MoreHorizontal,
  Eye,
  EyeOff
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
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
import { formatDateTime, formatDuration } from '@/lib/utils'
import type { Person, PersonType } from '@/types/knowledge'
import type { Meeting } from '@/types'
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/toaster'
import { Eyebrow } from '@/components/harbor/Eyebrow'
import { Badge } from '@/components/ui/badge'
import { PersonAvatar, avatarColor } from '@/components/harbor/PersonAvatar'
import { useConfigStore } from '@/store/domain/useConfigStore'
import type { VoiceprintSummary } from '../../electron/main/types/database'

export function PersonDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [person, setPerson] = useState<Person | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)
  const [isEditing, setIsEditing] = useState(false)
  const [editForm, setEditForm] = useState<{ name: string; email: string; role: string; company: string; notes: string }>({
    name: '', email: '', role: '', company: '', notes: ''
  })
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  // Voice Library (Phase 2) state
  const [activeTab, setActiveTab] = useState<'timeline' | 'knowledge' | 'voices'>('timeline')
  const [voiceprints, setVoiceprints] = useState<VoiceprintSummary[]>([])
  const [loadingVoiceprints, setLoadingVoiceprints] = useState(false)
  const [deleteRowVp, setDeleteRowVp] = useState<VoiceprintSummary | null>(null)
  const [markSelfDialogOpen, setMarkSelfDialogOpen] = useState(false)
  const [priorSelf, setPriorSelf] = useState<Person | null>(null)
  const [forgetVoiceDialogOpen, setForgetVoiceDialogOpen] = useState(false)
  const { config } = useConfigStore()

  // B-PPL-002: Wrapped in useCallback to satisfy dependency arrays
  const loadDetails = useCallback(async () => {
    if (!id) return
    setLoading(true)
    // B-PPL-002: Disable editing while loading
    setIsEditing(false)
    try {
      const result = await window.electronAPI.contacts.getById(id)
      if (result.success && result.data.contact) {
        const c = result.data.contact as any
        const personData: Person = {
          ...c,
          type: c.type || 'unknown',
          tags: c.tags ? (typeof c.tags === 'string' ? JSON.parse(c.tags) : c.tags) : [],
          firstSeenAt: c.first_seen_at || c.firstSeenAt,
          lastSeenAt: c.last_seen_at || c.lastSeenAt,
          interactionCount: c.meeting_count || c.interactionCount || 0,
          isSelf: c.is_self === 1 || c.isSelf === true,
          createdAt: c.created_at || c.createdAt || new Date().toISOString()
        }
        setPerson(personData)
        // B-PPL-002: Initialize form from loaded person data
        setEditForm({
          name: personData.name || '',
          email: personData.email || '',
          role: personData.role || '',
          company: personData.company || '',
          notes: personData.notes || ''
        })
        if (result.data.meetings) {
          setMeetings(result.data.meetings)
        }
      }
    } catch (error) {
      console.error('Failed to load person details:', error)
    } finally {
      setLoading(false)
    }
  }, [id])

  // B-PPL-003: Save including name and email fields
  // C-PPL: Added form validation
  const handleSaveEdit = async () => {
    if (!person || !id) return

    // Validate name (required, non-empty)
    const trimmedName = editForm.name.trim()
    if (!trimmedName) {
      toast.error('Validation Error', 'Name is required and cannot be empty.')
      return
    }
    if (trimmedName.length < 2) {
      toast.error('Validation Error', 'Name must be at least 2 characters.')
      return
    }

    // Validate email format if provided
    const trimmedEmail = editForm.email.trim()
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error('Validation Error', 'Please enter a valid email address.')
      return
    }

    try {
      const updatePayload: Record<string, string | undefined> = {
        id,
        notes: editForm.notes || undefined,
        role: editForm.role || undefined,
        company: editForm.company || undefined
      }

      // B-PPL-003: Include name and email in updates
      if (trimmedName !== person.name) {
        updatePayload.name = trimmedName
      }
      if (trimmedEmail !== (person.email || '')) {
        updatePayload.email = trimmedEmail || undefined
      }

      await window.electronAPI.contacts.update(updatePayload as any)
      toast.success('Contact updated', 'Contact details have been saved.')
      setIsEditing(false)
      await loadDetails()
    } catch (error) {
      console.error('Failed to update person:', error)
      toast.error('Failed to update contact', error instanceof Error ? error.message : 'Unknown error')
    }
  }

  const handleCancelEdit = () => {
    if (person) {
      setEditForm({
        name: person.name || '',
        email: person.email || '',
        role: person.role || '',
        company: person.company || '',
        notes: person.notes || ''
      })
    }
    setIsEditing(false)
  }

  // B-PPL-004: Delete contact
  const handleDeleteContact = async () => {
    if (!id || !person) return
    try {
      const result = await window.electronAPI.contacts.delete(id)
      if (result.success) {
        toast.success('Contact deleted', `${person.name} has been removed.`)
        navigate('/people')
      } else {
        toast.error('Failed to delete contact', (result as any).error?.message || 'Unknown error')
      }
    } catch (error) {
      console.error('Failed to delete contact:', error)
      toast.error('Failed to delete contact', error instanceof Error ? error.message : 'Unknown error')
    }
    setDeleteDialogOpen(false)
  }

  // Voice Library (Phase 2): "This is me" control
  const handleAskMarkSelf = async () => {
    if (!person || !id) return
    if (person.isSelf) {
      try {
        const result = await window.electronAPI.contacts.setSelf({ contactId: null })
        if (result.success) {
          toast.success('Unset self', 'This contact is no longer marked as you.')
          await loadDetails()
        } else {
          toast.error('Failed to unset self', (result as any).error?.message || 'Unknown error')
        }
      } catch (err) {
        console.error('Failed to unset self:', err)
        toast.error('Failed to unset self', err instanceof Error ? err.message : 'Unknown error')
      }
      return
    }

    try {
      const selfResult = await window.electronAPI.contacts.getSelf()
      const prior = selfResult.success ? (selfResult.data as Person | null) : null
      if (prior && prior.id !== id) {
        setPriorSelf(prior)
        setMarkSelfDialogOpen(true)
      } else {
        await handleConfirmMarkSelf()
      }
    } catch (err) {
      console.error('Failed to fetch self contact:', err)
      await handleConfirmMarkSelf()
    }
  }

  const handleConfirmMarkSelf = async () => {
    if (!id) return
    try {
      const result = await window.electronAPI.contacts.setSelf({ contactId: id })
      if (result.success) {
        toast.success('Marked as you', 'This contact is now marked as you.')
        setMarkSelfDialogOpen(false)
        setPriorSelf(null)
        await loadDetails()
      } else {
        toast.error('Failed to mark as you', (result as any).error?.message || 'Unknown error')
      }
    } catch (err) {
      console.error('Failed to mark as self:', err)
      toast.error('Failed to mark as you', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  // Voice Library (Phase 2): voiceprint actions
  const handleToggleVoiceprint = async (vp: VoiceprintSummary, enable: boolean) => {
    const api = enable ? window.electronAPI.voiceprints.enable : window.electronAPI.voiceprints.disable
    try {
      const result = await api(vp.id)
      if (result.success) {
        toast.success(enable ? 'Voiceprint enabled' : 'Voiceprint disabled')
        await loadVoiceprints()
      } else {
        toast.error('Failed to update voiceprint', (result as any).error?.message || 'Unknown error')
      }
    } catch (err) {
      console.error('Failed to toggle voiceprint:', err)
      toast.error('Failed to update voiceprint', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const handleDeleteVoiceprint = async (vp: VoiceprintSummary) => {
    try {
      const result = await window.electronAPI.voiceprints.delete(vp.id)
      if (result.success) {
        toast.success('Voiceprint deleted')
        await loadVoiceprints()
      } else {
        toast.error('Failed to delete voiceprint', (result as any).error?.message || 'Unknown error')
      }
    } catch (err) {
      console.error('Failed to delete voiceprint:', err)
      toast.error('Failed to delete voiceprint', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const handleForgetVoice = async () => {
    if (!id) return
    try {
      const result = await window.electronAPI.voiceprints.clearAllForContact(id)
      if (result.success && result.data) {
        const deleted = result.data.deleted
        if (deleted > 0) {
          toast.success('Voice forgotten', `Removed ${deleted} voiceprint${deleted === 1 ? '' : 's'}.`)
        } else {
          toast.info('No voiceprints', 'There were no voiceprints to remove.')
        }
        setForgetVoiceDialogOpen(false)
        await loadVoiceprints()
      } else {
        toast.error('Failed to clear voiceprints', (result as any).error?.message || 'Unknown error')
      }
    } catch (err) {
      console.error('Failed to clear voiceprints:', err)
      toast.error('Failed to clear voiceprints', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const loadVoiceprints = useCallback(async () => {
    if (!id) return
    setLoadingVoiceprints(true)
    try {
      const result = await window.electronAPI.voiceprints.listForContact(id)
      if (result.success && result.data) {
        setVoiceprints(result.data)
      } else {
        console.error('Failed to load voiceprints:', (result as any).error)
      }
    } catch (err) {
      console.error('Failed to load voiceprints:', err)
    } finally {
      setLoadingVoiceprints(false)
    }
  }, [id])

  useEffect(() => {
    loadDetails()
  }, [loadDetails])

  useEffect(() => {
    if (activeTab === 'voices' && id) {
      loadVoiceprints()
    }
  }, [activeTab, id, loadVoiceprints])

  const rememberedRecordingCount = useMemo(() => {
    return new Set(voiceprints.filter((vp) => !vp.disabledAt).map((vp) => vp.sourceRecordingId).filter(Boolean)).size
  }, [voiceprints])

  const getTypeVariant = (type: PersonType): 'primary' | 'accent' | 'success' | 'warning' | 'default' => {
    switch (type) {
      case 'team': return 'primary'
      case 'candidate': return 'accent'
      case 'customer': return 'success'
      case 'external': return 'warning'
      default: return 'default'
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-ink-muted" />
      </div>
    )
  }

  if (!person) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-4">
        <p className="text-ink-muted">Person not found</p>
        <Button onClick={() => navigate('/people')}>Back to People</Button>
      </div>
    )
  }

  const personColor = avatarColor(person.name)

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Sticky Header */}
      <header className="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
        <div className="flex items-center justify-between px-[var(--space-6)] py-4">
          <div className="flex min-w-0 items-center gap-[var(--space-4)]">
            <Button variant="ghost" size="icon" onClick={() => navigate('/people')}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <PersonAvatar name={person.name} color={personColor} size={52} className="rounded-2xl text-[1.25rem]" />
            <div className="min-w-0">
              {isEditing ? (
                <input
                  type="text"
                  value={editForm.name}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                  className="w-full rounded-md border border-border-brand bg-surface px-2 py-1 font-display text-[1.375rem] font-semibold leading-tight tracking-[-0.02em] text-ink outline-none"
                  placeholder="Name..."
                />
              ) : (
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="font-display text-[1.375rem] font-semibold leading-tight tracking-[-0.02em] text-ink">
                    {person.name}
                  </h1>
                  {person.isSelf && (
                    <span className="rounded-full bg-accent-2-soft px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-accent-2">
                      this is you
                    </span>
                  )}
                </div>
              )}
              <div className="mt-1 flex items-center gap-2">
                <Badge variant={getTypeVariant(person.type)} className="uppercase tracking-[0.08em]">
                  {person.type}
                </Badge>
                {person.company && (
                  <span className="truncate text-xs text-ink-muted">· {person.company}</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => loadDetails()} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4 mr-2", loading && "animate-spin")} />
              Refresh
            </Button>
            <Button
              size="sm"
              variant={person.isSelf ? 'default' : 'outline'}
              onClick={handleAskMarkSelf}
              disabled={loading}
              className="gap-2"
            >
              <User className="h-4 w-4" />
              {person.isSelf ? 'You' : 'Mark as me'}
            </Button>
            {isEditing ? (
              <>
                <Button size="sm" variant="default" onClick={handleSaveEdit} disabled={loading}>
                  <Check className="h-4 w-4 mr-2" />
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={handleCancelEdit}>
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              </>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-9 w-9"
                    title="Contact options"
                    disabled={loading}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[230px]">
                  {/* B-PPL-002: Disable edit button while loading */}
                  <DropdownMenuItem onSelect={() => setIsEditing(true)} disabled={loading}>
                    <Edit className="mr-2 h-4 w-4 text-accent-2" />
                    Edit contact
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => setDeleteDialogOpen(true)}
                    disabled={loading}
                    className="text-danger focus:text-danger"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete contact
                  </DropdownMenuItem>
                  <p className="px-2 pb-1 pt-2 text-[11px] leading-snug text-ink-muted">
                    Deleting also removes this contact's voiceprints.
                  </p>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl p-[var(--space-6)] space-y-[var(--space-5)]">
          <div className="grid grid-cols-1 gap-[var(--space-5)] md:grid-cols-3">
            {/* Left Column: Info Card */}
            <div className="space-y-[var(--space-5)]">
              <Card>
                <CardHeader>
                  <Eyebrow tone="muted">Information</Eyebrow>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* B-PPL-003: Email is now editable */}
                  {(person.email || isEditing) && (
                    <div className="flex items-start gap-3">
                      <Mail className="mt-0.5 h-4 w-4 text-accent-2" />
                      <div className="min-w-0 flex-1">
                        <p className="mb-0.5 text-xs text-ink-muted">Email</p>
                        {isEditing ? (
                          <input
                            type="email"
                            value={editForm.email}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, email: e.target.value }))}
                            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm font-medium text-ink outline-none focus:border-border-brand"
                            placeholder="Enter email..."
                          />
                        ) : (
                          <p className="truncate text-sm font-medium text-ink">{person.email}</p>
                        )}
                      </div>
                    </div>
                  )}
                  {(person.role || isEditing) && (
                    <div className="flex items-start gap-3">
                      <Briefcase className="mt-0.5 h-4 w-4 text-accent-2" />
                      <div className="min-w-0 flex-1">
                        <p className="mb-0.5 text-xs text-ink-muted">Role</p>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editForm.role}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, role: e.target.value }))}
                            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm font-medium text-ink outline-none focus:border-border-brand"
                            placeholder="Enter role..."
                          />
                        ) : (
                          <p className="truncate text-sm font-medium text-ink">{person.role}</p>
                        )}
                      </div>
                    </div>
                  )}
                  {(person.company || isEditing) && (
                    <div className="flex items-start gap-3">
                      <Briefcase className="mt-0.5 h-4 w-4 text-accent-2" />
                      <div className="min-w-0 flex-1">
                        <p className="mb-0.5 text-xs text-ink-muted">Company</p>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editForm.company}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, company: e.target.value }))}
                            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm font-medium text-ink outline-none focus:border-border-brand"
                            placeholder="Enter company..."
                          />
                        ) : (
                          <p className="truncate text-sm font-medium text-ink">{person.company}</p>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="flex items-start gap-3">
                    <Clock className="mt-0.5 h-4 w-4 text-accent-2" />
                    <div className="min-w-0 flex-1">
                      <p className="mb-0.5 text-xs text-ink-muted">Last Interaction</p>
                      <p className="text-sm font-medium text-ink">{formatDateTime(person.lastSeenAt)}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 border-t border-border pt-4">
                    <MessageSquare className="mt-0.5 h-4 w-4 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="mb-0.5 text-xs text-ink-muted">Total Interactions</p>
                      <p className="text-sm font-semibold text-ink">{person.interactionCount}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {person.tags.length > 0 && (
                <Card>
                  <CardHeader>
                    <Eyebrow tone="muted">Tags</Eyebrow>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {person.tags.map(tag => (
                        <span key={tag} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs text-ink">
                          <Tag className="h-3 w-3 text-accent-2" />
                          {tag}
                        </span>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Right Column: Timeline & Knowledge */}
            <div className="space-y-[var(--space-5)] md:col-span-2">
              <div className="w-full">
                <div className="flex items-center gap-[var(--space-4)] border-b border-border">
                  {([
                    { id: 'timeline', label: 'Timeline', icon: Calendar },
                    { id: 'knowledge', label: 'Knowledge Map', icon: Bot },
                    { id: 'voices', label: 'Voices', icon: AudioWaveform }
                  ] as const).map((tab) => {
                    const active = activeTab === tab.id
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={cn(
                          'flex items-center gap-2 border-b-2 pb-2.5 text-[13.5px] font-semibold transition-colors',
                          active
                            ? 'border-primary text-ink'
                            : 'border-transparent text-ink-muted hover:text-ink'
                        )}
                      >
                        <tab.icon className="h-4 w-4" />
                        {tab.label}
                      </button>
                    )
                  })}
                </div>

                {activeTab === 'timeline' && (
                  <div className="mt-[var(--space-5)] space-y-[var(--space-2)] animate-in fade-in slide-in-from-top-2 duration-300">
                    {meetings.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border-strong py-12 text-center">
                        <Calendar className="mx-auto mb-3 h-10 w-10 text-ink-muted opacity-40" />
                        <p className="text-sm text-ink-muted">No meetings recorded with this person</p>
                      </div>
                    ) : (
                      meetings.map((meeting) => (
                        <Card key={meeting.id} className="group cursor-pointer overflow-hidden shadow-xs transition-colors hover:border-border-brand" onClick={() => navigate(`/meeting/${meeting.id}`)}>
                          <div className="flex h-full items-stretch">
                            <div className="w-1 bg-border transition-colors group-hover:bg-primary" />
                            <div className="flex-1 p-[var(--space-4)]">
                              <div className="flex items-start justify-between">
                                <div className="min-w-0">
                                  <h3 className="text-[13.5px] font-semibold text-ink transition-colors group-hover:text-primary">{meeting.subject}</h3>
                                  <p className="mt-1 font-mono text-[10.5px] text-ink-muted">
                                    {formatDateTime(meeting.start_time)}
                                  </p>
                                </div>
                                <ExternalLink className="h-3.5 w-3.5 text-ink-muted opacity-0 transition-opacity group-hover:opacity-100" />
                              </div>
                            </div>
                          </div>
                        </Card>
                      ))
                    )}
                  </div>
                )}

                {activeTab === 'knowledge' && (
                  <div className="mt-[var(--space-5)] animate-in fade-in slide-in-from-top-2 duration-300">
                    <Card>
                      <CardContent className="py-12 text-center">
                        <Bot className="mx-auto mb-4 h-12 w-12 text-accent-2 opacity-30" />
                        <h3 className="mb-2 font-display text-[1.125rem] font-semibold text-ink">Knowledge Map</h3>
                        <p className="mx-auto max-w-sm text-sm text-ink-muted">
                          AI visualization of topics and discussions related to {person.name} is coming soon.
                        </p>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {activeTab === 'voices' && (
                  <div className="mt-[var(--space-5)] flex flex-col gap-[var(--space-3)] animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="flex items-center gap-2.5">
                      <AudioWaveform className="h-4 w-4 text-accent-2" />
                      <h2 className="font-display text-[1.125rem] font-semibold text-ink">Enrolled voices</h2>
                      <span className="ml-auto flex items-center gap-2">
                        <span className="font-mono text-[11px] text-ink-muted">
                          {rememberedRecordingCount} recording{rememberedRecordingCount === 1 ? '' : 's'}
                        </span>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setForgetVoiceDialogOpen(true)}
                          disabled={loadingVoiceprints || voiceprints.length === 0}
                        >
                          Forget this voice
                        </Button>
                      </span>
                    </div>
                    <p className="mb-1 text-[13px] leading-[1.55] text-ink-muted">
                      Voice samples captured when this person was assigned in a recording. They&apos;re used to
                      auto-match the same voice in future captures. Disable to pause matching; delete to remove
                      the biometric data entirely.
                    </p>

                    {loadingVoiceprints ? (
                      <div className="flex items-center justify-center gap-2 py-12 text-ink-muted">
                        <RefreshCw className="h-5 w-5 animate-spin" />
                        <span className="text-sm">Loading voiceprints...</span>
                      </div>
                    ) : voiceprints.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-[var(--space-4)] py-[var(--space-6)] text-center">
                        <AudioWaveform className="h-[26px] w-[26px] text-ink-muted" />
                        <div className="text-[13.5px] font-semibold text-ink">No voiceprint yet</div>
                        <p className="max-w-sm text-[12.5px] text-ink-muted">
                          Assign this person to a speaker in any recording and their voice will be enrolled
                          here — if voice capture is on.
                        </p>
                        {config?.privacy?.enableVoiceprintCapture === false && (
                          <p className="mt-1 text-xs text-ink-muted">
                            Voiceprint capture is disabled in Settings → Privacy.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-[var(--space-2)]">
                        {voiceprints.map((vp) => (
                          <div
                            key={vp.id}
                            className={cn(
                              'flex flex-col gap-3 rounded-lg border border-border bg-surface p-[var(--space-4)] sm:flex-row sm:items-center',
                              vp.disabledAt ? 'opacity-60' : ''
                            )}
                          >
                            <AudioWaveform className="hidden h-[17px] w-[17px] shrink-0 text-accent-2 sm:block" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[13.5px] font-semibold text-ink">
                                {vp.sourceRecordingTitle ? (
                                  vp.sourceRecordingId ? (
                                    <button
                                      className="text-left hover:text-primary hover:underline"
                                      onClick={() => navigate(`/recording/${vp.sourceRecordingId}`)}
                                    >
                                      {vp.sourceRecordingTitle}
                                    </button>
                                  ) : (
                                    vp.sourceRecordingTitle
                                  )
                                ) : (
                                  <span className="text-ink-muted">from a deleted recording</span>
                                )}
                                {vp.sourceLabel && (
                                  <span className="ml-2 text-xs font-normal text-ink-muted">
                                    label {vp.sourceLabel}
                                  </span>
                                )}
                              </p>
                              <p className="mt-0.5 font-mono text-[10.5px] text-ink-muted">
                                {formatDateTime(vp.createdAt)}
                                {' · '}{vp.modelId}
                                {vp.cleanSpeechMs != null && (
                                  <> · {formatDuration(vp.cleanSpeechMs / 1000)} clean speech</>
                                )}
                                {vp.createdFrom && (
                                  <span className="ml-2 rounded bg-surface-sunken px-1.5 py-0.5 uppercase">
                                    {vp.createdFrom}
                                  </span>
                                )}
                              </p>
                            </div>
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.04em]',
                                vp.disabledAt
                                  ? 'bg-surface-sunken text-ink-muted'
                                  : 'bg-accent-2-soft text-accent-2'
                              )}
                            >
                              {vp.disabledAt ? 'disabled' : 'active'}
                            </span>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5"
                                onClick={() => handleToggleVoiceprint(vp, !!vp.disabledAt)}
                              >
                                {vp.disabledAt ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                                {vp.disabledAt ? 'Enable' : 'Disable'}
                              </Button>
                              <Button
                                variant="outline"
                                size="icon"
                                className="h-8 w-8 text-danger hover:text-danger"
                                title="Delete voiceprint"
                                onClick={() => setDeleteRowVp(vp)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {(person.notes || isEditing) && (
                <Card>
                  <CardHeader>
                    <Eyebrow tone="muted">Notes</Eyebrow>
                  </CardHeader>
                  <CardContent>
                    {isEditing ? (
                      <textarea
                        value={editForm.notes}
                        onChange={(e) => setEditForm((prev) => ({ ...prev, notes: e.target.value }))}
                        className="min-h-[80px] w-full rounded-md border border-border bg-surface px-2 py-1 text-sm leading-relaxed text-ink outline-none focus:border-border-brand"
                        placeholder="Add notes..."
                      />
                    ) : (
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{person.notes}</p>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* B-PPL-004: Delete Confirmation AlertDialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contact</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {person.name}? This will permanently remove this contact, their voiceprints, and all their meeting associations. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteContact}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Voice Library: per-row voiceprint delete confirmation */}
      <AlertDialog open={deleteRowVp != null} onOpenChange={(open) => !open && setDeleteRowVp(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Voiceprint</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this voiceprint
              {deleteRowVp?.sourceRecordingTitle ? ` from "${deleteRowVp.sourceRecordingTitle}"` : ''}?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteRowVp(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteRowVp) {
                  void handleDeleteVoiceprint(deleteRowVp)
                }
                setDeleteRowVp(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Voice Library: move "this is me" confirmation */}
      <AlertDialog open={markSelfDialogOpen} onOpenChange={setMarkSelfDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as you?</AlertDialogTitle>
            <AlertDialogDescription>
              {priorSelf ? (
                <>
                  <strong>{priorSelf.name}</strong> is currently marked as you — move it to{' '}
                  <strong>{person.name}</strong>?
                </>
              ) : (
                `Mark ${person.name} as you? Only one contact can be marked as you at a time.`
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPriorSelf(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmMarkSelf}>Mark as me</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Voice Library: forget-this-voice confirmation */}
      <AlertDialog open={forgetVoiceDialogOpen} onOpenChange={setForgetVoiceDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget this voice?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes every voiceprint for {person.name}. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleForgetVoice}
            >
              Forget voice
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
export default PersonDetail
