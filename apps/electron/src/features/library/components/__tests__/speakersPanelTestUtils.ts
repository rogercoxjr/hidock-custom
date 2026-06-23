import { vi } from 'vitest'
import { useConfigStore } from '@/store/domain/useConfigStore'
import type { Turn } from '../../types/turns'

export function makeTurns(): Turn[] {
  return [
    { speaker: 'A', startMs: 0, endMs: 5000, text: 'Hello there.' },
    { speaker: 'B', startMs: 5000, endMs: 8000, text: 'Hi.' },
  ]
}

// Stubs window.electronAPI + resets useConfigStore. Call in beforeEach AFTER
// vi.clearAllMocks(). Setting enableVoiceprintCapture:false so the
// "Voice memory is off …" notice renders as part of the panel body.
export function setupSpeakersPanelMocks(): void {
  useConfigStore.setState({
    config: { privacy: { enableVoiceprintCapture: false, excludeVoiceprintsFromBackup: false } } as unknown as import('@/types').AppConfig,
  })
  Object.defineProperty(window, 'electronAPI', {
    value: {
      contacts: {
        getForMeeting: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getAll: vi.fn().mockResolvedValue({ success: true, data: { contacts: [], total: 0 } }),
        create: vi.fn(),
      },
      speakers: {
        assign: vi.fn(), unassign: vi.fn(), merge: vi.fn(),
        getSuggestions: vi.fn(), dismissSuggestion: vi.fn(), acceptSuggestion: vi.fn(), setSelf: vi.fn(),
      },
      transcripts: { updateTurns: vi.fn() },
      voiceprints: { findBySource: vi.fn(), delete: vi.fn() },
      onVoiceprintCaptured: vi.fn(() => vi.fn()),
    },
    writable: true,
    configurable: true,
  })
}
