/**
 * @vitest-environment jsdom
 *
 * SummarizationTemplatesCard — Settings CRUD card tests.
 *
 * Covers:
 *   - Render: list rows loaded via IPC list(); built-in Default shows "Built-in" badge,
 *     no delete/disable controls; user templates show all controls.
 *   - Create flow: "Add template" → modal → name+instructions → calls create() + refetches.
 *   - Edit flow: "Edit" → modal pre-filled → save calls update() + refetches.
 *   - Enable/disable toggle: calls setEnabled() + refetches.
 *   - Set default: calls update(id, { isDefault: true }) + refetches.
 *   - Delete with confirm: AlertDialog → "Delete" → calls delete() + refetches.
 *   - Built-in Default is protected: no delete button, no enable/disable toggle.
 *   - Error envelope: { success: false, error: {...} } surfaces an error toast.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SummarizationTemplatesCard } from '../SummarizationTemplatesCard'

// ---- hoisted mock state --------------------------------------------------
const h = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setEnabled: vi.fn(),
  delete: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/components/ui/toaster', () => ({ toast: h.toast }))

// Default template seed
const BUILTIN_DEFAULT = {
  id: 'default',
  name: 'Default',
  description: 'Standard meeting summary',
  instructions: 'Summarize the meeting.',
  exampleTriggers: [],
  isDefault: true,
  isBuiltin: true,
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const USER_TEMPLATE = {
  id: 'user-1',
  name: 'Sales Brief',
  description: 'Short sales summary',
  instructions: 'Focus on action items.',
  exampleTriggers: ['sales', 'demo'],
  isDefault: false,
  isBuiltin: false,
  enabled: true,
  createdAt: '2026-01-02T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.list.mockResolvedValue({ success: true, data: [BUILTIN_DEFAULT, USER_TEMPLATE] })
  h.create.mockResolvedValue({ success: true, data: { ...USER_TEMPLATE, id: 'new-1', name: 'New Tpl' } })
  h.update.mockResolvedValue({ success: true, data: { ...USER_TEMPLATE, name: 'Updated' } })
  h.setEnabled.mockResolvedValue({ success: true, data: true })
  h.delete.mockResolvedValue({ success: true, data: true })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global.window as any).electronAPI = {
    summarizationTemplates: {
      list: h.list,
      create: h.create,
      update: h.update,
      setEnabled: h.setEnabled,
      delete: h.delete,
      latestRun: vi.fn().mockResolvedValue({ success: false }),
    },
  }
})

describe('SummarizationTemplatesCard', () => {
  it('loads and renders template list on mount', async () => {
    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1))
    // Template name "Default" appears (multiple elements expected — name span + badge)
    expect(screen.getAllByText('Default').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Sales Brief')).toBeInTheDocument()
  })

  it('built-in Default shows a "Built-in" badge and no delete button', async () => {
    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(screen.getByText('Built-in')).toBeInTheDocument())

    expect(screen.getByText('Built-in')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete default/i })).not.toBeInTheDocument()
  })

  it('built-in Default has no enable/disable toggle', async () => {
    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(screen.getByText('Built-in')).toBeInTheDocument())

    // Only one toggle — for the non-builtin "Sales Brief"
    const toggles = screen.queryAllByRole('switch')
    expect(toggles.length).toBe(1)
  })

  it('user template shows delete button and enable toggle', async () => {
    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(screen.getByText('Sales Brief')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /delete sales brief/i })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /enable sales brief/i })).toBeInTheDocument()
  })

  it('clicking Add template opens modal; filling name+instructions + Save calls create() + refetches', async () => {
    h.list
      .mockResolvedValueOnce({ success: true, data: [BUILTIN_DEFAULT, USER_TEMPLATE] })
      .mockResolvedValue({ success: true, data: [BUILTIN_DEFAULT, USER_TEMPLATE, { ...USER_TEMPLATE, id: 'new-1', name: 'New Tpl' }] })

    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(screen.getByText('Sales Brief')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /add template/i }))

    // Modal open: fill name
    const nameInput = await screen.findByLabelText(/template name/i)
    fireEvent.change(nameInput, { target: { value: 'New Tpl' } })

    // Fill instructions
    const instructionsInput = screen.getByLabelText(/instructions/i)
    fireEvent.change(instructionsInput, { target: { value: 'Do the thing.' } })

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Tpl', instructions: 'Do the thing.' })
    ))
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2))
  })

  it('create with empty name shows validation error and does not call create()', async () => {
    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(screen.getByText('Sales Brief')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /add template/i }))
    // Save without filling required name — instructions also empty
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    expect(h.create).not.toHaveBeenCalled()
    expect(h.toast.error).toHaveBeenCalled()
  })

  it('clicking Edit on user template opens modal pre-filled; save calls update() + refetches', async () => {
    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(screen.getByText('Sales Brief')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /edit sales brief/i }))

    // Name field should be pre-filled
    const nameInput = await screen.findByLabelText(/template name/i)
    expect((nameInput as HTMLInputElement).value).toBe('Sales Brief')

    // Change name
    fireEvent.change(nameInput, { target: { value: 'Sales Brief V2' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(h.update).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ name: 'Sales Brief V2' })
    ))
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2))
  })

  it('toggling enable/disable calls setEnabled() + refetches', async () => {
    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(screen.getByText('Sales Brief')).toBeInTheDocument())

    const toggle = screen.getByRole('switch', { name: /enable sales brief/i })
    fireEvent.click(toggle)

    await waitFor(() => expect(h.setEnabled).toHaveBeenCalledWith('user-1', false))
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2))
  })

  it('Set as default calls update(id, { isDefault: true }) + refetches', async () => {
    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(screen.getByText('Sales Brief')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /set as default/i }))

    await waitFor(() => expect(h.update).toHaveBeenCalledWith('user-1', { isDefault: true }))
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2))
  })

  it('delete opens confirmation dialog; confirming calls delete() + refetches', async () => {
    h.list
      .mockResolvedValueOnce({ success: true, data: [BUILTIN_DEFAULT, USER_TEMPLATE] })
      .mockResolvedValue({ success: true, data: [BUILTIN_DEFAULT] })

    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(screen.getByText('Sales Brief')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /delete sales brief/i }))

    // Confirm in the AlertDialog
    const confirmBtn = await screen.findByRole('button', { name: /^delete$/i })
    fireEvent.click(confirmBtn)

    await waitFor(() => expect(h.delete).toHaveBeenCalledWith('user-1'))
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2))
  })

  it('delete cancel does not call delete()', async () => {
    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(screen.getByText('Sales Brief')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /delete sales brief/i }))
    fireEvent.click(await screen.findByRole('button', { name: /cancel/i }))

    expect(h.delete).not.toHaveBeenCalled()
  })

  it('surfaces an error toast when list() returns { success: false }', async () => {
    h.list.mockResolvedValue({ success: false, error: { code: 'INTERNAL_ERROR', message: 'DB failure' } })
    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled())
  })

  it('surfaces an error toast when create() returns { success: false }', async () => {
    h.create.mockResolvedValue({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Name too long' } })

    render(<SummarizationTemplatesCard />)
    await waitFor(() => expect(screen.getByText('Sales Brief')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /add template/i }))
    const nameInput = await screen.findByLabelText(/template name/i)
    fireEvent.change(nameInput, { target: { value: 'X' } })
    const instrInput = screen.getByLabelText(/instructions/i)
    fireEvent.change(instrInput, { target: { value: 'Do something' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(h.toast.error).toHaveBeenCalled())
  })
})
