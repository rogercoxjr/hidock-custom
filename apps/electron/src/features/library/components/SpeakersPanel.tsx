/**
 * SpeakersPanel
 *
 * One row per distinct speaker file_label with turn-count + talk-time, a contact
 * picker (meeting-attendee pre-filled, all-contacts fallback, inline quick-add),
 * reassign, and merge. Single-speaker -> read-only. Naming only via Contacts.
 * Zero-speaker (empty turns) -> returns null (panel hidden).
 *
 * Phase 2B: read-only suggestion chips (identity / merge / mixed) with explicit
 * confirm/dismiss/self-enroll. Suggestions are fetched by the host and passed in.
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { useConfigStore } from '@/store/domain/useConfigStore'
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
import type { Turn } from '../types/turns'
import type { VoiceprintSummary } from '../../../../electron/main/types/database'

export interface SuggestionView {
  id: string
  kind: 'identity' | 'merge' | 'mixed'
  targetLabel: string
  targetLabel2?: string | null
  contactId?: string | null
  contactName?: string | null
  contactName2?: string | null
  score: number | null
  rank: number | null
  rationale: string | null
  requiresWarning: boolean
}

interface SpeakersPanelProps {
  recordingId: string
  meetingId?: string
  turns: Turn[]
  /** Existing label -> contact name map (from recording_speakers join), for display. */
  assignedNames?: Record<string, string>
  /** Label -> { contactId, contactName } map. Required for contact-scoped un-bank. */
  assignedSpeakers?: Record<string, { contactId: string; contactName: string }>
  /** Pending matcher suggestions for this recording (Phase 2B). */
  suggestions?: SuggestionView[]
  /** Called after any successful assign/merge/reassign/suggestion action so the host can refetch. */
  onChanged: () => void
}

interface PickContact {
  id: string
  name: string
  email: string | null
}

function formatTalkTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/**
 * Sum of a label's spoken time with overlapping/adjacent intervals merged so
 * overlaps are NOT double-counted (spec §6.x). Sort by start, then fold: extend
 * the current run while the next interval starts at/before the current end.
 */
function mergedTalkMs(intervals: Array<{ startMs: number; endMs: number }>): number {
  const sorted = intervals
    .map((i) => ({ startMs: i.startMs, endMs: Math.max(i.startMs, i.endMs) }))
    .sort((a, b) => a.startMs - b.startMs)
  let total = 0
  let curStart = -1
  let curEnd = -1
  for (const { startMs, endMs } of sorted) {
    if (curEnd === -1) {
      curStart = startMs
      curEnd = endMs
    } else if (startMs <= curEnd) {
      // overlapping or adjacent — extend the current run
      curEnd = Math.max(curEnd, endMs)
    } else {
      total += curEnd - curStart
      curStart = startMs
      curEnd = endMs
    }
  }
  if (curEnd !== -1) total += curEnd - curStart
  return total
}

