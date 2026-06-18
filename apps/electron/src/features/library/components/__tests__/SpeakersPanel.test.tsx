import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SpeakersPanel } from '../SpeakersPanel'
import type { Turn } from '../../types/turns'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

const mockAssign = vi.fn().mockResolvedValue({ success: true })
const mockMerge = vi.fn().mockResolvedValue({ success: true })
const mockUpdateTurns = vi.fn().mockResolvedValue({ success: true })
const mockCreate = vi.fn()
const mockGetForMeeting = vi.fn()
const mockGetAll = vi.fn()

function makeTurns(): Turn[] {
  return [
    { speaker: 'A', startMs: 0, endMs: 5000, text: 'Hello there.' },
    { speaker: 'B', startMs: 5000, endMs: 8000, text: 'Hi.' },
    { speaker: 'A', startMs: 8000, endMs: 12000, text: 'How are you?' },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetForMeeting.mockResolvedValue({ success: true, data: [{ id: 'c-att', name: 'Attendee Alice', email: 'alice@x.com' }] })
  mockGetAll.mockResolvedValue({ success: true, data: { contacts: [{ id: 'c-bob', name: 'Bob', email: 'bob@x.com' }], total: 1 } })
  Object.defineProperty(window, 'electronAPI', {
    value: {
      contacts: { getForMeeting: mockGetForMeeting, getAll: mockGetAll, create: mockCreate },
      speakers: { assign: mockAssign, merge: mockMerge },
      transcripts: { updateTurns: mockUpdateTurns },
    },
    writable: true,
    configurable: true,
  })
})

