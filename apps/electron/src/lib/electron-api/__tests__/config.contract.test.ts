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

  // KNOWN CONTRACT BUG (found by this harness): config.getValue()'s own doc comment
  // classifies it as "RAW-THROW; bare value" (groups/config.ts header), and callers would
  // reasonably expect `getValue('calendar')` to resolve directly to the calendar config
  // object. The actual route (electron/server/routes/config.ts `GET /api/config?key=`)
  // returns `{ key, value }` — the SDK method returns that envelope unmodified instead of
  // unwrapping `.value`. No renderer call site currently exists for `config.getValue`, so
  // this hasn't shipped a visible bug yet, but the shape is wrong relative to its own
  // documented contract.
  it('getValue returns a {key,value} envelope, not the documented bare value', async () => {
    const result = await grp.getValue('calendar')
    expect(result).toHaveProperty('value')
    expect(result).not.toHaveProperty('syncIntervalMinutes')
    expect(result.value).toHaveProperty('syncIntervalMinutes')
  })
})
