import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QuickAddContact } from '../QuickAddContact'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

const mockCreate = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'electronAPI', {
    value: { contacts: { create: mockCreate } },
    writable: true,
    configurable: true,
  })
})

describe('QuickAddContact (AC2 reusable quick-add)', () => {
  it('creates a contact via contacts:create and fires onCreated', async () => {
    mockCreate.mockResolvedValue({ success: true, data: { id: 'c-new', name: 'Dana', email: null } })
    const onCreated = vi.fn()
    render(<QuickAddContact open onClose={vi.fn()} onCreated={onCreated} />)

    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'Dana' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Dana' })))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-new' })))
  })

  it('blocks an empty name (no IPC call)', async () => {
    render(<QuickAddContact open onClose={vi.fn()} onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    await new Promise((r) => setTimeout(r, 0))
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
