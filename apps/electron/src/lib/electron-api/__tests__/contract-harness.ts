/**
 * contract-harness.ts — Layer-2 SDK↔route contract-test harness (docs/HOSTED-HUB-TEST-PLAN.md §3).
 *
 * WHY: renderer unit tests mock `window.electronAPI` entirely, so they never exercise the
 * real HTTP shape a `makeXGroup({ http })` factory sends/expects against the real Fastify
 * route + zod schema. Drift in request keys, query params, path shape, response envelope,
 * or error shape ships green. This harness closes that gap by running the REAL renderer SDK
 * group factories (from `../groups/*`, backed by the REAL `../http` transport) against the
 * REAL `buildApp()` Fastify instance, in-process, via a global `fetch` shim that forwards to
 * `app.inject()` instead of a real socket.
 *
 * USAGE (see `transcripts.contract.test.ts` for the canonical example):
 *
 *   let ctx: ContractApp
 *   beforeEach(async () => {
 *     ctx = await makeContractApp()
 *     installFetchShim(ctx.app, ctx.cookie)
 *   })
 *   afterEach(async () => {
 *     vi.unstubAllGlobals()
 *     await closeContractApp(ctx)
 *   })
 *
 *   it('...', async () => {
 *     const grp = makeTranscriptsGroup({ http })  // the REAL http.ts module
 *     const result = await grp.getByRecordingId('rec-1')
 *     expect(result.full_text).toBe(...)
 *   })
 *
 * SCOPE (see task header for the authoritative list): covers the 14 JSON-body groups —
 * transcripts, knowledge, assistant, calendar, quality, rag, storagePolicy, deviceCache,
 * contacts, projects, actionables, meetings, config, syncedFiles.
 *
 * DELIBERATELY OUT OF SCOPE (documented per-file, not silently dropped):
 *   - recordings.upload / device-sync: multipart/streaming bodies via `app.inject()` are a
 *     separate (heavier) harness effort; `postForm`/`postStream` are not exercised here.
 *   - jensen / downloadService / deviceSync (webUSB groups): no Fastify route backs these —
 *     they talk to real/mocked USB hardware, not HTTP.
 *   - Any method that must reach a live external HTTP dependency (Gemini/OpenAI/Ollama chat,
 *     ICS calendar fetch) is skipped with an inline comment in its group's test file: the
 *     global `fetch` stub below is process-wide, so server-side code that itself calls
 *     `fetch()` (calendar-sync's ICS fetch, chat providers) would be silently redirected into
 *     `app.inject()` too, producing a meaningless 404 instead of a real network failure. Only
 *     methods whose server-side path provably short-circuits before touching the network
 *     (e.g. missing-API-key branches that return null before fetching) are included.
 *
 * TS PROJECT BOUNDARY NOTE: this file and `*.contract.test.ts` live under `src/` (so Vitest's
 * `**\/__tests__/**\/*.test.ts` glob picks them up) but straddle BOTH composite tsc projects —
 * they import `electron/server/**` + `electron/main/services/**` (outside tsconfig.web.json's
 * file set) AND `../groups/*` + `../http` (outside tsconfig.node.json's file set, and reliant
 * on DOM lib globals like `window` that tsconfig.node.json doesn't provide). Neither
 * composite project's `include` can cover both halves without TS6307 errors or duplicate-lib
 * conflicts, so these files are excluded from tsconfig.web.json's `include` (see that file)
 * and never added to tsconfig.node.json's either — `tsc --noEmit` never sees them; Vitest
 * (esbuild-transpiled, no project-reference enforcement) is the only thing that type-erases
 * and runs them. `npm run typecheck` (both halves) stays clean by construction.
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../../../electron/server/app'
import { createFakeOidc } from '../../../../electron/server/oidc'

export const ADMIN_EMAIL = 'admin@x.com'

export interface ContractApp {
  app: FastifyInstance
  cookie: string
  dir: string
}

/**
 * Boots the real Fastify app against a fresh temp-dir DB, bootstraps `ADMIN_EMAIL` as an
 * active admin (so `requireAuth`/`requireAdmin` pass), and logs in via the same
 * beginLogin→callback dance `electron/server/__tests__/transcripts.test.ts` uses. Returns the
 * app plus the session cookie value ready to hand to `installFetchShim`.
 */
