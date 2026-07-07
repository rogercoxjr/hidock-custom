/**
 * config.contract.test.ts — Layer-2 SDK↔route contract tests for the config group.
 * See `contract-harness.ts` for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeConfigGroup } from '../groups/config'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('config contract', () => {
  let ctx: ContractApp
  const grp = makeConfigGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('get returns a RESULT envelope wrapping the full AppConfig', async () => {
    const result = await grp.get()
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('calendar')
  })

  it('set merges a partial config and returns a RESULT envelope with the updated config', async () => {
    const result = await grp.set({ calendar: { syncIntervalMinutes: 15 } })
    expect(result.success).toBe(true)
    expect(result.data.calendar.syncIntervalMinutes).toBe(15)
  })

  it('updateSection patches a single top-level section', async () => {
    const result = await grp.updateSection('calendar', { syncIntervalMinutes: 30 })
    expect(result.success).toBe(true)
    expect(result.data.calendar.syncIntervalMinutes).toBe(30)
  })

  // Fixed contract bug: config.getValue()'s own doc comment classifies it as "RAW-THROW;
  // bare value" (groups/config.ts header), so `getValue('calendar')` should resolve directly
  // to the calendar config object. The route (electron/server/routes/config.ts
  // `GET /api/config?key=`) returns `{ key, value }`; the group now unwraps `.value` before
  // returning it to callers.
  it('getValue returns the documented bare value, not a {key,value} envelope', async () => {
    const result = await grp.getValue('calendar')
    expect(result).not.toHaveProperty('value')
    expect(result).toHaveProperty('syncIntervalMinutes')
  })
})
