/**
 * LibraryFilters — Smart Labels filter-contract tests.
 *
 * Verifies the category chips are data-driven from the taxonomy (not a hardcoded
 * const), always lead with an "All" chip, and emit the chip's *id* (not its display
 * name) to onCategoryFilterChange — the contract the Library.tsx `'all' <-> null`
 * mapping depends on.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LibraryFilters } from '../LibraryFilters'
import type { LabelDefinition } from '@/types'

const TAXONOMY: LabelDefinition[] = [
  { id: 'meeting', name: 'Meeting', color: 'blue', builtin: true },
  { id: '1:1', name: '1:1', color: 'green', builtin: true },
  { id: 'sales-call', name: 'Sales Call', color: 'green' }
]

function renderFilters(overrides: Partial<React.ComponentProps<typeof LibraryFilters>> = {}) {
  const onCategoryFilterChange = vi.fn()
  const props: React.ComponentProps<typeof LibraryFilters> = {
    stats: { total: 0, deviceOnly: 0, localOnly: 0, both: 0, onSource: 0, locallyAvailable: 0 },
    filterMode: 'semantic',
    semanticFilter: 'all',
    exclusiveFilter: 'all',
    categoryFilter: 'all',
    categories: TAXONOMY,
    qualityFilter: 'all',
    statusFilter: 'all',
    searchQuery: '',
    onFilterModeChange: vi.fn(),
    onSemanticFilterChange: vi.fn(),
    onExclusiveFilterChange: vi.fn(),
    onCategoryFilterChange,
    onQualityFilterChange: vi.fn(),
    onStatusFilterChange: vi.fn(),
    onSearchQueryChange: vi.fn(),
    ...overrides
  }
  render(<LibraryFilters {...props} />)
  return { onCategoryFilterChange }
}

describe('LibraryFilters category chips (Smart Labels)', () => {
  it('renders an All chip plus one chip per taxonomy label (display names)', () => {
    renderFilters()
    expect(screen.getByRole('button', { name: 'Filter by All' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filter by Meeting' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filter by 1:1' })).toBeInTheDocument()
    // User-added label appears by its display NAME.
    expect(screen.getByRole('button', { name: 'Filter by Sales Call' })).toBeInTheDocument()
  })

  it('emits the chip id (not the display name) on click', () => {
    const { onCategoryFilterChange } = renderFilters()
    fireEvent.click(screen.getByRole('button', { name: 'Filter by Sales Call' }))
    expect(onCategoryFilterChange).toHaveBeenCalledWith('sales-call')
  })

  it('the All chip emits "all" (which Library maps back to null)', () => {
    const { onCategoryFilterChange } = renderFilters({ categoryFilter: 'meeting' })
    fireEvent.click(screen.getByRole('button', { name: 'Filter by All' }))
    expect(onCategoryFilterChange).toHaveBeenCalledWith('all')
  })

  it('marks the active category chip via aria-pressed', () => {
    renderFilters({ categoryFilter: 'meeting' })
    expect(screen.getByRole('button', { name: 'Filter by Meeting' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Filter by 1:1' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders no category chips beyond All when the taxonomy is empty', () => {
    renderFilters({ categories: [] })
    expect(screen.getByRole('button', { name: 'Filter by All' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Filter by Meeting' })).not.toBeInTheDocument()
  })
})
