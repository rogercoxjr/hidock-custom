/**
 * syncedFiles.contract.test.ts — Layer-2 SDK↔route contract tests for the syncedFiles group.
 * See `contract-harness.ts` for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeSyncedFilesGroup } from '../groups/syncedFiles'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('syncedFiles contract', () => {
  let ctx: ContractApp
  const grp = makeSyncedFilesGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('add returns the new row id as a string', async () => {
    const id = await grp.add('orig.wav', 'local.wav', '/data/local.wav', 100)
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('getAll returns a bare array of synced files', async () => {
    await grp.add('orig.wav', 'local.wav', '/data/local.wav', 100)
    const result = await grp.getAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result.some((f) => f.original_filename === 'orig.wav')).toBe(true)
  })

  it('getFilenames returns a bare string[] of original filenames', async () => {
    await grp.add('orig.wav', 'local.wav', '/data/local.wav', 100)
    const result = await grp.getFilenames()
    expect(Array.isArray(result)).toBe(true)
    expect(result).toContain('orig.wav')
  })

  it('getSyncedFile returns the bare row for an existing filename', async () => {
    await grp.add('orig.wav', 'local.wav', '/data/local.wav', 100)
    const result = await grp.getSyncedFile('orig.wav')
    expect(result?.original_filename).toBe('orig.wav')
  })

  it('isFileSynced returns true after add, false after remove', async () => {
    await grp.add('orig.wav', 'local.wav', '/data/local.wav', 100)
    expect(await grp.isFileSynced('orig.wav')).toBe(true)

    const removed = await grp.remove('orig.wav')
    expect(removed).toBe(true)
    expect(await grp.isFileSynced('orig.wav')).toBe(false)
  })
})
