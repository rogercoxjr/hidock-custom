import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SpeakerTargetPicker } from '../SpeakerTargetPicker'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

function stubApi() {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      contacts: {
        getForMeeting: vi.fn().mockResolvedValue({ success: true, data: [{ id: 'cA', name: 'Alice', email: null }] }),
        getAll: vi.fn().mockResolvedValue({ success: true, data: { contacts: [{ id: 'cZ', name: 'Zoe', email: null }], total: 1 } }),
        create: vi.fn().mockResolvedValue({ success: true, data: { id: 'c-new', name: 'Newbie' } }),
      },
    },
    writable: true,
    configurable: true,
  })
}

const SPEAKERS = [
  { label: 'A', name: 'Alice' },
  { label: 'B', name: null },
]

beforeEach(() => {
  vi.clearAllMocks()
  stubApi()
})

describe('SpeakerTargetPicker', () => {
  it('lists existing speakers excluding the source, named and unnamed', async () => {
    const onPick = vi.fn()
    render(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} canMintNew onPick={onPick} />)
    // Source A is excluded; B shows as "Speaker B". Exclusion is by LABEL, not name — assert
    // both the name path (Alice) and the label path (A) are absent.
    expect(screen.queryByRole('button', { name: /reassign to alice/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reassign to speaker a/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /reassign to speaker b/i })).toBeInTheDocument()
  })

  it('excludes the source by LABEL even when the source is unnamed (sourceLabel=B)', async () => {
    const onPick = vi.fn()
    // B is the source here and is unnamed; A (named Alice) is the only other speaker.
    render(<SpeakerTargetPicker sourceLabel="B" speakers={SPEAKERS} canMintNew onPick={onPick} />)
    expect(screen.queryByRole('button', { name: /reassign to speaker b/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /reassign to alice/i })).toBeInTheDocument()
  })

  it('picking an existing speaker emits an existingLabel target', async () => {
    const onPick = vi.fn()
    render(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} canMintNew onPick={onPick} />)
    fireEvent.click(await screen.findByRole('button', { name: /reassign to speaker b/i }))
    expect(onPick).toHaveBeenCalledWith({ kind: 'existingLabel', label: 'B' })
  })

  it('contact search filters and picking a contact emits a contact target', async () => {
    const onPick = vi.fn()
    render(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} meetingId="m1" canMintNew onPick={onPick} />)
    const search = await screen.findByLabelText(/search or add a contact/i)
    fireEvent.change(search, { target: { value: 'Zoe' } })
    fireEvent.click(await screen.findByRole('button', { name: /^zoe/i }))
    expect(onPick).toHaveBeenCalledWith({ kind: 'contact', contactId: 'cZ' })
  })

  it('quick-add creates a contact and emits a contact target with the new id', async () => {
    const onPick = vi.fn()
    render(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} canMintNew onPick={onPick} />)
    const search = await screen.findByLabelText(/search or add a contact/i)
    fireEvent.change(search, { target: { value: 'Newbie' } })
    fireEvent.click(await screen.findByRole('button', { name: /create contact "newbie"/i }))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ kind: 'contact', contactId: 'c-new' }))
  })

  it('offers New speaker when canMintNew, disables it otherwise', async () => {
    const onPick = vi.fn()
    const { rerender } = render(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} canMintNew onPick={onPick} />)
    const newBtn = await screen.findByRole('button', { name: /new speaker/i })
    expect(newBtn).not.toBeDisabled()
    fireEvent.click(newBtn)
    expect(onPick).toHaveBeenCalledWith({ kind: 'newSpeaker' })

    rerender(<SpeakerTargetPicker sourceLabel="A" speakers={SPEAKERS} canMintNew={false} onPick={onPick} />)
    expect(screen.getByRole('button', { name: /new speaker/i })).toBeDisabled()
  })
})