export async function makeContractApp(): Promise<ContractApp> {
  // Mirrors electron/server/__tests__/transcripts.test.ts: `database.ts` memoizes its sqlite
  // connection at module scope, so a fresh temp dir per test requires a fresh module instance
  // too — otherwise every test after the first reuses the first test's (now-deleted) DB file
  // and `insertRecording` collides on already-seeded rows (UNIQUE constraint failures).
  vi.resetModules()

  const dir = mkdtempSync(join(tmpdir(), 'hidock-contract-'))
  process.env.HIDOCK_DATA_ROOT = dir

  const { initializeFileStorage } = await import('../../../../electron/main/services/file-storage')
  const { initializeDatabase, ensureBootstrapAdmin } = await import('../../../../electron/main/services/database')
  await initializeFileStorage()
  await initializeDatabase()
  ensureBootstrapAdmin(ADMIN_EMAIL)

  const app = await buildApp({
    oidc: createFakeOidc({ email: ADMIN_EMAIL, emailVerified: true, sub: 'sub-admin' }),
    sessionSecret: 'a-very-long-secret-value-for-contract-tests',
    adminEmail: ADMIN_EMAIL,
    publicUrl: 'https://hub.example.com',
    cookieSecure: false // inject() has no TLS — a Secure cookie would not round-trip
  })

  const cookie = await login(app)
  return { app, cookie, dir }
}

async function login(app: FastifyInstance): Promise<string> {
  const start = await app.inject({ method: 'GET', url: '/auth/login' })
  const startCookie = start.cookies.find((c) => c.name === 'hidock_session')!
  const cb = await app.inject({
    method: 'GET',
    url: '/auth/callback?code=x&state=ignored-by-fake',
    cookies: { hidock_session: startCookie.value }
  })
  const cbCookie = cb.cookies.find((c) => c.name === 'hidock_session')
  return (cbCookie ?? startCookie).value
}

/** Tears down the app + temp DB dir created by `makeContractApp`. Call from `afterEach`. */
export async function closeContractApp(ctx: ContractApp): Promise<void> {
  const { closeDatabase } = await import('../../../../electron/main/services/database')
  try {
    closeDatabase()
  } catch {
    /* ignore */
  }
  await ctx.app.close()
  rmSync(ctx.dir, { recursive: true, force: true })
  delete process.env.HIDOCK_DATA_ROOT
}

/**
 * installFetchShim — `vi.stubGlobal('fetch', …)` so every call the SDK's `http.ts` transport
 * makes (get/post/patch/put/del — postForm/postStream are out of scope, see header) resolves
 * via `app.inject()` in-process instead of a real socket.
 *
 * Mirrors exactly the subset of the Fetch `Response` surface `http.ts` reads: `.status`,
 * `.ok`, `.json()` (awaited inside a try/catch there, so a non-JSON/empty body must reject
 * the same way a real empty-body `response.json()` would — `light-my-request`'s `res.json()`
 * throws synchronously on invalid JSON, which becomes a rejected promise inside our `async
 * json()` wrapper, matching real `fetch` behaviour).
 */
export function installFetchShim(app: FastifyInstance, cookie: string): void {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input)
    const path = stripOrigin(url)
    const method = (init?.method ?? 'GET').toUpperCase()

    // http.ts always builds `init.headers` as a plain Record<string,string> (never a Headers
    // instance / array form), so a direct merge is safe here.
    const extraHeaders = (init?.headers ?? {}) as Record<string, string>

    // http.ts JSON-encodes write bodies to a string before calling fetch; postForm/postStream
    // (FormData / binary bodies) are explicitly out of scope for this JSON-group harness.
    const payload = typeof init?.body === 'string' ? init.body : undefined

    const res = await app.inject({
      method: method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: path,
      headers: extraHeaders,
      cookies: { hidock_session: cookie },
      payload
    })

    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      async json() {
        return res.json()
      },
      async text() {
        return res.body
      }
    } as Response
  })
}

function stripOrigin(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    return url
  }
}
