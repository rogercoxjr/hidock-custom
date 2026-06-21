/**
 * SmartLabelsCard — Settings taxonomy manager tests.
 *
 * Covers: rename (name-only, id immutable), recolor via palette popover, add with
 * slugified id + dup rejection, built-ins hide remove, and delete reconciliation
 * (re-tag captures to 'other' via knowledge:update, remove from config, reset the
 * active Library filter when it pointed at the deleted label).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SmartLabelsCard } from '../SmartLabelsCard'
import type { LabelDefinition } from '@/types'

// ---- mocks --------------------------------------------------------------
// All mock state lives in a hoisted holder so the vi.mock factories (hoisted to
// the top of the module) can safely reference it without TDZ errors.
const h = vi.hoisted(() => ({
  updateConfig: vi.fn().mockResolvedValue(undefined),
  items: [] as LabelDefinition[],
  setCategoryFilter: vi.fn(),
  categoryFilter: null as string | null,
  toast: { success: vi.fn(), error: vi.fn() },
  getAll: vi.fn(),
  update: vi.fn().mockResolvedValue({ success: true })
}))

vi.mock('@/store/domain/useConfigStore', () => ({
  useConfigStore: vi.fn((selector?: any) => {
    const state = { config: { labels: { items: h.items } }, updateConfig: h.updateConfig }
    return typeof selector === 'function' ? selector(state) : state
  })
}))

vi.mock('@/store/useLibraryStore', () => ({
  useLibraryStore: vi.fn((selector?: any) => {
    const state = { categoryFilter: h.categoryFilter, setCategoryFilter: h.setCategoryFilter }
    return typeof selector === 'function' ? selector(state) : state
  })
}))

vi.mock('@/components/ui/toaster', () => ({ toast: h.toast }))

// Aliases so the test bodies read naturally.
const mockUpdateConfig = h.updateConfig
const mockSetCategoryFilter = h.setCategoryFilter
const mockToast = h.toast
const mockGetAll = h.getAll
const mockUpdate = h.update

beforeEach(() => {
  vi.clearAllMocks()
  h.items = [
    { id: 'meeting', name: 'Meeting', color: 'blue', builtin: true },
    { id: 'other', name: 'Other', color: 'slate', builtin: true },
    { id: 'sales-call', name: 'Sales Call', color: 'green' }
  ]
  h.categoryFilter = null
  mockUpdateConfig.mockReset().mockResolvedValue(undefined)
  mockGetAll.mockReset().mockResolvedValue([])
  mockUpdate.mockReset().mockResolvedValue({ success: true })
  // @ts-expect-error partial electronAPI for tests
  global.window.electronAPI = { knowledge: { getAll: mockGetAll, update: mockUpdate } }
})

describe('SmartLabelsCard', () => {
  it('renders a row per label with built-ins lacking a remove button', () => {
    render(<SmartLabelsCard />)
    // Built-ins: no remove button
    expect(screen.queryByRole('button', { name: 'Remove Meeting' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Other' })).not.toBeInTheDocument()
    // User label: removable
    expect(screen.getByRole('button', { name: 'Remove Sales Call' })).toBeInTheDocument()
  })

  it('rename edits the name only (id immutable) and persists via updateConfig', async () => {
    render(<SmartLabelsCard />)
    const input = screen.getByLabelText('Name for label sales-call')
    fireEvent.change(input, { target: { value: 'Sales' } })
    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled())
    const [section, value] = mockUpdateConfig.mock.calls.at(-1)!
    expect(section).toBe('labels')
    const renamed = value.items.find((l: LabelDefinition) => l.id === 'sales-call')
    expect(renamed.name).toBe('Sales')
    expect(renamed.id).toBe('sales-call') // unchanged
  })

  it('recolor via the palette popover writes the chosen token', async () => {
    render(<SmartLabelsCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Change color for Sales Call' }))
    // Pick Amber from the popover.
    fireEvent.click(await screen.findByRole('button', { name: 'Amber' }))
    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled())
    const [, value] = mockUpdateConfig.mock.calls.at(-1)!
    expect(value.items.find((l: LabelDefinition) => l.id === 'sales-call').color).toBe('amber')
  })

  it('add slugifies the name into an id and appends the label', async () => {
    render(<SmartLabelsCard />)
    fireEvent.change(screen.getByLabelText('New label name'), { target: { value: 'Quarterly Review' } })
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled())
    const [, value] = mockUpdateConfig.mock.calls.at(-1)!
    const added = value.items.find((l: LabelDefinition) => l.id === 'quarterly-review')
    expect(added).toBeTruthy()
    expect(added.name).toBe('Quarterly Review')
    expect(added.builtin).toBeUndefined()
  })

  it('add rejects a duplicate name and does not persist', async () => {
    render(<SmartLabelsCard />)
    fireEvent.change(screen.getByLabelText('New label name'), { target: { value: 'Meeting' } })
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled())
    expect(mockUpdateConfig).not.toHaveBeenCalled()
  })

  it('delete re-tags orphaned captures to "other" BEFORE removing the label from config', async () => {
    mockGetAll
      .mockResolvedValueOnce([{ id: 'kc1' }, { id: 'kc2' }]) // first page (matching the deleted id)
      .mockResolvedValue([]) // subsequent pages empty

    render(<SmartLabelsCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sales Call' }))

    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled())

    // Re-tag happened for every matching capture.
    expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({ category: 'sales-call' }))
    expect(mockUpdate).toHaveBeenCalledWith('kc1', { category: 'other' })
    expect(mockUpdate).toHaveBeenCalledWith('kc2', { category: 'other' })

    // ...and the label was removed from the persisted taxonomy.
    const [, value] = mockUpdateConfig.mock.calls.at(-1)!
    expect(value.items.some((l: LabelDefinition) => l.id === 'sales-call')).toBe(false)
  })

  it('delete resets the active Library filter when it pointed at the deleted label', async () => {
    h.categoryFilter = 'sales-call'
    render(<SmartLabelsCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sales Call' }))
    await waitFor(() => expect(mockSetCategoryFilter).toHaveBeenCalledWith(null))
  })

  it('delete does NOT reset the filter when a different label is active', async () => {
    h.categoryFilter = 'meeting'
    render(<SmartLabelsCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sales Call' }))
    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled())
    expect(mockSetCategoryFilter).not.toHaveBeenCalled()
  })
})
