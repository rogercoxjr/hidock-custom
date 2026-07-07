/**
 * knowledge.contract.test.ts — Layer-2 SDK↔route contract tests for the knowledge group.
 * See `contract-harness.ts` for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeKnowledgeGroup } from '../groups/knowledge'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('knowledge contract', () => {
  let ctx: ContractApp
  const grp = makeKnowledgeGroup({ http })
  let kcId: string

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    const { run } = await import('../../../../electron/main/services/database')
    kcId = 'kc-1'
    run(
      `INSERT INTO knowledge_captures (id, title, summary, captured_at) VALUES (?, ?, ?, ?)`,
      [kcId, 'Test Capture', 'a summary', new Date().toISOString()]
    )
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getAll unwraps {items,total} into a bare array', async () => {
    const result = await grp.getAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result.some((k) => k.id === kcId)).toBe(true)
  })

  it('getById returns the bare capture object', async () => {
    const result = await grp.getById(kcId)
    expect(result?.id).toBe(kcId)
    expect(result?.title).toBe('Test Capture')
  })

  it('getByIds returns a bare array, not {items,total}', async () => {
    const result = await grp.getByIds([kcId, 'does-not-exist'])
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(kcId)
  })

  it('update returns an INLINE {success} envelope', async () => {
    const result = await grp.update(kcId, { title: 'Renamed' })
    expect(result.success).toBe(true)
    const after = await grp.getById(kcId)
    expect(after?.title).toBe('Renamed')
  })
})
