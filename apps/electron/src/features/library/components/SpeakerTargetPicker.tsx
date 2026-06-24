/**
 * SpeakerTargetPicker
 *
 * Assign-style target chooser shared by the By-Speaker reassign control. Lists the
 * recording's existing speakers (by assigned name or "Speaker X", excluding the source),
 * a contact search (meeting attendees first, then all contacts) with a Create-contact
 * quick-add, and a "New speaker" option. Emits the chosen target via onPick; the caller
 * (TranscriptViewer reassign control) translates that into a speakers:reassignTurns request.
 */

import { useEffect, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { PersonAvatar } from '@/components/harbor/PersonAvatar'
import { toast } from '@/components/ui/toaster'

export interface SpeakerOption {
  label: string
  name: string | null
}

export type PickedTarget =
  | { kind: 'existingLabel'; label: string }
  | { kind: 'contact'; contactId: string }
  | { kind: 'newSpeaker' }

export interface SpeakerTargetPickerProps {
  sourceLabel: string
  speakers: SpeakerOption[]
  meetingId?: string
  canMintNew: boolean
  onPick: (target: PickedTarget) => void
  disabled?: boolean
}

interface PickContact {
  id: string
  name: string
  email: string | null
}

export function SpeakerTargetPicker({
  sourceLabel,
  speakers,
  meetingId,
  canMintNew,
  onPick,
  disabled = false,
}: SpeakerTargetPickerProps) {
  const [attendees, setAttendees] = useState<PickContact[]>([])
  const [allContacts, setAllContacts] = useState<PickContact[]>([])
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  const otherSpeakers = useMemo(
    () => speakers.filter((s) => s.label !== sourceLabel),
    [speakers, sourceLabel]
  )

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

  async function createAndPick(name: string) {
    setBusy(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (window as any).electronAPI.contacts.create({ name: name.trim() })
      if (res?.success && res.data?.id) {
        onPick({ kind: 'contact', contactId: res.data.id })
      } else {
        toast.error('Could not create contact', res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-[308px] space-y-2.5 p-3.5">
      <div className="space-y-0.5">
        {otherSpeakers.map((s) => (
          <button
            key={s.label}
            className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover disabled:opacity-50"
            aria-label={s.name ? `Reassign to ${s.name} (${s.label})` : `Reassign to Speaker ${s.label}`}
            onClick={() => onPick({ kind: 'existingLabel', label: s.label })}
            disabled={disabled || busy}
          >
            <PersonAvatar name={s.name ?? s.label} size={24} />
            <span className="min-w-0 flex-1 truncate font-medium text-ink">
              {s.name ?? `Speaker ${s.label}`}
            </span>
            {s.name && <span className="font-mono text-[11px] text-ink-muted">{s.label}</span>}
          </button>
        ))}
      </div>

      <Input
        aria-label="Search or add a contact"
        placeholder="Search or add a contact..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        disabled={disabled || busy}
      />
      <div className="max-h-44 space-y-0.5 overflow-y-auto">
        {pickList.map((c) => {
          const isAttendee = attendees.some((a) => a.id === c.id)
          return (
            <button
              key={c.id}
              className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover disabled:opacity-50"
              aria-label={c.name}
              onClick={() => onPick({ kind: 'contact', contactId: c.id })}
              disabled={disabled || busy}
            >
              <PersonAvatar name={c.name} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{c.name}</span>
                {c.email && <span className="block truncate text-[11px] text-ink-muted">{c.email}</span>}
              </span>
              {isAttendee && (
                <Badge variant="accent" size="sm">
                  Attendee
                </Badge>
              )}
            </button>
          )
        })}
        {search.trim() && !exactNameMatch && (
          <button
            className="flex w-full items-center gap-2.5 rounded-md border border-dashed border-border-strong px-2 py-2 text-left text-sm text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
            aria-label={`Create contact "${search.trim()}"`}
            onClick={() => createAndPick(search)}
            disabled={disabled || busy}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-strong-soft text-base leading-none text-accent-strong">
              +
            </span>
            <span className="font-medium">Create contact &quot;{search.trim()}&quot;</span>
          </button>
        )}
      </div>

      <button
        className="block w-full rounded-sm px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="New speaker"
        title={canMintNew ? 'Move to a brand-new speaker' : 'All 26 speaker letters are in use'}
        onClick={() => onPick({ kind: 'newSpeaker' })}
        disabled={disabled || busy || !canMintNew}
      >
        New speaker
      </button>
    </div>
  )
}
