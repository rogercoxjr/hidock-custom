/**
 * SpeakersPanel
 *
 * One row per distinct speaker file_label with turn-count + talk-time, a contact
 * picker (meeting-attendee pre-filled, all-contacts fallback, inline quick-add),
 * reassign, and merge. Single-speaker -> read-only. Naming only via Contacts.
 * Zero-speaker (empty turns) -> returns null (panel hidden).
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import type { Turn } from '../types/turns'

interface SpeakersPanelProps {
  recordingId: string
  meetingId?: string
  turns: Turn[]
  /** Existing label -> contact name map (from recording_speakers join), for display. */
  assignedNames?: Record<string, string>
  /** Called after any successful assign/merge so the host can refetch. */
  onChanged: () => void
  /** Merge rewrite hook: rewrite all turns with speaker===from to `to`, persist. */
  onMergeTurns?: (from: string, to: string) => void
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

export function SpeakersPanel({
  recordingId,
  meetingId,
  turns,
  assignedNames,
  onChanged,
  onMergeTurns,
}: SpeakersPanelProps) {
  const [attendees, setAttendees] = useState<PickContact[]>([])
  const [allContacts, setAllContacts] = useState<PickContact[]>([])
  const [openPickerLabel, setOpenPickerLabel] = useState<string | null>(null)
  const [openMergeLabel, setOpenMergeLabel] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)

  // Per-label stats: turn-count + talk-time (Σ endMs-startMs).
  const labels = useMemo(() => {
    const stats = new Map<string, { count: number; talkMs: number }>()
    for (const t of turns) {
      const cur = stats.get(t.speaker) ?? { count: 0, talkMs: 0 }
      cur.count += 1
      cur.talkMs += Math.max(0, t.endMs - t.startMs)
      stats.set(t.speaker, cur)
    }
    return [...stats.entries()]
      .map(([label, s]) => ({ label, ...s }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [turns])

  const readOnly = labels.length <= 1

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

  async function assign(fileLabel: string, contactId: string) {
    setBusy(true)
    try {
      const res = await (window as any).electronAPI.speakers.assign({ recordingId, fileLabel, contactId })
      if (res?.success) {
        setOpenPickerLabel(null)
        setSearch('')
        onChanged()
      } else {
        toast.error('Could not assign speaker', res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function quickAddAndAssign(fileLabel: string, name: string) {
    setBusy(true)
    try {
      const res = await (window as any).electronAPI.contacts.create({ name: name.trim() })
      if (res?.success && res.data?.id) {
        await assign(fileLabel, res.data.id)
      } else {
        toast.error('Could not create contact', res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }

  function mergeInto(from: string, to: string) {
    onMergeTurns?.(from, to)
    setOpenMergeLabel(null)
    onChanged()
  }

  if (labels.length === 0) return null

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Speakers</p>
      {labels.map(({ label, count, talkMs }) => {
        const assignedName = assignedNames?.[label]
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
                      onClick={() => assign(label, c.id)}
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
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
