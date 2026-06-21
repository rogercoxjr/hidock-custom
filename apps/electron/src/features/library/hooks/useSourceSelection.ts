/**
 * useSourceSelection Hook
 *
 * Provides selection state and logic for bulk operations in the Library.
 *
 * Multi-select is driven by Finder-style modifier-clicks (wired in Library.tsx),
 * not checkboxes. This hook exposes the raw store actions plus a shared
 * `lastSelectedRef` range anchor so the unified click router can implement
 * shift-click range selection and cmd/ctrl-click toggle.
 */

import { useCallback, useRef } from 'react'
import { useLibraryStore } from '@/store/useLibraryStore'

interface UseSourceSelectionResult {
  // State
  selectedIds: Set<string>
  selectedCount: number

  // Actions
  toggleSelection: (id: string) => void
  selectAll: (ids: string[]) => void
  selectRange: (ids: string[], startId: string, endId: string) => void
  clearSelection: () => void

  /**
   * Shared range anchor for modifier-click selection. The plain/cmd-click paths
   * set this to the clicked id; the shift-click path reads it as the range start.
   */
  lastSelectedRef: React.MutableRefObject<string | null>
}

/**
 * Custom hook for managing source selection with range selection support
 */
export function useSourceSelection(): UseSourceSelectionResult {
  // Track the last selected item for range selection (shared anchor)
  const lastSelectedRef = useRef<string | null>(null)

  // Get state and actions from store
  const selectedIds = useLibraryStore((state) => state.selectedIds)
  const toggleSelection = useLibraryStore((state) => state.toggleSelection)
  const selectAll = useLibraryStore((state) => state.selectAll)
  const selectRange = useLibraryStore((state) => state.selectRange)
  const clearSelection = useLibraryStore((state) => state.clearSelection)

  // Wrapper for clearSelection that also resets the range anchor
  const handleClearSelection = useCallback(() => {
    clearSelection()
    lastSelectedRef.current = null
  }, [clearSelection])

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    toggleSelection,
    selectAll,
    selectRange,
    clearSelection: handleClearSelection,
    lastSelectedRef
  }
}
