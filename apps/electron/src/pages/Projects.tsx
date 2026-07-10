import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Folder,
  Search,
  Plus,
  RefreshCw,
  Clock,
  Trash2,
  Archive,
  CheckCircle2,
  FileText,
  Bot,
  Users,
  Edit,
  Check,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import { Eyebrow } from '@/components/harbor/Eyebrow'
import { PersonAvatar } from '@/components/harbor/PersonAvatar'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose
} from '@/components/ui/dialog'
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
import type { Project } from '@/types/knowledge'

/** Resolved member info for display in the project detail */
interface ProjectMember {
  id: string
  name: string
  type: string
}
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/toaster'
import { useDataRefresh } from '@/hooks/useDataRefresh'

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'active' | 'archived' | 'all'>('active')

  // B-PRJ-006: Create project dialog state (replaces prompt())
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')

  // B-PRJ-007: Delete project dialog state (replaces confirm())
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([])

  // Inline description editing state
  const [isEditingDescription, setIsEditingDescription] = useState(false)
  const [editDescription, setEditDescription] = useState('')

  // Debounce: skip firing on initial mount
  const isFirstMount = useRef(true)

  // B-PRJ-005: Memoized loadProjects with useCallback
  const loadProjects = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.projects.getAll({
        search: searchQuery,
        status: statusFilter
      })
      if (result.success) {
        const mapped = result.data.projects.map((p: any) => ({
          ...p,
          status: p.status || 'active',
          createdAt: p.created_at || p.createdAt || new Date().toISOString()
        }))
        setProjects(mapped)
      }
    } catch (error) {
      console.error('Failed to load projects:', error)
      toast.error('Failed to load projects', error instanceof Error ? error.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [searchQuery, statusFilter])

  // Initial load: fire immediately
  useEffect(() => {
    loadProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-refresh when recordings/transcriptions change (project associations may shift).
  useDataRefresh('projects', loadProjects)

  // Subsequent changes: debounce search/filter
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false
      return
    }
    const timer = setTimeout(() => {
      loadProjects()
    }, 300)
    return () => clearTimeout(timer)
  }, [loadProjects])

  // Projects are already filtered server-side by searchQuery and statusFilter
  const filteredProjects = projects

  // B-PRJ-006: Create project via Dialog instead of prompt()
  const handleCreateProject = async () => {
    if (!createName.trim()) return

    try {
      const result = await window.electronAPI.projects.create({
        name: createName.trim(),
        description: createDescription.trim() || undefined
      })
      if (result.success) {
        const p = result.data as any
        const mapped: Project = {
          ...p,
          status: p.status || 'active',
          createdAt: p.created_at || p.createdAt || new Date().toISOString()
        }
        setProjects(prev => [mapped, ...prev])
        setActiveProject(mapped)
        toast.success('Project created', `"${mapped.name}" has been created.`)
      }
    } catch (error) {
      console.error('Failed to create project:', error)
      toast.error('Failed to create project', error instanceof Error ? error.message : 'An unexpected error occurred')
    }

    setCreateDialogOpen(false)
    setCreateName('')
    setCreateDescription('')
  }

  const openCreateDialog = () => {
    setCreateName('')
    setCreateDescription('')
    setCreateDialogOpen(true)
  }

  // B-PRJ-007: Delete project via AlertDialog instead of confirm()
  const handleDeleteProject = async () => {
    if (!activeProject) return
    try {
      const result = await window.electronAPI.projects.delete(activeProject.id)
      if (result.success) {
        toast.success('Project deleted', `"${activeProject.name}" has been deleted.`)
        setProjects(prev => prev.filter(p => p.id !== activeProject.id))
        setActiveProject(null)
      }
    } catch (error) {
      console.error('Failed to delete project:', error)
      toast.error('Failed to delete project', error instanceof Error ? error.message : 'An unexpected error occurred')
    }
    setDeleteDialogOpen(false)
  }

  // Load project details with knowledgeIds/personIds when selected
  const handleSelectProject = async (project: Project) => {
    setActiveProject(project)
    setProjectMembers([])
    setDetailLoading(true)
    setIsEditingDescription(false)
    try {
      const result = await window.electronAPI.projects.getById(project.id)
      if (result.success && result.data.project) {
        const p = result.data.project as any
        const detailed: Project = {
          id: p.id,
          name: p.name,
          description: p.description,
          status: p.status || 'active',
          createdAt: p.created_at || p.createdAt || new Date().toISOString(),
          knowledgeIds: p.knowledgeIds,
          personIds: p.personIds
        }
        setActiveProject(detailed)

        // Resolve person names from IDs in parallel (fixes N+1 query)
        if (detailed.personIds && detailed.personIds.length > 0) {
          const memberPromises = detailed.personIds.map(async (personId): Promise<ProjectMember> => {
            try {
              const contactResult = await window.electronAPI.contacts.getById(personId)
              if (contactResult.success && contactResult.data.contact) {
                const c = contactResult.data.contact as any
                return { id: c.id, name: c.name, type: c.type || 'unknown' }
              }
            } catch {
              // Skip unresolvable contacts
            }
            return { id: personId, name: personId.substring(0, 8) + '...', type: 'unknown' }
          })
          const members = await Promise.all(memberPromises)
          setProjectMembers(members)
        }
      }
    } catch (err) {
      console.error('Failed to load project details:', err)
      toast.error('Failed to load project details', err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setDetailLoading(false)
    }
  }

  // Save description inline
  const handleSaveDescription = async () => {
    if (!activeProject) return
    try {
      const result = await window.electronAPI.projects.update({
        id: activeProject.id,
        description: editDescription.trim() || null
      })
      if (result.success) {
        const updated: Project = { ...activeProject, description: editDescription.trim() || null }
        setActiveProject(updated)
        setProjects(prev => prev.map(p => p.id === activeProject.id ? updated : p))
        toast.success('Description updated', 'Project description has been saved.')
      }
    } catch (err) {
      console.error('Failed to update description:', err)
      toast.error('Failed to update description', err instanceof Error ? err.message : 'An unexpected error occurred')
    }
    setIsEditingDescription(false)
  }

  return (
    <div className="flex h-full bg-bg">
      {/* Sidebar - Projects List */}
      <aside className="w-80 border-r border-border flex flex-col bg-surface">
        <div className="p-4 border-b border-border space-y-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <Eyebrow>Organization</Eyebrow>
              <h1 className="font-display text-[1.75rem] font-semibold tracking-[-0.02em] text-ink">Projects</h1>
            </div>
            <Button onClick={openCreateDialog} size="sm" className="h-8 gap-1 shrink-0">
              <Plus className="h-4 w-4" />
              New
            </Button>
          </div>

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-ink-muted" />
            <Input
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9"
            />
          </div>

          <SegmentedToggle
            size="sm"
            className="flex w-full [&>button]:flex-1"
            aria-label="Filter projects by status"
            value={statusFilter}
            onChange={(s) => setStatusFilter(s)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' }
            ]}
          />
        </div>

        <div className="flex-1 overflow-auto p-2">
          {loading && projects.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-6 w-6 animate-spin text-ink-muted" />
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="text-center py-12 px-4">
              <Folder className="h-8 w-8 mx-auto text-ink-muted opacity-20 mb-3" />
              <p className="text-xs text-ink-muted mb-3">
                {searchQuery
                  ? `No projects matching "${searchQuery}"`
                  : statusFilter === 'all'
                    ? 'No projects yet'
                    : `No ${statusFilter} projects`}
              </p>
              {!searchQuery && (
                <Button onClick={openCreateDialog} size="sm" variant="outline" className="h-7 text-xs gap-1">
                  <Plus className="h-3 w-3" />
                  Create Project
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredProjects.map((project) => {
                const isActive = activeProject?.id === project.id
                return (
                  <div
                    key={project.id}
                    onClick={() => handleSelectProject(project)}
                    className={cn(
                      "w-full text-left p-3 rounded-lg border transition-colors cursor-pointer group",
                      isActive
                        ? "bg-accent-strong-soft border-border-brand"
                        : "border-transparent hover:bg-surface-hover"
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className={cn(
                        "w-10 h-10 rounded-lg flex items-center justify-center border shadow-xs shrink-0",
                        isActive ? "bg-surface border-border-brand" : "bg-surface-sunken border-border"
                      )}>
                        <Folder className={cn("h-5 w-5", isActive ? "text-accent-2" : "text-ink-muted")} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={cn(
                          "text-sm font-semibold truncate",
                          isActive ? "text-[var(--accent-soft-text)]" : "text-ink"
                        )}>{project.name}</p>
                        <div className="flex items-center gap-1.5 mt-1 font-mono text-[10px] text-ink-muted">
                          <Clock className="h-3 w-3" />
                          <span>{new Date(project.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </aside>

      {/* Main Detail Area */}
      <main className="flex-1 flex flex-col min-w-0">
        {activeProject && detailLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center">
            <RefreshCw className="h-8 w-8 animate-spin text-ink-muted mb-4" />
            <p className="text-sm text-ink-muted">Loading project details...</p>
          </div>
        ) : activeProject ? (
          <div className="flex flex-col h-full overflow-hidden animate-in fade-in slide-in-from-right-2 duration-300">
            {/* Header */}
            <header className="border-b border-border bg-surface px-8 py-6 h-[120px] flex items-center justify-between">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-14 h-14 rounded-xl bg-accent-2-soft border border-border-brand flex items-center justify-center shrink-0">
                  <Folder className="h-7 w-7 text-accent-2" />
                </div>
                <div className="min-w-0">
                  <Eyebrow tone="muted">Project</Eyebrow>
                  <h2 className="font-display text-[1.75rem] font-semibold tracking-[-0.02em] text-ink truncate">{activeProject.name}</h2>
                  <div className="flex items-center gap-3 mt-1">
                    <Badge variant={activeProject.status === 'active' ? 'success' : 'default'} className="uppercase tracking-[0.08em]">
                      {activeProject.status}
                    </Badge>
                    <span className="text-xs text-ink-muted">Created {new Date(activeProject.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-2"
                  onClick={async () => {
                    const newStatus: 'active' | 'archived' = activeProject.status === 'active' ? 'archived' : 'active'
                    try {
                      const result = await window.electronAPI.projects.update({ id: activeProject.id, status: newStatus })
                      if (result.success) {
                        const updated: Project = { ...activeProject, status: newStatus }
                        setActiveProject(updated)
                        setProjects(prev => prev.map(p => p.id === activeProject.id ? updated : p))
                      }
                    } catch (error) {
                      console.error('Failed to update project status:', error)
                      toast.error('Failed to update project', error instanceof Error ? error.message : 'An unexpected error occurred')
                    }
                  }}
                >
                  <Archive className="h-4 w-4" />
                  {activeProject.status === 'active' ? 'Archive' : 'Activate'}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 text-ink-muted hover:text-danger"
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </header>

            {/* Content */}
            <div className="flex-1 overflow-auto p-[var(--space-6)]">
              <div className="max-w-4xl mx-auto space-y-[var(--space-6)]">
                {/* Stats Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <Card className="bg-surface">
                    <CardContent className="pt-6">
                      <div className="flex items-center justify-between">
                        <Eyebrow tone="muted">Knowledge</Eyebrow>
                        <FileText className="h-4 w-4 text-accent-2" />
                      </div>
                      <p className="font-display text-[1.75rem] font-semibold tracking-[-0.01em] text-ink mt-2">{activeProject.knowledgeIds?.length ?? '\u2014'} {activeProject.knowledgeIds ? 'Items' : ''}</p>
                    </CardContent>
                  </Card>
                  <Card className="bg-surface">
                    <CardContent className="pt-6">
                      <div className="flex items-center justify-between">
                        <Eyebrow tone="muted">People</Eyebrow>
                        <Users className="h-4 w-4 text-accent-2" />
                      </div>
                      <p className="font-display text-[1.75rem] font-semibold tracking-[-0.01em] text-ink mt-2">{activeProject.personIds?.length ?? '\u2014'} {activeProject.personIds ? 'Involved' : ''}</p>
                      {projectMembers.length > 0 && (
                        <div className="mt-3 space-y-1.5">
                          {projectMembers.slice(0, 5).map((member) => (
                            <div key={member.id} className="flex items-center gap-2 text-xs">
                              <PersonAvatar name={member.name} size={20} />
                              <span className="truncate text-foreground">{member.name}</span>
                            </div>
                          ))}
                          {projectMembers.length > 5 && (
                            <p className="text-[10px] text-ink-muted pl-7">+{projectMembers.length - 5} more</p>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                  <Card className="bg-surface">
                    <CardContent className="pt-6">
                      <div className="flex items-center justify-between">
                        <Eyebrow tone="muted">Actions</Eyebrow>
                        <CheckCircle2 className="h-4 w-4 text-accent-2" />
                      </div>
                      <p className="font-display text-[1.75rem] font-semibold tracking-[-0.01em] text-ink mt-2">{'\u2014'}</p>
                    </CardContent>
                  </Card>
                </div>

                {/* Description (inline editable) */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Eyebrow tone="muted">Description</Eyebrow>
                    {!isEditingDescription && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => {
                          setEditDescription(activeProject.description || '')
                          setIsEditingDescription(true)
                        }}
                      >
                        <Edit className="h-3 w-3" />
                        Edit
                      </Button>
                    )}
                  </div>
                  {isEditingDescription ? (
                    <div className="space-y-2">
                      <textarea
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        className="w-full text-sm border border-border rounded-md px-4 py-3 bg-surface text-foreground min-h-[80px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
                        placeholder="Add a project description..."
                        autoFocus
                      />
                      <div className="flex items-center gap-2">
                        <Button size="sm" className="h-7 text-xs gap-1" onClick={handleSaveDescription}>
                          <Check className="h-3 w-3" />
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => setIsEditingDescription(false)}>
                          <X className="h-3 w-3" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm leading-relaxed text-ink-muted bg-surface-sunken p-4 rounded-lg border border-border italic">
                      {activeProject.description || "No description provided for this project."}
                    </p>
                  )}
                </div>

                {/* AI Suggestions */}
                <Card className="border-border-brand bg-accent-2-soft">
                  <CardContent className="p-6">
                    <div className="flex items-center gap-2 mb-4">
                      <Bot className="h-5 w-5 text-accent-2" />
                      <Eyebrow>AI Project Insight</Eyebrow>
                    </div>
                    <p className="text-sm leading-relaxed text-ink-muted italic">
                      AI-generated insights for "{activeProject.name}" will appear here once knowledge items are linked to this project.
                    </p>
                    <div className="mt-4 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs bg-surface"
                        disabled
                        title="Coming soon"
                        onClick={() => toast.info('Coming soon', 'Report generation is not yet available.')}
                      >
                        Generate Status Report
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs bg-surface"
                        disabled
                        title="Coming soon"
                        onClick={() => toast.info('Coming soon', 'Decision summarization is not yet available.')}
                      >
                        Summarize Decisions
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {/* Placeholder for tabs content */}
                <div className="pt-4 text-center py-20 border-2 border-dashed border-border rounded-xl text-ink-muted opacity-50">
                  <Folder className="h-12 w-12 mx-auto mb-4" />
                  <p className="text-sm">Knowledge Timeline and Related People visualization will appear here.</p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-ink-muted p-8">
            <div className="w-20 h-20 rounded-xl bg-surface-sunken flex items-center justify-center mb-6">
              <Folder className="h-10 w-10 opacity-30" />
            </div>
            <h2 className="font-display text-[1.375rem] font-semibold tracking-[-0.01em] text-ink mb-2">Select a Project</h2>
            <p className="text-sm max-w-xs text-center leading-relaxed">
              Choose a project from the sidebar to view aggregated knowledge, people, and AI insights.
            </p>
            <Button onClick={openCreateDialog} variant="outline" className="mt-8 gap-2">
              <Plus className="h-4 w-4" />
              Create New Project
            </Button>
          </div>
        )}
      </main>

      {/* B-PRJ-006: Create Project Dialog (replaces prompt()) */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Project</DialogTitle>
            <DialogDescription>
              Enter a name for your new project.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium text-ink mb-1 block">Project Name</label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Enter project name..."
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && createName.trim()) {
                    handleCreateProject()
                  }
                }}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-ink mb-1 block">Description (optional)</label>
              <textarea
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder="Brief description..."
                className="w-full text-sm border border-border rounded-md px-3 py-2 bg-surface text-foreground min-h-[60px] focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleCreateProject} disabled={!createName.trim()}>
              Create Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* B-PRJ-007: Delete Project AlertDialog (replaces confirm()) */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{activeProject?.name}"? This will remove all meeting associations for this project. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteProject}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
export default Projects