export function SpeakersPanel({
  recordingId,
  meetingId,
  turns,
  assignedNames,
  assignedSpeakers,
  suggestions = [],
  onChanged,
}: SpeakersPanelProps) {
  const { config } = useConfigStore()
  const enableVoiceprintCapture = config?.privacy?.enableVoiceprintCapture ?? true

  const [attendees, setAttendees] = useState<PickContact[]>([])
  const [allContacts, setAllContacts] = useState<PickContact[]>([])
  const [openPickerLabel, setOpenPickerLabel] = useState<string | null>(null)
  const [openMergeLabel, setOpenMergeLabel] = useState<string | null>(null)
  const [openReassignTurn, setOpenReassignTurn] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)

  // Phase 2: transient capture feedback per label (enrolled / skipped / purged)
  type CaptureNote = {
    captured: boolean
    reason?: string
    cleanSpeechMs?: number
    purgedCount?: number
  }
  const [captureNotes, setCaptureNotes] = useState<Record<string, CaptureNote>>({})

  // Phase 2: inline un-bank after clearing an assignment
  const [unbankDialogOpen, setUnbankDialogOpen] = useState(false)
  const [unbankList, setUnbankList] = useState<VoiceprintSummary[]>([])
  const [unbanking, setUnbanking] = useState(false)

  // Phase 2B: merge-warning dialog + self-enroll hint
  const [warningSuggestion, setWarningSuggestion] = useState<SuggestionView | null>(null)
  const [selfHintLabel, setSelfHintLabel] = useState<string | null>(null)

  // Per-label stats: turn-count + talk-time (overlapping intervals merged).
  const labels = useMemo(() => {
    const stats = new Map<string, { count: number; intervals: Array<{ startMs: number; endMs: number }> }>()
    for (const t of turns) {
      const cur = stats.get(t.speaker) ?? { count: 0, intervals: [] }
      cur.count += 1
      cur.intervals.push({ startMs: t.startMs, endMs: t.endMs })
      stats.set(t.speaker, cur)
    }
    return [...stats.entries()]
      .map(([label, s]) => ({ label, count: s.count, talkMs: mergedTalkMs(s.intervals) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [turns])

  const readOnly = labels.length <= 1

  // Group pending suggestions by their primary label.
  const suggestionsByLabel = useMemo(() => {
    const map = new Map<string, SuggestionView[]>()
    for (const s of suggestions) {
      const key = s.targetLabel
      const list = map.get(key) ?? []
      list.push(s)
      map.set(key, list)
    }
    return map
  }, [suggestions])

  // Load attendees (top-sorted) or fall back to all-contacts.
  useEffect(() => {
    let cancelled = false
    async function load() {
      const api = (window as any).electronAPI
      if (meetingId) {
        const res = await api.contacts.getForMeeting(meetingId)
        if (!cancelled && res?.success) setAttendees(res.data ?? [])
      }
      const all = await api.contacts.getAll({})
      if (!cancelled && all?.success) setAllContacts(all.data?.contacts ?? [])
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [meetingId])

  // Phase 2: subscribe to deferred voiceprint capture feedback for THIS recording
  useEffect(() => {
    if (!enableVoiceprintCapture) return
    const unsubscribe = window.electronAPI.onVoiceprintCaptured((data) => {
      if (data.recordingId !== recordingId) return
      setCaptureNotes((prev) => ({
        ...prev,
        [data.fileLabel]: {
          captured: data.captured,
          reason: data.reason,
          cleanSpeechMs: data.cleanSpeechMs,
          purgedCount: data.purgedCount
        }
      }))
      // Auto-clear after ~6 seconds
      setTimeout(() => {
        setCaptureNotes((prev) => {
          const next = { ...prev }
          delete next[data.fileLabel]
          return next
        })
      }, 6000)
    })
    return unsubscribe
  }, [recordingId, enableVoiceprintCapture])

  // Attendees first (de-duped), then the rest, filtered by search.
  const pickList = useMemo(() => {
    const seen = new Set(attendees.map((a) => a.id))
    const rest = allContacts.filter((c) => !seen.has(c.id))
    const merged = [...attendees, ...rest]
    const q = search.trim().toLowerCase()
    if (!q) return merged
    return merged.filter((c) => c.name.toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q))
  }, [attendees, allContacts, search])

  const exactNameMatch = useMemo(
    () => pickList.some((c) => c.name.trim().toLowerCase() === search.trim().toLowerCase()),
    [pickList, search]
  )

  async function assign(
    fileLabel: string,
    contactId: string,
    source?: 'user' | 'confirmed' | 'suggestion_confirmed'
  ): Promise<{ success: boolean; error?: { message?: string } } | undefined> {
    setBusy(true)
    try {
      const res = await (window as any).electronAPI.speakers.assign({
        recordingId,
        fileLabel,
        contactId,
        source: source ?? 'user'
      })
      if (res?.success) {
        setOpenPickerLabel(null)
        setSearch('')
        onChanged()
      } else {
        toast.error('Could not assign speaker', res?.error?.message)
      }
      return res
    } finally {
      setBusy(false)
    }
  }

  async function quickAddAndAssign(fileLabel: string, name: string) {
    setBusy(true)
    try {
      const res = await (window as any).electronAPI.contacts.create({ name: name.trim() })
      if (res?.success && res.data?.id) {
        await assign(fileLabel, res.data.id, 'user')
      } else {
        toast.error('Could not create contact', res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }

  /** Clear a label's assignment (unassign) and optionally un-bank the voiceprints it produced. */
  async function unassign(fileLabel: string) {
    setBusy(true)
    try {
      const priorContactId = assignedSpeakers?.[fileLabel]?.contactId
      const res = await (window as any).electronAPI.speakers.unassign({ recordingId, fileLabel })
      if (res?.success) {
        setOpenPickerLabel(null)
        setSearch('')
        onChanged()
        if (priorContactId) {
          const findRes = await (window as any).electronAPI.voiceprints.findBySource(
            recordingId,
            fileLabel,
            priorContactId
          )
          if (findRes?.success && findRes.data?.length > 0) {
            setUnbankList(findRes.data)
            setUnbankDialogOpen(true)
          }
        }
      } else {
        toast.error('Could not clear assignment', res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function confirmUnbank() {
    if (unbankList.length === 0) return
    setUnbanking(true)
    try {
      for (const vp of unbankList) {
        const delRes = await (window as any).electronAPI.voiceprints.delete(vp.id)
        if (!delRes?.success) {
          console.warn(`[SpeakersPanel] failed to delete voiceprint ${vp.id}`)
        }
      }
      toast.success('Voiceprints removed', `Deleted ${unbankList.length} voiceprint${unbankList.length === 1 ? '' : 's'}.`)
      setUnbankList([])
      setUnbankDialogOpen(false)
    } catch (err) {
      console.error('Failed to un-bank voiceprints:', err)
      toast.error('Failed to remove voiceprints', err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setUnbanking(false)
    }
  }

  async function mergeInto(
    from: string,
    to: string
  ): Promise<{ success: boolean; error?: { message?: string } } | undefined> {
    setBusy(true)
    try {
      const res = await (window as any).electronAPI.speakers.merge({
        recordingId,
        fromLabel: from,
        toLabel: to,
      })
      if (res?.success) {
        setOpenMergeLabel(null)
        onChanged()
      } else {
        toast.error('Could not merge speakers', res?.error?.message)
      }
      return res
    } finally {
      setBusy(false)
    }
  }

  /** Reassign a single turn (by index) to a different existing label, then persist. */
  async function reassignTurn(turnIndex: number, toLabel: string) {
    setBusy(true)
    try {
      const updated = turns.map((t, i) => (i === turnIndex ? { ...t, speaker: toLabel } : t))
      const res = await (window as any).electronAPI.transcripts.updateTurns({
        recordingId,
        turns: updated,
      })
      if (res?.success) {
        setOpenReassignTurn(null)
        onChanged()
      } else {
        toast.error('Could not reassign turn', res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function dismissSuggestion(id: string) {
    setBusy(true)
    try {
      const res = await (window as any).electronAPI.speakers.dismissSuggestion(id)
      if (res?.success) {
        onChanged()
      } else {
        toast.error('Could not dismiss suggestion', res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function acceptSuggestion(id: string) {
    setBusy(true)
    try {
      const res = await (window as any).electronAPI.speakers.acceptSuggestion(id)
      if (!res?.success) {
        console.warn(`[SpeakersPanel] failed to mark suggestion ${id} accepted`, res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function confirmIdentity(suggestion: SuggestionView) {
    if (!suggestion.contactId) return
    const res = await assign(suggestion.targetLabel, suggestion.contactId, 'suggestion_confirmed')
    if (res?.success) await acceptSuggestion(suggestion.id)
  }

  async function doConfirmMerge(suggestion: SuggestionView) {
    if (!suggestion.targetLabel2) return
    const res = await mergeInto(suggestion.targetLabel, suggestion.targetLabel2)
    if (res?.success) await acceptSuggestion(suggestion.id)
  }

  function confirmMerge(suggestion: SuggestionView) {
    if (suggestion.requiresWarning) {
      setWarningSuggestion(suggestion)
    } else {
      void doConfirmMerge(suggestion)
    }
  }

  async function setSelfForLabel(fileLabel: string) {
    setBusy(true)
    try {
      const res = await (window as any).electronAPI.speakers.setSelf({ recordingId, fileLabel })
      if (res?.success && res.data?.selfAssigned) {
        setSelfHintLabel(null)
        onChanged()
      } else if (res?.success && res.data?.needsSelfContact) {
        setSelfHintLabel(fileLabel)
      } else {
        toast.error('Could not set self speaker', res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function dismissAllSuggestions() {
    if (suggestions.length === 0) return
    setBusy(true)
    try {
      await Promise.all(suggestions.map((s) => (window as any).electronAPI.speakers.dismissSuggestion(s.id)))
    } catch (err) {
      console.error('Failed to dismiss all suggestions:', err)
      toast.error('Failed to dismiss all suggestions')
    } finally {
      onChanged()
      setBusy(false)
    }
  }

  if (labels.length === 0) return null

  const humanSkipReason = (reason?: string): string => {
    switch (reason) {
      case 'voiceprint-disabled': return 'Voiceprint capture is off in Settings'
      case 'voiceprint-unavailable': return 'Voiceprint engine unavailable'
      case 'insufficient-clean-speech': return 'Not enough clean speech to remember the voice'
      case 'no-audio-file': return 'No audio file available'
      case 'decode-failed': return 'Could not decode audio'
      case 'no-samples': return 'No usable audio samples'
      case 'embedding-failed': return 'Could not compute voice embedding'
      case 'superseded': return 'A newer voiceprint was already saved'
      default: return reason ? `Voice not remembered (${reason})` : 'Voice not remembered'
    }
  }

  const humanIdentityLabel = (s: SuggestionView): string => {
    const r = s.rationale ?? ''
    if (r.includes('strong')) return 'Match'
    return 'Likely'
  }

  const MAX_IDENTITY_CHIPS = 2

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Speakers</p>
        {suggestions.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void dismissAllSuggestions()} disabled={busy}>
            Dismiss all suggestions
          </Button>
        )}
      </div>
      {!enableVoiceprintCapture && (
        <p className="text-xs text-muted-foreground italic">
          Voice memory is off — assignments won&apos;t be remembered. Enable in Settings → Privacy.
        </p>
      )}
      {labels.map(({ label, count, talkMs }) => {
        const assignment = assignedSpeakers?.[label]
        const assignedName = assignment?.contactName ?? assignedNames?.[label]
        const note = captureNotes[label]
        const labelSuggestions = suggestionsByLabel.get(label) ?? []
        const identityChips = labelSuggestions
          .filter((s) => s.kind === 'identity')
          .slice(0, MAX_IDENTITY_CHIPS)
        const otherChips = labelSuggestions.filter((s) => s.kind !== 'identity')
        return (
          <div key={label} className="relative flex flex-col gap-2 p-2 border rounded-lg bg-muted/30">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm w-10">{label}</span>
              <span className="text-xs text-muted-foreground flex-1">
                <span>{count} turns</span>
                <span> &bull; </span>
                <span>{formatTalkTime(talkMs)}</span>
                {assignedName && <span className="ml-2 text-foreground font-medium">→ {assignedName}</span>}
              </span>

              {!readOnly && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Merge speaker ${label}`}
                  onClick={() => setOpenMergeLabel(openMergeLabel === label ? null : label)}
                >
                  Merge
                </Button>
              )}

              <Button
                variant="outline"
                size="sm"
                aria-label={`Assign contact to ${label}`}
                onClick={() => {
                  setOpenPickerLabel(openPickerLabel === label ? null : label)
                  setSearch('')
                }}
              >
                {assignedName ? 'Reassign' : 'Assign'}
              </Button>

              {!assignedName && enableVoiceprintCapture && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`This label is me: ${label}`}
                  onClick={() => void setSelfForLabel(label)}
                  disabled={busy}
                >
                  This is me
                </Button>
              )}
            </div>

            {openMergeLabel === label && (
              <div className="z-10 p-2 bg-background border rounded-lg shadow">
                {labels
                  .filter((l) => l.label !== label)
                  .map((target) => (
                    <button
                      key={target.label}
                      className="block w-full text-left text-sm px-2 py-1 hover:bg-muted rounded"
                      aria-label={`Merge into ${target.label}`}
                      onClick={() => mergeInto(label, target.label)}
                    >
                      Merge into {target.label}
                    </button>
                  ))}
              </div>
            )}

            {openPickerLabel === label && (
              <div className="z-10 w-full p-2 bg-background border rounded-lg shadow space-y-2">
                <Input
                  aria-label="Search or add a contact"
                  placeholder="Search or add a contact..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  disabled={busy}
                />
                <div className="max-h-48 overflow-y-auto">
                  {pickList.map((c) => (
                    <button
                      key={c.id}
                      className="block w-full text-left text-sm px-2 py-1 hover:bg-muted rounded"
                      onClick={() => assign(label, c.id, 'user')}
                      disabled={busy}
                    >
                      {c.name}
                      {c.email && <span className="text-muted-foreground ml-1">({c.email})</span>}
                    </button>
                  ))}
                  {search.trim() && !exactNameMatch && (
                    <button
                      className="block w-full text-left text-sm px-2 py-1 text-primary hover:bg-muted rounded"
                      aria-label={`Create contact "${search.trim()}"`}
                      onClick={() => quickAddAndAssign(label, search)}
                      disabled={busy}
                    >
                      Create contact &quot;{search.trim()}&quot;
                    </button>
                  )}
                  {assignment && (
                    <button
                      className="block w-full text-left text-sm px-2 py-1 text-destructive hover:bg-muted rounded"
                      aria-label={`Clear assignment for ${assignedName ?? label}`}
                      onClick={() => unassign(label)}
                      disabled={busy}
                    >
                      Clear assignment{assignedName ? ` for ${assignedName}` : ''}
                    </button>
                  )}
                </div>
              </div>
            )}

            {selfHintLabel === label && (
              <div className="text-xs px-1 text-muted-foreground" data-testid="self-hint">
                Mark a contact as <strong>Me</strong> first in People → &quot;This is me&quot;.
              </div>
            )}

            {/* Phase 2B: suggestion chips */}
            {[...identityChips, ...otherChips].map((s) => (
              <div
                key={s.id}
                className={`flex flex-wrap items-center gap-2 text-xs px-2 py-1.5 rounded-md border ${
                  s.kind === 'identity' && (s.rationale ?? '').includes('strong')
                    ? 'bg-primary/10 border-primary/30'
                    : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900'
                }`}
              >
                {s.kind === 'identity' && s.contactName && (
                  <>
                    <span className="font-medium">
                      Looks like {s.contactName} ({humanIdentityLabel(s)})
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => void confirmIdentity(s)}
                      disabled={busy}
                    >
                      Confirm
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground"
                      onClick={() => void dismissSuggestion(s.id)}
                      disabled={busy}
                    >
                      Dismiss
                    </Button>
                  </>
                )}
                {s.kind === 'merge' && s.targetLabel2 && (
                  <>
                    <span className="font-medium">
                      {s.targetLabel} & {s.targetLabel2} may be one voice
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => confirmMerge(s)}
                      disabled={busy}
                    >
                      Confirm merge
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground"
                      onClick={() => void dismissSuggestion(s.id)}
                      disabled={busy}
                    >
                      Dismiss
                    </Button>
                  </>
                )}
                {s.kind === 'mixed' && (
                  <>
                    <span className="font-medium">{s.targetLabel} may contain two voices</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground"
                      onClick={() => void dismissSuggestion(s.id)}
                      disabled={busy}
                    >
                      Dismiss
                    </Button>
                  </>
                )}
              </div>
            ))}

            {note && (
              <div className="text-xs px-1">
                {note.captured ? (
                  <span className="text-green-600">
                    Voice remembered
                    {note.purgedCount && note.purgedCount > 0 ? ` (replaced ${note.purgedCount} older voiceprint${note.purgedCount === 1 ? '' : 's'})` : ''}
                    {note.cleanSpeechMs && ` · ${formatTalkTime(note.cleanSpeechMs)} clean speech`}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{humanSkipReason(note.reason)} · assignment not banked</span>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* Per-turn reassign (AC3): change one turn's speaker to another existing label. */}
      {!readOnly && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Turns</p>
          {turns.map((t, i) => (
            <div key={`${t.startMs}-${t.speaker}`} className="relative flex items-start gap-2 p-2 border rounded-lg bg-muted/20">
              <span className="font-semibold text-xs w-6 shrink-0">{t.speaker}</span>
              <span className="text-xs flex-1 min-w-0">{t.text}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Reassign turn: ${t.text}`}
                onClick={() => setOpenReassignTurn(openReassignTurn === i ? null : i)}
                disabled={busy}
              >
                Reassign
              </Button>
              {openReassignTurn === i && (
                <div className="absolute right-2 top-10 z-10 p-2 bg-background border rounded-lg shadow">
                  {labels
                    .filter((l) => l.label !== t.speaker)
                    .map((target) => (
                      <button
                        key={target.label}
                        className="block w-full text-left text-sm px-2 py-1 hover:bg-muted rounded"
                        aria-label={`Reassign to ${target.label}`}
                        onClick={() => reassignTurn(i, target.label)}
                        disabled={busy}
                      >
                        Reassign to {target.label}
                      </button>
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={unbankDialogOpen} onOpenChange={setUnbankDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove banked voiceprints?</AlertDialogTitle>
            <AlertDialogDescription>
              Clearing this assignment found {unbankList.length} remembered voiceprint{unbankList.length === 1 ? '' : 's'} for this speaker.
              Remove {unbankList.length === 1 ? 'it' : 'them'} from the voice library?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setUnbankList([])} disabled={unbanking}>Keep in library</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmUnbank}
              disabled={unbanking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {unbanking ? 'Removing...' : `Remove ${unbankList.length} voiceprint${unbankList.length === 1 ? '' : 's'}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!warningSuggestion} onOpenChange={(open) => !open && setWarningSuggestion(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge speakers across contacts?</AlertDialogTitle>
            <AlertDialogDescription>
              This would merge {warningSuggestion?.contactName} and {warningSuggestion?.contactName2} into one speaker.
              Only confirm if you&apos;re sure these labels are the same person.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setWarningSuggestion(null)} disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (warningSuggestion) {
                  const s = warningSuggestion
                  setWarningSuggestion(null)
                  void doConfirmMerge(s)
                }
              }}
              disabled={busy}
            >
              Confirm merge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