describe('SpeakersPanel (AC2/AC3)', () => {
  it('renders one row per distinct file_label with turn-count and talk-time', async () => {
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={vi.fn()} />)
    // One assign control per distinct label (A and B) confirms one row each.
    expect(await screen.findByRole('button', { name: /assign contact to a/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /assign contact to b/i })).toBeInTheDocument()
    // A: 2 turns; talk-time 5000 + 4000 = 9s -> 00:00:09
    expect(screen.getByText(/2 turns/i)).toBeInTheDocument()
    expect(screen.getByText('00:00:09')).toBeInTheDocument()
  })

  it('pre-fills the contact picker with meeting attendees on top (AC2)', async () => {
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={vi.fn()} />)
    await waitFor(() => expect(mockGetForMeeting).toHaveBeenCalledWith('meet-1'))
    // Open the picker for label A
    fireEvent.click(screen.getAllByRole('button', { name: /assign contact/i })[0])
    expect(await screen.findByText('Attendee Alice')).toBeInTheDocument()
  })

  it('falls back to all-contacts search when there is no meeting (AC2)', async () => {
    render(<SpeakersPanel recordingId="rec-1" meetingId={undefined} turns={makeTurns()} onChanged={vi.fn()} />)
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled())
    expect(mockGetForMeeting).not.toHaveBeenCalled()
  })

  it('assigns a contact via speakers:assign (AC3)', async () => {
    const onChanged = vi.fn()
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={onChanged} />)
    fireEvent.click(screen.getAllByRole('button', { name: /assign contact/i })[0])
    fireEvent.click(await screen.findByText('Attendee Alice'))
    await waitFor(() =>
      expect(mockAssign).toHaveBeenCalledWith({ recordingId: 'rec-1', fileLabel: 'A', contactId: 'c-att' })
    )
    expect(onChanged).toHaveBeenCalled()
  })

  it('inline quick-add: unmatched name creates a contact then assigns it (AC2)', async () => {
    mockCreate.mockResolvedValue({ success: true, data: { id: 'c-new', name: 'Carol', email: null } })
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={vi.fn()} />)
    fireEvent.click(screen.getAllByRole('button', { name: /assign contact/i })[0])
    const search = await screen.findByRole('textbox', { name: /search or add a contact/i })
    fireEvent.change(search, { target: { value: 'Carol' } })
    fireEvent.click(await screen.findByRole('button', { name: /create contact "carol"/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({ name: 'Carol' }))
    await waitFor(() =>
      expect(mockAssign).toHaveBeenCalledWith({ recordingId: 'rec-1', fileLabel: 'A', contactId: 'c-new' })
    )
  })

  it('merge C -> A persists server-side via speakers:merge + onChanged (AC3)', async () => {
    const onChanged = vi.fn()
    const turns: Turn[] = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'a' },
      { speaker: 'C', startMs: 1000, endMs: 2000, text: 'c' },
    ]
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={turns} onChanged={onChanged} />)
    // Merge C into A via the per-row merge control
    fireEvent.click(await screen.findByRole('button', { name: /merge speaker c/i }))
    fireEvent.click(await screen.findByRole('button', { name: /merge into a/i }))
    await waitFor(() =>
      expect(mockMerge).toHaveBeenCalledWith({ recordingId: 'rec-1', fromLabel: 'C', toLabel: 'A' })
    )
    expect(onChanged).toHaveBeenCalled()
  })

  it('reassign a single turn persists the updated turns array, leaving other turns unchanged (AC3)', async () => {
    const onChanged = vi.fn()
    // Two A turns + one B turn; reassign the SECOND A turn to B.
    const turns: Turn[] = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'first' },
      { speaker: 'A', startMs: 1000, endMs: 2000, text: 'second' },
      { speaker: 'B', startMs: 2000, endMs: 3000, text: 'third' },
    ]
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={turns} onChanged={onChanged} />)

    // Open the per-turn reassign control for the turn whose text is "second".
    fireEvent.click(await screen.findByRole('button', { name: /reassign turn: second/i }))
    // Pick target label B.
    fireEvent.click(await screen.findByRole('button', { name: /reassign to b/i }))

    await waitFor(() =>
      expect(mockUpdateTurns).toHaveBeenCalledWith({
        recordingId: 'rec-1',
        turns: [
          { speaker: 'A', startMs: 0, endMs: 1000, text: 'first' },
          { speaker: 'B', startMs: 1000, endMs: 2000, text: 'second' },
          { speaker: 'B', startMs: 2000, endMs: 3000, text: 'third' },
        ],
      })
    )
    expect(onChanged).toHaveBeenCalled()
  })

  it('talk-time merges overlapping intervals (no double-count) (AC3)', async () => {
    // One label A with OVERLAPPING turns: 0-3000 and 1000-4000.
    // Naive sum = 3000 + 3000 = 6000ms; merged interval 0-4000 = 4000ms -> 00:00:04.
    const turns: Turn[] = [
      { speaker: 'A', startMs: 0, endMs: 3000, text: 'a1' },
      { speaker: 'A', startMs: 1000, endMs: 4000, text: 'a2' },
      // A second label so the panel isn't read-only (single-speaker) — irrelevant to A's talk-time.
      { speaker: 'B', startMs: 5000, endMs: 6000, text: 'b' },
    ]
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={turns} onChanged={vi.fn()} />)
    expect(await screen.findByRole('button', { name: /assign contact to a/i })).toBeInTheDocument()
    // 00:00:04 (merged), NOT 00:00:06 (naive sum).
    expect(screen.getByText('00:00:04')).toBeInTheDocument()
    expect(screen.queryByText('00:00:06')).not.toBeInTheDocument()
  })

  it('single-speaker recording renders read-only (no merge control)', async () => {
    const turns: Turn[] = [{ speaker: 'A', startMs: 0, endMs: 1000, text: 'solo' }]
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={turns} onChanged={vi.fn()} />)
    expect(await screen.findByText('A')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /merge speaker/i })).not.toBeInTheDocument()
  })

  it('single-speaker recording also hides per-turn reassign (read-only)', async () => {
    const turns: Turn[] = [{ speaker: 'A', startMs: 0, endMs: 1000, text: 'solo' }]
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={turns} onChanged={vi.fn()} />)
    expect(await screen.findByText('A')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reassign turn/i })).not.toBeInTheDocument()
  })
})
