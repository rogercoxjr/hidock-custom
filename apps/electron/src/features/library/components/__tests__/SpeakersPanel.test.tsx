import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SpeakersPanel } from '../SpeakersPanel'
import type { Turn } from '../../types/turns'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

const mockAssign = vi.fn().mockResolvedValue({ success: true })
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
      speakers: { assign: mockAssign },
    },
    writable: true,
    configurable: true,
  })
})

describe('SpeakersPanel (AC2/AC3)', () => {
  it('renders one row per distinct file_label with turn-count and talk-time', async () => {
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={vi.fn()} />)
    // labels A and B
    expect(await screen.findByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
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

  it('merge C -> A rewrites turns and calls onMergeTurns + onChanged (AC3)', async () => {
    const onMergeTurns = vi.fn()
    const onChanged = vi.fn()
    const turns: Turn[] = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'a' },
      { speaker: 'C', startMs: 1000, endMs: 2000, text: 'c' },
    ]
    render(
      <SpeakersPanel
        recordingId="rec-1"
        meetingId="meet-1"
        turns={turns}
        onChanged={onChanged}
        onMergeTurns={onMergeTurns}
      />
    )
    // Merge C into A via the per-row merge control
    fireEvent.click(await screen.findByRole('button', { name: /merge speaker c/i }))
    fireEvent.click(await screen.findByRole('button', { name: /merge into a/i }))
    await waitFor(() => expect(onMergeTurns).toHaveBeenCalledWith('C', 'A'))
    expect(onChanged).toHaveBeenCalled()
  })

  it('single-speaker recording renders read-only (no merge control)', async () => {
    const turns: Turn[] = [{ speaker: 'A', startMs: 0, endMs: 1000, text: 'solo' }]
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={turns} onChanged={vi.fn()} />)
    expect(await screen.findByText('A')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /merge speaker/i })).not.toBeInTheDocument()
  })
})
