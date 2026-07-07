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

  // KNOWN CONTRACT BUG (found by this harness): calendar.getLastSync()'s signature promises
  // `Promise<string | null>` (a bare value), but `GET /api/calendar/last-sync` returns
  // `{ lastSyncAt: string | null }`. The group returns `r.data` unmodified — callers get the
  // wrapper object, not the string/null they were promised.
  it('getLastSync returns a {lastSyncAt} envelope, not the documented bare string|null', async () => {
    const result = await grp.getLastSync()
    expect(result).not.toBeNull()
    expect((result as unknown as { lastSyncAt: string | null }).lastSyncAt).toBeNull()
  })

  // KNOWN CONTRACT BUG (found by this harness): setUrl() PATCHes `{ url }`, but
  // electron/server/routes/calendar.ts's `patchSettingsBody` zod schema only recognizes
  // `icsUrl` / `syncEnabled` / `syncIntervalMinutes`. `url` is silently stripped by zod, none
  // of the three recognized fields end up set, and the schema's `.refine()` (at least one
  // field required) rejects the body with 400 — so this method ALWAYS throws, unconditionally,
  // for every caller. Compare with the correctly-wired `toggleAutoSync()` below, which sends
  // the right key (`syncEnabled`) and works.
  it('setUrl sends the wrong body key ("url" instead of "icsUrl") and always 400s', async () => {
    await expect(grp.setUrl('https://example.com/calendar.ics')).rejects.toThrow()
  })

  it('toggleAutoSync updates syncEnabled and returns the updated settings', async () => {
    const result = await grp.toggleAutoSync(false)
    expect(result.syncEnabled).toBe(false)
  })

  // KNOWN CONTRACT BUG (found by this harness): same class of bug as `setUrl()` — setInterval()
  // PATCHes `{ interval: minutes }`, but the route schema's field is `syncIntervalMinutes`.
  // `interval` is stripped, no recognized field is set, and the request 400s every time.
  it('setInterval sends the wrong body key ("interval" instead of "syncIntervalMinutes") and always 400s', async () => {
    await expect(grp.setInterval(45)).rejects.toThrow()
  })
})
