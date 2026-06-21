import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { SpeakersPanel } from '../SpeakersPanel'
import type { SuggestionView } from '../SpeakersPanel'
import { useConfigStore } from '@/store/domain/useConfigStore'
import type { Turn } from '../../types/turns'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

const mockAssign = vi.fn().mockResolvedValue({ success: true })
const mockUnassign = vi.fn().mockResolvedValue({ success: true })
const mockMerge = vi.fn().mockResolvedValue({ success: true })
const mockDismissSuggestion = vi.fn().mockResolvedValue({ success: true })
const mockAcceptSuggestion = vi.fn().mockResolvedValue({ success: true })
const mockSetSelf = vi.fn().mockResolvedValue({ success: true, data: { selfAssigned: true, contactId: 'c-self' } })
const mockUpdateTurns = vi.fn().mockResolvedValue({ success: true })
const mockCreate = vi.fn()
const mockGetForMeeting = vi.fn()
const mockGetAll = vi.fn()
const mockFindBySource = vi.fn().mockResolvedValue({ success: true, data: [] })
const mockDelete = vi.fn().mockResolvedValue({ success: true })
let voiceprintCaptureCallback: ((data: unknown) => void) | null = null
const mockOnVoiceprintCaptured = vi.fn((cb: (data: unknown) => void) => {
  voiceprintCaptureCallback = cb
  return vi.fn()
})

