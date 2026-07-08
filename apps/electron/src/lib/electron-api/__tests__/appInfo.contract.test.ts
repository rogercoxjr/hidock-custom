/**
 * appInfo.contract.test.ts — Layer-2 SDK↔route contract tests for the appInfo group.
 * See `contract-harness.ts` for the harness design (boots the real Fastify `buildApp()`,
 * logs in as ADMIN_EMAIL, and shims global `fetch` → `app.inject()`).
 *
 * COVERED (safe happy paths — no DB seeding needed; `info` reads only package.json + process):
 *   - info() — RAW-THROW `GET /api/app/info`. Asserts (a) it does NOT throw (a RAW-THROW method
 *     rejects on any non-2xx, so a resolved call already proves no 400/404/405), and (b) the
 *     returned value is the bare/unwrapped `{version, name, isPackaged, platform}` shape — NOT a
 *     Result envelope and NOT wrapped in {items,...}.
 *   - restart() — DROPPED client-side no-op (0c §4). It has NO backing Fastify route and never
 *     touches `http`/`fetch`, so it is not a real SDK↔route contract; it is included only as a
 *     trivial "resolves to void without throwing" check so the whole group surface is exercised.
 *
 * SKIPPED: none needing live network/LLM/multipart/streaming exist in this group. `info` is a
 * pure GET that short-circuits before any outbound network call, and `restart` is a pure no-op,
 * so nothing here risks the process-wide `fetch` stub redirecting a server-side network call
 * into `app.inject()` (see contract-harness.ts header for that hazard).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeAppInfoGroup } from '../groups/appInfo'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('appInfo contract', () => {
  let ctx: ContractApp
  const grp = makeAppInfoGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('info returns the bare {version,name,isPackaged,platform} shape (RAW-THROW)', async () => {
    // (a) RAW-THROW: a resolved call proves the route returned 2xx (no 400/404/405).
    const info = await grp.info()

    // (b) Unwrapped/typed shape: a bare object, not a Result envelope and not {items,...}.
    expect(info).toBeTruthy()
    expect('success' in info).toBe(false)
    expect('items' in info).toBe(false)

    expect(typeof info.version).toBe('string')
    expect(info.version.length).toBeGreaterThan(0)
    expect(typeof info.name).toBe('string')
    expect(info.name.length).toBeGreaterThan(0)
    // Server has no Electron runtime — never packaged.
    expect(info.isPackaged).toBe(false)
    // platform is a known NodeJS `process.platform` value.
    expect(['win32', 'linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix']).toContain(info.platform)
  })

  it('restart is a client-side no-op that resolves to void without throwing', async () => {
    // DROPPED (0c §4): no backing route, never touches http — just proves the SDK surface exists
    // and resolves cleanly.
    await expect(grp.restart()).resolves.toBeUndefined()
  })
})
