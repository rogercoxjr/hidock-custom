/**
 * storagePolicy.contract.test.ts — Layer-2 SDK↔route contract tests for the storagePolicy
 * group. See `contract-harness.ts` for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeStoragePolicyGroup } from '../groups/storagePolicy'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('storagePolicy contract', () => {
  let ctx: ContractApp
  const grp = makeStoragePolicyGroup({ http })
  const recId = 'rec-sp-1'

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    const { insertRecording } = await import('../../../../electron/main/services/database')
    insertRecording({
      id: recId,
      filename: 'sp1.hda',
      file_path: null,
      date_recorded: '2024-01-01T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'complete',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('assignTier assigns a tier by quality level, then getByTier finds it', async () => {
    const assigned = await grp.assignTier(recId, 'high') // high -> 'hot' tier
    expect(assigned.ok).toBe(true)

    const hot = await grp.getByTier('hot')
    expect(Array.isArray(hot)).toBe(true)
    expect(hot.some((r: { id: string }) => r.id === recId)).toBe(true)
  })

  it('getStats returns a bare array of per-tier stats', async () => {
    const result = await grp.getStats()
    expect(Array.isArray(result)).toBe(true)
  })

  it('getCleanupSuggestions returns a bare array on an empty-suggestions DB', async () => {
    const result = await grp.getCleanupSuggestions()
    expect(Array.isArray(result)).toBe(true)
  })

  it('getCleanupSuggestionsForTier returns a bare array', async () => {
    const result = await grp.getCleanupSuggestionsForTier('hot', 0)
    expect(Array.isArray(result)).toBe(true)
  })

  it('executeCleanup returns {deleted,archived,failed} arrays', async () => {
    const result = await grp.executeCleanup([recId])
    expect(Array.isArray(result.deleted)).toBe(true)
    expect(Array.isArray(result.archived)).toBe(true)
    expect(Array.isArray(result.failed)).toBe(true)
    // No quality assessment exists yet, so the service takes the "delete local file" path.
    expect(result.deleted).toContain(recId)
  })

  it('initializeUntiered returns {initialized: count}', async () => {
    const result = await grp.initializeUntiered()
    expect(typeof result.initialized).toBe('number')
  })
})