function makeTurns(): Turn[] {
  return [
    { speaker: 'A', startMs: 0, endMs: 5000, text: 'Hello there.' },
    { speaker: 'B', startMs: 5000, endMs: 8000, text: 'Hi.' },
    { speaker: 'A', startMs: 8000, endMs: 12000, text: 'How are you?' },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  voiceprintCaptureCallback = null
  useConfigStore.setState({ config: null })
  mockGetForMeeting.mockResolvedValue({ success: true, data: [{ id: 'c-att', name: 'Attendee Alice', email: 'alice@x.com' }] })
  mockGetAll.mockResolvedValue({ success: true, data: { contacts: [{ id: 'c-bob', name: 'Bob', email: 'bob@x.com' }], total: 1 } })
  Object.defineProperty(window, 'electronAPI', {
    value: {
      contacts: { getForMeeting: mockGetForMeeting, getAll: mockGetAll, create: mockCreate },
      speakers: {
        assign: mockAssign,
        unassign: mockUnassign,
        merge: mockMerge,
        getSuggestions: vi.fn(),
        dismissSuggestion: mockDismissSuggestion,
        acceptSuggestion: mockAcceptSuggestion,
        setSelf: mockSetSelf,
      },
      transcripts: { updateTurns: mockUpdateTurns },
      voiceprints: { findBySource: mockFindBySource, delete: mockDelete },
      onVoiceprintCaptured: mockOnVoiceprintCaptured,
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
      expect(mockAssign).toHaveBeenCalledWith({ recordingId: 'rec-1', fileLabel: 'A', contactId: 'c-att', source: 'user' })
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
      expect(mockAssign).toHaveBeenCalledWith({ recordingId: 'rec-1', fileLabel: 'A', contactId: 'c-new', source: 'user' })
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

    // The per-turn list is collapsed by default — expand it first.
    fireEvent.click(await screen.findByRole('button', { name: /turns \(3\)/i }))
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

  it('collapses the per-turn list by default and expands on toggle (AC3 collapse)', async () => {
    const turns: Turn[] = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'first' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'second' },
    ]
    render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={turns} onChanged={vi.fn()} />)

    const toggle = await screen.findByRole('button', { name: /turns \(2\)/i })
    // Collapsed by default: reassign controls are not rendered.
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /reassign turn: first/i })).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('button', { name: /reassign turn: first/i })).toBeInTheDocument()
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

  describe('jump to first turn (speaker-name click)', () => {
    it('clicking the speaker name calls onJumpToTime with that label\'s minimum startMs', async () => {
      const onJumpToTime = vi.fn()
      // Out-of-order turns: A's EARLIEST start (1000) appears AFTER a later A turn
      // (3000) in array order, and B's earliest (500) is not first in the array.
      // firstMs must be the minimum start per label, not the first-seen.
      const turns: Turn[] = [
        { speaker: 'A', startMs: 3000, endMs: 4000, text: 'a-late' },
        { speaker: 'B', startMs: 500, endMs: 1500, text: 'b-early' },
        { speaker: 'A', startMs: 1000, endMs: 2000, text: 'a-early' },
      ]
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={turns}
          onJumpToTime={onJumpToTime}
          onChanged={vi.fn()}
        />
      )
      // Speaker A name button -> A's minimum startMs (1000).
      fireEvent.click(await screen.findByRole('button', { name: /play from where a first speaks/i }))
      expect(onJumpToTime).toHaveBeenCalledTimes(1)
      expect(onJumpToTime).toHaveBeenCalledWith(1000)

      // Speaker B name button -> B's minimum startMs (500).
      fireEvent.click(screen.getByRole('button', { name: /play from where b first speaks/i }))
      expect(onJumpToTime).toHaveBeenCalledTimes(2)
      expect(onJumpToTime).toHaveBeenLastCalledWith(500)
    })

    it('the Assign button does NOT trigger onJumpToTime', async () => {
      const onJumpToTime = vi.fn()
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={makeTurns()}
          onJumpToTime={onJumpToTime}
          onChanged={vi.fn()}
        />
      )
      fireEvent.click(await screen.findByRole('button', { name: /assign contact to a/i }))
      expect(onJumpToTime).not.toHaveBeenCalled()
    })

    it('renders the speaker label as plain text (no jump button) when onJumpToTime is absent', async () => {
      render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={vi.fn()} />)
      expect(await screen.findByRole('button', { name: /assign contact to a/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /play from where .* first speaks/i })).not.toBeInTheDocument()
    })
  })

  describe('Phase 2A capture + un-bank', () => {
    it('renders assigned speaker contact names and exposes inline un-bank (AC2)', async () => {
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={makeTurns()}
          assignedSpeakers={{ A: { contactId: 'c-alice', contactName: 'Alice' } }}
          onChanged={vi.fn()}
        />
      )
      expect(await screen.findByText(/→ Alice/i)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /assign contact to a/i }))
      expect(
        await screen.findByRole('button', { name: /clear assignment for alice/i })
      ).toBeInTheDocument()
    })

    it('shows capture feedback: success with clean speech, or human skip reason (AC2)', async () => {
      render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={vi.fn()} />)
      expect(await screen.findByRole('button', { name: /assign contact to a/i })).toBeInTheDocument()
      expect(voiceprintCaptureCallback).not.toBeNull()

      act(() =>
        voiceprintCaptureCallback!({
          recordingId: 'rec-1',
          fileLabel: 'A',
          captured: true,
          cleanSpeechMs: 12000,
        })
      )
      expect(await screen.findByText(/voice remembered/i)).toBeInTheDocument()
      expect(screen.getByText(/00:00:12 clean speech/)).toBeInTheDocument()

      act(() =>
        voiceprintCaptureCallback!({
          recordingId: 'rec-1',
          fileLabel: 'B',
          captured: false,
          reason: 'insufficient-clean-speech',
        })
      )
      expect(
        await screen.findByText(/not enough clean speech to remember the voice/i)
      ).toBeInTheDocument()
    })

    it('suppresses voice capture affordance and shows privacy hint when disabled (AC2)', async () => {
      useConfigStore.setState({ config: { privacy: { enableVoiceprintCapture: false, excludeVoiceprintsFromBackup: false } } as unknown as import('@/types').AppConfig })
      render(<SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={vi.fn()} />)
      expect(await screen.findByText(/voice memory is off/i)).toBeInTheDocument()
      expect(mockOnVoiceprintCaptured).not.toHaveBeenCalled()
    })

    it('clear assignment un-banks discovered voiceprints after confirmation (AC2)', async () => {
      mockFindBySource.mockResolvedValue({
        success: true,
        data: [
          { id: 'vp-1', sourceRecordingId: 'rec-1', fileLabel: 'A', contactId: 'c-alice' },
          { id: 'vp-2', sourceRecordingId: 'rec-1', fileLabel: 'A', contactId: 'c-alice' },
        ],
      })
      const onChanged = vi.fn()
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={makeTurns()}
          assignedSpeakers={{ A: { contactId: 'c-alice', contactName: 'Alice' } }}
          onChanged={onChanged}
        />
      )
      fireEvent.click(await screen.findByRole('button', { name: /assign contact to a/i }))
      fireEvent.click(await screen.findByRole('button', { name: /clear assignment for alice/i }))

      await waitFor(() =>
        expect(mockUnassign).toHaveBeenCalledWith({ recordingId: 'rec-1', fileLabel: 'A' })
      )
      await waitFor(() =>
        expect(mockFindBySource).toHaveBeenCalledWith('rec-1', 'A', 'c-alice')
      )
      expect(await screen.findByText(/remove banked voiceprints\?/i)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /remove 2 voiceprints/i }))
      await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(2))
      expect(mockDelete).toHaveBeenCalledWith('vp-1')
      expect(mockDelete).toHaveBeenCalledWith('vp-2')
    })

    it('clear assignment with no matching voiceprints skips the remove dialog (AC2)', async () => {
      mockFindBySource.mockResolvedValue({ success: true, data: [] })
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={makeTurns()}
          assignedSpeakers={{ A: { contactId: 'c-alice', contactName: 'Alice' } }}
          onChanged={vi.fn()}
        />
      )
      fireEvent.click(await screen.findByRole('button', { name: /assign contact to a/i }))
      fireEvent.click(await screen.findByRole('button', { name: /clear assignment for alice/i }))

      await waitFor(() =>
        expect(mockUnassign).toHaveBeenCalledWith({ recordingId: 'rec-1', fileLabel: 'A' })
      )
      await waitFor(() =>
        expect(mockFindBySource).toHaveBeenCalledWith('rec-1', 'A', 'c-alice')
      )
      expect(screen.queryByText(/remove banked voiceprints\?/i)).not.toBeInTheDocument()
      expect(mockDelete).not.toHaveBeenCalled()
    })
  })

  describe('Phase 2B suggestion chips', () => {
    function makeSuggestion(kind: SuggestionView['kind'], overrides: Partial<SuggestionView> = {}): SuggestionView {
      const base: SuggestionView = {
        id: 'sug-1',
        kind,
        targetLabel: 'A',
        targetLabel2: null,
        contactId: null,
        contactName: null,
        contactName2: null,
        score: 0.65,
        rank: 1,
        rationale: 'likely',
        requiresWarning: false,
      }
      return { ...base, ...overrides }
    }

    it('renders identity suggestion chip with confirm/dismiss', async () => {
      const onChanged = vi.fn()
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={makeTurns()}
          suggestions={[makeSuggestion('identity', { contactId: 'c-robyn', contactName: 'Robyn', rationale: 'strong' })]}
          onChanged={onChanged}
        />
      )
      // The match-strength label is rendered in its own (colored) span, so assert
      // the name and the "(Match)" qualifier independently rather than as one node.
      expect(await screen.findByText(/Looks like Robyn/i)).toBeInTheDocument()
      expect(screen.getByText(/\(Match\)/i)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
      await waitFor(() =>
        expect(mockAssign).toHaveBeenCalledWith({
          recordingId: 'rec-1',
          fileLabel: 'A',
          contactId: 'c-robyn',
          source: 'suggestion_confirmed',
        })
      )
      await waitFor(() => expect(mockAcceptSuggestion).toHaveBeenCalledWith('sug-1'))
      expect(onChanged).toHaveBeenCalled()
    })

    it('dismisses an identity suggestion', async () => {
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={makeTurns()}
          suggestions={[makeSuggestion('identity', { contactId: 'c-robyn', contactName: 'Robyn' })]}
          onChanged={vi.fn()}
        />
      )
      fireEvent.click(await screen.findByRole('button', { name: /^Dismiss$/i }))
      await waitFor(() => expect(mockDismissSuggestion).toHaveBeenCalledWith('sug-1'))
    })

    it('confirms a merge suggestion and warns when required', async () => {
      const onChanged = vi.fn()
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={makeTurns()}
          suggestions={[
            makeSuggestion('merge', {
              id: 'sug-merge',
              targetLabel2: 'B',
              contactName: 'Robyn',
              contactName2: 'Tiffany',
              requiresWarning: true,
            }),
          ]}
          onChanged={onChanged}
        />
      )
      fireEvent.click(await screen.findByRole('button', { name: /confirm merge/i }))
      expect(await screen.findByText(/Merge speakers across contacts\?/i)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /confirm merge$/i }))
      await waitFor(() =>
        expect(mockMerge).toHaveBeenCalledWith({ recordingId: 'rec-1', fromLabel: 'A', toLabel: 'B' })
      )
      await waitFor(() => expect(mockAcceptSuggestion).toHaveBeenCalledWith('sug-merge'))
    })

    it('mixed suggestion has only dismiss, no confirm', async () => {
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={makeTurns()}
          suggestions={[makeSuggestion('mixed', { id: 'sug-mixed' })]}
          onChanged={vi.fn()}
        />
      )
      expect(await screen.findByText(/A may contain two voices/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /^Dismiss$/i }))
      await waitFor(() => expect(mockDismissSuggestion).toHaveBeenCalledWith('sug-mixed'))
    })

    it('self-enroll calls setSelf and refreshes', async () => {
      const onChanged = vi.fn()
      render(
        <SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={onChanged} />
      )
      fireEvent.click(await screen.findByRole('button', { name: /this label is me: a/i }))
      await waitFor(() =>
        expect(mockSetSelf).toHaveBeenCalledWith({ recordingId: 'rec-1', fileLabel: 'A' })
      )
      expect(onChanged).toHaveBeenCalled()
    })

    it('self-enroll with no self contact shows a hint instead of assigning', async () => {
      mockSetSelf.mockResolvedValue({ success: true, data: { selfAssigned: false, needsSelfContact: true } })
      render(
        <SpeakersPanel recordingId="rec-1" meetingId="meet-1" turns={makeTurns()} onChanged={vi.fn()} />
      )
      fireEvent.click(await screen.findByRole('button', { name: /this label is me: a/i }))
      expect(await screen.findByTestId('self-hint')).toBeInTheDocument()
    })

    it('dismiss all suggestions dismisses every pending suggestion', async () => {
      const onChanged = vi.fn()
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={makeTurns()}
          suggestions={[
            makeSuggestion('identity', { id: 'sug-1', contactId: 'c-1', contactName: 'One' }),
            makeSuggestion('identity', { id: 'sug-2', targetLabel: 'B', contactId: 'c-2', contactName: 'Two' }),
          ]}
          onChanged={onChanged}
        />
      )
      fireEvent.click(await screen.findByRole('button', { name: /dismiss all suggestions/i }))
      await waitFor(() => expect(mockDismissSuggestion).toHaveBeenCalledWith('sug-1'))
      await waitFor(() => expect(mockDismissSuggestion).toHaveBeenCalledWith('sug-2'))
      expect(onChanged).toHaveBeenCalled()
    })

    it('caps identity chips to two per label', async () => {
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={makeTurns()}
          suggestions={[
            makeSuggestion('identity', { id: 's1', contactId: 'c-1', contactName: 'One' }),
            makeSuggestion('identity', { id: 's2', contactId: 'c-2', contactName: 'Two' }),
            makeSuggestion('identity', { id: 's3', contactId: 'c-3', contactName: 'Three' }),
          ]}
          onChanged={vi.fn()}
        />
      )
      expect(await screen.findByText(/Looks like One/i)).toBeInTheDocument()
      expect(screen.getByText(/Looks like Two/i)).toBeInTheDocument()
      expect(screen.queryByText(/Looks like Three/i)).not.toBeInTheDocument()
    })

    it('renders suggestions even on a single-speaker recording', async () => {
      const turns: Turn[] = [{ speaker: 'A', startMs: 0, endMs: 1000, text: 'solo' }]
      render(
        <SpeakersPanel
          recordingId="rec-1"
          meetingId="meet-1"
          turns={turns}
          suggestions={[makeSuggestion('identity', { contactId: 'c-me', contactName: 'Me' })]}
          onChanged={vi.fn()}
        />
      )
      expect(await screen.findByText(/Looks like Me/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /merge speaker/i })).not.toBeInTheDocument()
    })
  })
})
