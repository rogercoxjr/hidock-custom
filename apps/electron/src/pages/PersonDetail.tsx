import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
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
  Volume2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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

  const getTypeColor = (type: PersonType) => {
    switch (type) {
      case 'team': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
      case 'candidate': return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
      case 'customer': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
      case 'external': return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
      default: return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400'
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!person) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-4">
        <p className="text-muted-foreground">Person not found</p>
        <Button onClick={() => navigate('/people')}>Back to People</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Sticky Header */}
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10">
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate('/people')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-3">
              <div className={cn(
                "w-12 h-12 rounded-2xl flex items-center justify-center text-xl font-bold shadow-sm border",
                getTypeColor(person.type)
              )}>
                {person.name.charAt(0)}
              </div>
              <div>
                {isEditing ? (
                  <input
                    type="text"
                    value={editForm.name}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="text-xl font-bold leading-tight border rounded px-2 py-1 bg-background w-full"
                    placeholder="Name..."
                  />
                ) : (
                  <h1 className="text-xl font-bold leading-tight">{person.name}</h1>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <span className={cn(
                    "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider",
                    getTypeColor(person.type)
                  )}>
                    {person.type}
                  </span>
                  {person.company && (
                    <span className="text-xs text-muted-foreground">- {person.company}</span>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
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
              <>
                {/* B-PPL-002: Disable edit button while loading */}
                <Button size="sm" variant="default" onClick={() => setIsEditing(true)} disabled={loading}>
                  <Edit className="h-4 w-4 mr-2" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteDialogOpen(true)}
                  disabled={loading}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Left Column: Info Card */}
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* B-PPL-003: Email is now editable */}
                  {(person.email || isEditing) && (
                    <div className="flex items-start gap-3">
                      <Mail className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted-foreground mb-0.5">Email</p>
                        {isEditing ? (
                          <input
                            type="email"
                            value={editForm.email}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, email: e.target.value }))}
                            className="text-sm font-medium w-full border rounded px-2 py-1 bg-background"
                            placeholder="Enter email..."
                          />
                        ) : (
                          <p className="text-sm font-medium truncate">{person.email}</p>
                        )}
                      </div>
                    </div>
                  )}
                  {(person.role || isEditing) && (
                    <div className="flex items-start gap-3">
                      <Briefcase className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted-foreground mb-0.5">Role</p>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editForm.role}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, role: e.target.value }))}
                            className="text-sm font-medium w-full border rounded px-2 py-1 bg-background"
                            placeholder="Enter role..."
                          />
                        ) : (
                          <p className="text-sm font-medium truncate">{person.role}</p>
                        )}
                      </div>
                    </div>
                  )}
                  {(person.company || isEditing) && (
                    <div className="flex items-start gap-3">
                      <Briefcase className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted-foreground mb-0.5">Company</p>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editForm.company}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, company: e.target.value }))}
                            className="text-sm font-medium w-full border rounded px-2 py-1 bg-background"
                            placeholder="Enter company..."
                          />
                        ) : (
                          <p className="text-sm font-medium truncate">{person.company}</p>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="flex items-start gap-3">
                    <Clock className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground mb-0.5">Last Interaction</p>
                      <p className="text-sm font-medium">{formatDateTime(person.lastSeenAt)}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 border-t pt-4">
                    <MessageSquare className="h-4 w-4 text-primary mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground mb-0.5">Total Interactions</p>
                      <p className="text-sm font-bold">{person.interactionCount}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {person.tags.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Tags</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {person.tags.map(tag => (
                        <div key={tag} className="flex items-center gap-1.5 text-xs bg-secondary px-3 py-1 rounded-full border border-border/50">
                          <Tag className="h-3 w-3" />
                          {tag}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Right Column: Timeline & Knowledge */}
            <div className="md:col-span-2 space-y-6">
              <div className="w-full">
                <div className="grid w-full grid-cols-3 bg-muted/50 p-1 rounded-lg">
                  <button
                    onClick={() => setActiveTab('timeline')}
                    className={cn(
                      "flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-all",
                      activeTab === 'timeline' ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Calendar className="h-4 w-4" />
                    Timeline
                  </button>
                  <button
                    onClick={() => setActiveTab('knowledge')}
                    className={cn(
                      "flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-all",
                      activeTab === 'knowledge' ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Bot className="h-4 w-4" />
                    Knowledge Map
                  </button>
                  <button
                    onClick={() => setActiveTab('voices')}
                    className={cn(
                      "flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-all",
                      activeTab === 'voices' ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Volume2 className="h-4 w-4" />
                    Voices
                  </button>
                </div>

                {activeTab === 'timeline' && (
                  <div className="mt-6 space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                    {meetings.length === 0 ? (
                      <div className="text-center py-12 border rounded-xl bg-muted/5">
                        <Calendar className="h-10 w-10 mx-auto text-muted-foreground opacity-20 mb-3" />
                        <p className="text-sm text-muted-foreground">No meetings recorded with this person</p>
                      </div>
                    ) : (
                      meetings.map((meeting) => (
                        <Card key={meeting.id} className="group hover:border-primary/30 transition-all cursor-pointer overflow-hidden shadow-sm" onClick={() => navigate(`/meeting/${meeting.id}`)}>
                          <div className="flex items-stretch h-full">
                            <div className="w-1 bg-muted group-hover:bg-primary transition-colors" />
                            <div className="flex-1 p-4">
                              <div className="flex items-start justify-between">
                                <div>
                                  <h3 className="text-sm font-semibold group-hover:text-primary transition-colors">{meeting.subject}</h3>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    {formatDateTime(meeting.start_time)}
                                  </p>
                                </div>
                                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                              </div>
                            </div>
                          </div>
                        </Card>
                      ))
                    )}
                  </div>
                )}

                {activeTab === 'knowledge' && (
                  <div className="mt-6 animate-in fade-in slide-in-from-top-2 duration-300">
                    <Card>
                      <CardContent className="py-12 text-center">
                        <Bot className="h-12 w-12 mx-auto text-primary opacity-20 mb-4" />
                        <h3 className="text-lg font-medium mb-2">Knowledge Map</h3>
                        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                          AI visualization of topics and discussions related to {person.name} is coming soon.
                        </p>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {activeTab === 'voices' && (
                  <div className="mt-6 animate-in fade-in slide-in-from-top-2 duration-300">
                    <Card>
                      <CardHeader>
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <CardTitle>Voiceprints</CardTitle>
                            <CardDescription>
                              Remembered from {rememberedRecordingCount} recording{rememberedRecordingCount === 1 ? '' : 's'}
                            </CardDescription>
                          </div>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setForgetVoiceDialogOpen(true)}
                            disabled={loadingVoiceprints || voiceprints.length === 0}
                          >
                            Forget this voice
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {loadingVoiceprints ? (
                          <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
                            <RefreshCw className="h-5 w-5 animate-spin" />
                            <span className="text-sm">Loading voiceprints...</span>
                          </div>
                        ) : voiceprints.length === 0 ? (
                          <div className="text-center py-12 border rounded-xl bg-muted/5">
                            <Volume2 className="h-10 w-10 mx-auto text-muted-foreground opacity-20 mb-3" />
                            <p className="text-sm text-muted-foreground">
                              No voiceprints yet. Assign this person to a speaker in a transcript to remember their voice.
                            </p>
                            {config?.privacy?.enableVoiceprintCapture === false && (
                              <p className="text-xs text-muted-foreground mt-2">
                                Voiceprint capture is disabled in Settings → Privacy.
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {voiceprints.map((vp) => (
                              <div
                                key={vp.id}
                                className={cn(
                                  "flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 border rounded-lg",
                                  vp.disabledAt ? "opacity-60 bg-muted/30" : ""
                                )}
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium truncate">
                                    {vp.sourceRecordingTitle ? (
                                      vp.sourceRecordingId ? (
                                        <button
                                          className="hover:text-primary hover:underline text-left"
                                          onClick={() => navigate(`/recording/${vp.sourceRecordingId}`)}
                                        >
                                          {vp.sourceRecordingTitle}
                                        </button>
                                      ) : (
                                        vp.sourceRecordingTitle
                                      )
                                    ) : (
                                      <span className="text-muted-foreground">from a deleted recording</span>
                                    )}
                                    {vp.sourceLabel && (
                                      <span className="text-xs text-muted-foreground ml-2">
                                        label {vp.sourceLabel}
                                      </span>
                                    )}
                                  </p>
                                  <p className="text-xs text-muted-foreground mt-0.5">
                                    Captured {formatDateTime(vp.createdAt)}
                                    {vp.cleanSpeechMs != null && (
                                      <> · {formatDuration(vp.cleanSpeechMs / 1000)} clean speech</>
                                    )}
                                    {vp.createdFrom && (
                                      <span className="ml-2 text-[10px] uppercase bg-secondary px-1.5 py-0.5 rounded">
                                        {vp.createdFrom}
                                      </span>
                                    )}
                                    {vp.disabledAt && (
                                      <span className="ml-2 text-[10px] text-amber-600 font-medium">Disabled</span>
                                    )}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleToggleVoiceprint(vp, !!vp.disabledAt)}
                                  >
                                    {vp.disabledAt ? 'Enable' : 'Disable'}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => setDeleteRowVp(vp)}
                                  >
                                    Delete
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )}
              </div>

              {(person.notes || isEditing) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Notes</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {isEditing ? (
                      <textarea
                        value={editForm.notes}
                        onChange={(e) => setEditForm((prev) => ({ ...prev, notes: e.target.value }))}
                        className="text-sm w-full border rounded px-2 py-1 bg-background min-h-[80px] leading-relaxed"
                        placeholder="Add notes..."
                      />
                    ) : (
                      <p className="text-sm whitespace-pre-wrap leading-relaxed">{person.notes}</p>
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
