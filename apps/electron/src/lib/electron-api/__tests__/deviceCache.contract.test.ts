/**
 * deviceCache.contract.test.ts — Layer-2 SDK↔route contract tests for the deviceCache group.
 * See `contract-harness.ts` for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeDeviceCacheGroup } from '../groups/deviceCache'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('deviceCache contract', () => {
  let ctx: ContractApp
  const grp = makeDeviceCacheGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getAll returns a bare array, [] before anything is cached', async () => {
    const result = await grp.getAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
  })

  it('saveAll then getAll round-trips the cached file list', async () => {
    await grp.saveAll([
      { filename: 'a.wav', size: 100, duration: 5, dateCreated: '2024-01-01T00:00:00Z' }
    ])
    const result = await grp.getAll()
    expect(result).toHaveLength(1)
    expect(result[0].filename).toBe('a.wav')
  })

  it('clear empties the cache', async () => {
    await grp.saveAll([
      { filename: 'a.wav', size: 100, duration: 5, dateCreated: '2024-01-01T00:00:00Z' }
    ])
    await grp.clear()
    const result = await grp.getAll()
    expect(result).toEqual([])
  })
})
