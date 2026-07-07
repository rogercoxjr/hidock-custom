/**
 * calendar.contract.test.ts — Layer-2 SDK↔route contract tests for the calendar group.
 * See `contract-harness.ts` for the harness design.
 *
 * SKIPPED: sync() / clearAndSync() — `syncCalendar()` (electron/main/services/calendar-sync.ts)
 * calls the process-global `fetch(icsUrl)` directly to download the ICS file. Because
 * `installFetchShim` replaces global `fetch` process-wide (it has to — that's the only hook
 * point `http.ts` gives us), that internal fetch would be silently redirected into
 * `app.inject()` against our own Fastify routes instead of hitting a real (or even a fake)
 * ICS endpoint, producing a meaningless 404 → 422 instead of exercising the real contract.
 * Testing these two methods needs a harness that can distinguish "fetch calls our own API"
 * from "fetch calls an external URL", which is out of scope here (see header of
 * contract-harness.ts). All other calendar methods are pure DB reads/writes and are covered.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeCalendarGroup } from '../groups/calendar'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('calendar contract', () => {
  let ctx: ContractApp
  const grp = makeCalendarGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getSettings returns the bare calendar settings object', async () => {
    const result = await grp.getSettings()
    expect(typeof result).toBe('object')
    expect(result).toHaveProperty('syncEnabled')
  })

  // Fixed contract bug: calendar.getLastSync()'s signature promises `Promise<string | null>`
  // (a bare value). `GET /api/calendar/last-sync` returns `{ lastSyncAt: string | null }`,
  // and the group now unwraps `.lastSyncAt` before returning it to callers.
  it('getLastSync returns the documented bare string|null, not a {lastSyncAt} envelope', async () => {
    const result = await grp.getLastSync()
    expect(result).toBeNull()
  })

  // Fixed contract bug: setUrl() now PATCHes `{ icsUrl }`, matching
  // electron/server/routes/calendar.ts's `patchSettingsBody` zod schema (`icsUrl` /
  // `syncEnabled` / `syncIntervalMinutes`). Previously it sent `{ url }`, which zod silently
  // stripped, leaving no recognized field set and the `.refine()` (at least one field
  // required) rejecting the body with 400 on every call.
  it('setUrl sends the correct body key ("icsUrl") and updates the settings', async () => {
    const result = await grp.setUrl('https://example.com/calendar.ics')
    expect(result.icsUrl).toBe('https://example.com/calendar.ics')
  })

  it('toggleAutoSync updates syncEnabled and returns the updated settings', async () => {
    const result = await grp.toggleAutoSync(false)
    expect(result.syncEnabled).toBe(false)
  })

  // Fixed contract bug: setInterval() now PATCHes `{ syncIntervalMinutes }`, matching the
  // route schema's field name. Previously it sent `{ interval: minutes }`, which zod
  // silently stripped, leaving no recognized field set and the request 400ing every time.
  it('setInterval sends the correct body key ("syncIntervalMinutes") and updates the settings', async () => {
    const result = await grp.setInterval(45)
    expect(result.syncIntervalMinutes).toBe(45)
  })
})
