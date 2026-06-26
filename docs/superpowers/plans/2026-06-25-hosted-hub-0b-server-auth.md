# Hosted Hub — Plan 0b: Fastify Server + Google OIDC + Invite System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the hosted web server: a Fastify app on top of `bootFoundation()` with Google-OIDC login gated by an admin-managed `allowed_users` invite list, and admin-only user-management routes.

**Architecture:** A new `electron/server/` tree boots the 0a foundation (`bootFoundation()`), then runs Fastify. Auth is OIDC (Google) behind an injectable `OidcService` interface (real impl uses `openid-client`; a fake drives tests and asserts the login-context round-trip). The session cookie (`@fastify/secure-session`) holds only the authenticated `email`; an auth guard re-reads `allowed_users` on every request so revocation is instant. Admin routes manage the invite list. Domain REST routers, media, renderer, device sync, and Docker are later sub-plans.

**Tech Stack:** Node 20+, Fastify 5, `@fastify/secure-session`, `openid-client` v6, better-sqlite3 (via 0a), Zod v4 (already a dep), Vitest (`app.inject` + real DB).

## Global Constraints

- **Server lives in `apps/electron/electron/server/`** (covered by `tsconfig.node.json` `electron/**`). Production modules there import the foundation via `../main/boot-foundation` and DB via `../main/services/database`. **Test files live in `electron/server/__tests__/` — so from a test, the path to the main process is `../../main/...`** (two levels up), NOT `../main/...`.
- **Env (read by `getServerConfig()`):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL` (e.g. `https://hub.example.com`), `ADMIN_EMAIL` (default `rogercoxjr@gmail.com`), `SESSION_SECRET` (≥16 chars), `PORT` (default `8788`). Missing required (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`PUBLIC_URL`/`SESSION_SECRET`) → throw at startup.
- **`allowed_users` schema:** `email TEXT PRIMARY KEY`, `role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member'))`, `status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked'))`, `invited_by TEXT`, `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`. **Schema version 33 → 34.**
- **Session cookie:** name `hidock_session`; `httpOnly: true, sameSite: 'lax', path: '/'`; holds only `{ email }` (+ transient `{ oidc }` during the login round-trip). Key = `sha256(SESSION_SECRET)` (32 bytes). **`secure` is config-driven** via `AppDeps.cookieSecure` — `true` in production (behind TLS), **`false` in tests** (Vitest `app.inject` has no TLS, and a `Secure` cookie will not round-trip through inject).
- **Auth guard re-reads `allowed_users` each request** — never trust a role cached in the cookie; revoked/missing → 401 + clear session.
- **OIDC:** scope `openid email profile`; PKCE (state, nonce, code_verifier stashed in session between login redirect and callback). Reject if `email_verified !== true`. **The callback URL handed to `openid-client` is built from `PUBLIC_URL`, not from `req.host`/`req.protocol`** (which report the internal proxy address behind nginxproxymanager): `new URL(req.url, publicUrl).href`.
- **CSRF:** state-changing admin routes require a matching `Origin` header when one is present (`requireSameOrigin` guard rejects a present-but-foreign Origin), in addition to `SameSite=lax`.
- **Admin-route invariants:** the invite list is never hard-deleted (revoke = `status:'revoked'`, preserving an audit trail); a change that would leave **zero active admins** is rejected (409) — no admin lockout. User identifiers travel in the **request body**, never the URL path (emails contain `@`/`+`/`.`).
- **`openid-client` is ESM-only** — load it via dynamic `import('openid-client')` inside the real impl. The real `createGoogleOidc` is NOT unit-tested (needs live Google creds); its live verification is deferred to the operator. All route/gate/CSRF logic is tested with the **fake** `OidcService`, which asserts the login-context round-trip.
- **OUT OF SCOPE (later sub-plans):** domain REST routers (0c), WS broadcaster (0c), media endpoint (0d), renderer (0e), device sync (Phase 1), Docker (0f). Do not build them.
- Line length 120; TypeScript strict; Vitest; branch `feat/hosted-knowledge-hub`; run commands from `apps/electron/`.

---

### Task 1: Server dependencies + config module

**Files:**
- Modify: `apps/electron/package.json`
- Create: `apps/electron/electron/server/config.ts`
- Test: `apps/electron/electron/server/__tests__/config.test.ts`

**Interfaces:**
- Produces: `getServerConfig(): ServerConfig` where `ServerConfig = { googleClientId: string; googleClientSecret: string; publicUrl: string; adminEmail: string; sessionSecret: string; port: number }`.

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm install fastify @fastify/secure-session openid-client
```
Expected: all three added under `dependencies`. (`zod` is already present — do not add it.)

- [ ] **Step 2: Write the failing test**

Create `electron/server/__tests__/config.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { getServerConfig } from '../config'

const REQUIRED = {
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret',
  PUBLIC_URL: 'https://hub.example.com', SESSION_SECRET: 'a-very-long-secret-value'
}

describe('getServerConfig', () => {
  const orig = { ...process.env }
  afterEach(() => { process.env = { ...orig } })

  it('reads required + defaulted values', () => {
    Object.assign(process.env, REQUIRED)
    delete process.env.ADMIN_EMAIL; delete process.env.PORT
    const c = getServerConfig()
    expect(c.googleClientId).toBe('cid')
    expect(c.publicUrl).toBe('https://hub.example.com')
    expect(c.adminEmail).toBe('rogercoxjr@gmail.com') // default
    expect(c.port).toBe(8788)                          // default
  })

  it('strips a trailing slash from PUBLIC_URL', () => {
    Object.assign(process.env, REQUIRED, { PUBLIC_URL: 'https://hub.example.com/' })
    expect(getServerConfig().publicUrl).toBe('https://hub.example.com')
  })

  it('throws when a required var is missing', () => {
    Object.assign(process.env, REQUIRED); delete process.env.GOOGLE_CLIENT_ID
    expect(() => getServerConfig()).toThrow(/GOOGLE_CLIENT_ID/)
  })

  it('throws when SESSION_SECRET is too short', () => {
    Object.assign(process.env, REQUIRED, { SESSION_SECRET: 'short' })
    expect(() => getServerConfig()).toThrow(/SESSION_SECRET/)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run electron/server/__tests__/config.test.ts`
Expected: FAIL — cannot find module `../config`.

- [ ] **Step 4: Write minimal implementation**

Create `electron/server/config.ts`:
```typescript
export interface ServerConfig {
  googleClientId: string
  googleClientSecret: string
  publicUrl: string
  adminEmail: string
  sessionSecret: string
  port: number
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

export function getServerConfig(): ServerConfig {
  const sessionSecret = required('SESSION_SECRET')
  if (sessionSecret.length < 16) throw new Error('SESSION_SECRET must be at least 16 characters')
  return {
    googleClientId: required('GOOGLE_CLIENT_ID'),
    googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
    publicUrl: required('PUBLIC_URL').replace(/\/$/, ''),
    adminEmail: process.env.ADMIN_EMAIL || 'rogercoxjr@gmail.com',
    sessionSecret,
    port: process.env.PORT ? Number(process.env.PORT) : 8788
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json electron/server/config.ts electron/server/__tests__/config.test.ts
git commit -m "feat(0b): server deps + env config module"
```

---

### Task 2: v34 `allowed_users` table + DB access functions

**Files:**
- Modify: `apps/electron/electron/main/services/database.ts` (`SCHEMA_VERSION` line 11; `SCHEMA` const ~line 13; `MIGRATIONS` registry ~line 666; add functions near the other domain functions)
- Modify: `apps/electron/electron/main/services/__tests__/database.boot.test.ts` and `apps/electron/electron/main/__tests__/headless-foundation.test.ts` (schema-version assertion 33 → 34)
- Test: `apps/electron/electron/main/services/__tests__/allowed-users.test.ts`

**Interfaces:**
- Produces (exported from `database.ts`):
  - `interface AllowedUser { email: string; role: 'admin' | 'member'; status: 'active' | 'revoked'; invited_by: string | null; created_at: string }`
  - `getAllowedUser(email: string): AllowedUser | undefined`
  - `listAllowedUsers(): AllowedUser[]`
  - `countActiveAdmins(): number`
  - `upsertAllowedUser(input: { email: string; role?: 'admin' | 'member'; invitedBy?: string | null }): void`
  - `setAllowedUserStatus(email: string, status: 'active' | 'revoked'): void`
  - `ensureBootstrapAdmin(adminEmail: string): void` (idempotent; inserts the admin as `admin`/`active` if absent, and re-promotes/re-activates it if present)

- [ ] **Step 1: Write the failing test**

Create `electron/main/services/__tests__/allowed-users.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('allowed_users', () => {
  let dir: string
  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-au-'))
    process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../file-storage')
    const { initializeDatabase } = await import('../database')
    await initializeFileStorage()
    await initializeDatabase()
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
  })

  it('boots to schema version 34', async () => {
    const { queryOne } = await import('../database')
    expect(queryOne<{ version: number }>('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')?.version).toBe(34)
  })

  it('ensureBootstrapAdmin inserts an admin once and is idempotent', async () => {
    const db = await import('../database')
    db.ensureBootstrapAdmin('boss@x.com')
    db.ensureBootstrapAdmin('boss@x.com')
    expect(db.getAllowedUser('boss@x.com')).toMatchObject({ email: 'boss@x.com', role: 'admin', status: 'active' })
    expect(db.listAllowedUsers()).toHaveLength(1)
    expect(db.countActiveAdmins()).toBe(1)
  })

  it('upsert + status + lookup round-trip', async () => {
    const db = await import('../database')
    db.upsertAllowedUser({ email: 'm@x.com', invitedBy: 'boss@x.com' })
    expect(db.getAllowedUser('m@x.com')).toMatchObject({ role: 'member', status: 'active', invited_by: 'boss@x.com' })
    db.setAllowedUserStatus('m@x.com', 'revoked')
    expect(db.getAllowedUser('m@x.com')?.status).toBe('revoked')
  })

  it('countActiveAdmins ignores members and revoked admins', async () => {
    const db = await import('../database')
    db.ensureBootstrapAdmin('a1@x.com')
    db.upsertAllowedUser({ email: 'a2@x.com', role: 'admin' })
    db.upsertAllowedUser({ email: 'm@x.com', role: 'member' })
    expect(db.countActiveAdmins()).toBe(2)
    db.setAllowedUserStatus('a2@x.com', 'revoked')
    expect(db.countActiveAdmins()).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/allowed-users.test.ts`
Expected: FAIL — version is 33 (not 34) and functions are undefined.

- [ ] **Step 3: Bump `SCHEMA_VERSION` and add the canonical table to `SCHEMA`**

`database.ts:11`: `const SCHEMA_VERSION = 33` → `const SCHEMA_VERSION = 34`.

In the `SCHEMA` template (after the `projects` table block, ~line 509), add:
```sql

-- Hosted-app access control (invite list). v34.
CREATE TABLE IF NOT EXISTS allowed_users (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
    invited_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 4: Add the v34 migration to `MIGRATIONS`**

After the `33: () => { ... },` entry (~line 1889), add:
```typescript
  34: () => {
    // v34: hosted-app access control (invite list). Additive — new table only.
    console.log('Running migration to schema v34: allowed_users')
    getDatabase().exec(`CREATE TABLE IF NOT EXISTS allowed_users (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
      invited_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
    console.log('Migration v34 complete')
  },
```

- [ ] **Step 5: Add the DB access functions**

Append near the other contact/project functions in `database.ts`:
```typescript
export interface AllowedUser {
  email: string
  role: 'admin' | 'member'
  status: 'active' | 'revoked'
  invited_by: string | null
  created_at: string
}

export function getAllowedUser(email: string): AllowedUser | undefined {
  return queryOne<AllowedUser>('SELECT * FROM allowed_users WHERE email = ?', [email])
}

export function listAllowedUsers(): AllowedUser[] {
  return queryAll<AllowedUser>('SELECT * FROM allowed_users ORDER BY created_at ASC')
}

export function countActiveAdmins(): number {
  return queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM allowed_users WHERE role = 'admin' AND status = 'active'"
  )?.n ?? 0
}

export function upsertAllowedUser(input: { email: string; role?: 'admin' | 'member'; invitedBy?: string | null }): void {
  run(
    `INSERT INTO allowed_users (email, role, status, invited_by)
     VALUES (?, ?, 'active', ?)
     ON CONFLICT(email) DO UPDATE SET role = excluded.role, invited_by = COALESCE(excluded.invited_by, allowed_users.invited_by)`,
    [input.email, input.role ?? 'member', input.invitedBy ?? null]
  )
}

export function setAllowedUserStatus(email: string, status: 'active' | 'revoked'): void {
  run('UPDATE allowed_users SET status = ? WHERE email = ?', [status, email])
}

export function ensureBootstrapAdmin(adminEmail: string): void {
  run(
    `INSERT INTO allowed_users (email, role, status, invited_by)
     VALUES (?, 'admin', 'active', NULL)
     ON CONFLICT(email) DO UPDATE SET role = 'admin', status = 'active'`,
    [adminEmail]
  )
}
```

- [ ] **Step 6: Update the schema-version assertions in existing tests**

In `electron/main/services/__tests__/database.boot.test.ts` change the `toBe(33)` assertions to `toBe(34)`. In `electron/main/__tests__/headless-foundation.test.ts` change the `toBe(33)` assertion to `toBe(34)`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run electron/main/services/__tests__/allowed-users.test.ts electron/main/services/__tests__/database.boot.test.ts electron/main/__tests__/headless-foundation.test.ts`
Expected: PASS (all green; allowed-users 4 tests).

- [ ] **Step 8: Commit**

```bash
git add electron/main/services/database.ts electron/main/services/__tests__/allowed-users.test.ts electron/main/services/__tests__/database.boot.test.ts electron/main/__tests__/headless-foundation.test.ts
git commit -m "feat(0b): v34 allowed_users table + access functions"
```

---

### Task 3: `OidcService` interface + Google impl + test fake

**Files:**
- Create: `apps/electron/electron/server/oidc.ts`
- Test: `apps/electron/electron/server/__tests__/oidc-fake.test.ts`

**Interfaces:**
- Produces:
  - `interface OidcUser { email: string; emailVerified: boolean; sub: string }`
  - `interface LoginContext { state: string; nonce: string; codeVerifier: string }`
  - `interface OidcService { beginLogin(): Promise<{ redirectUrl: string } & LoginContext>; completeLogin(currentUrl: string, ctx: LoginContext): Promise<OidcUser> }`
  - `createGoogleOidc(cfg: { clientId: string; clientSecret: string; publicUrl: string }): OidcService` (real)
  - `createFakeOidc(result: OidcUser, opts?: { failComplete?: boolean }): OidcService` (test fake — asserts the ctx passed to `completeLogin` equals the ctx returned by `beginLogin`)

- [ ] **Step 1: Write the failing test**

Create `electron/server/__tests__/oidc-fake.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { createFakeOidc } from '../oidc'

describe('createFakeOidc', () => {
  it('beginLogin returns a redirect URL + login context', async () => {
    const oidc = createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's1' })
    const r = await oidc.beginLogin()
    expect(r.redirectUrl).toContain('http')
    expect(r.state).toBeTruthy(); expect(r.nonce).toBeTruthy(); expect(r.codeVerifier).toBeTruthy()
  })

  it('completeLogin returns the canned user when given the issued context', async () => {
    const oidc = createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's1' })
    const ctx = await oidc.beginLogin()
    const u = await oidc.completeLogin('https://hub.example.com/auth/callback?code=x&state=' + ctx.state, ctx)
    expect(u).toEqual({ email: 'a@x.com', emailVerified: true, sub: 's1' })
  })

  it('completeLogin throws when the context does not match what was issued', async () => {
    const oidc = createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's1' })
    await oidc.beginLogin()
    await expect(oidc.completeLogin('https://hub.example.com/auth/callback',
      { state: 'wrong', nonce: 'wrong', codeVerifier: 'wrong' })).rejects.toThrow(/context/)
  })

  it('completeLogin can be forced to fail (exchange error)', async () => {
    const oidc = createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's1' }, { failComplete: true })
    const ctx = await oidc.beginLogin()
    await expect(oidc.completeLogin('https://hub.example.com/auth/callback', ctx)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/server/__tests__/oidc-fake.test.ts`
Expected: FAIL — cannot find module `../oidc`.

- [ ] **Step 3: Write the implementation**

Create `electron/server/oidc.ts`:
```typescript
import { randomUUID } from 'crypto'

export interface OidcUser { email: string; emailVerified: boolean; sub: string }
export interface LoginContext { state: string; nonce: string; codeVerifier: string }
export interface OidcService {
  beginLogin(): Promise<{ redirectUrl: string } & LoginContext>
  completeLogin(currentUrl: string, ctx: LoginContext): Promise<OidcUser>
}

const GOOGLE_ISSUER = 'https://accounts.google.com'
const SCOPE = 'openid email profile'

/**
 * Real Google OIDC client. openid-client v6 is ESM-only and discovery() hits the
 * network, so it is loaded lazily via dynamic import and the Configuration is
 * memoized. NOT unit-tested (needs live Google creds) — verified live by the operator.
 */
export function createGoogleOidc(cfg: { clientId: string; clientSecret: string; publicUrl: string }): OidcService {
  const redirectUri = `${cfg.publicUrl}/auth/callback`
  let configPromise: Promise<unknown> | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lib = (): Promise<any> => import('openid-client')
  const getConfig = async (): Promise<unknown> => {
    if (!configPromise) {
      const client = await lib()
      configPromise = client.discovery(new URL(GOOGLE_ISSUER), cfg.clientId, cfg.clientSecret)
    }
    return configPromise
  }

  return {
    async beginLogin() {
      const client = await lib()
      const config = await getConfig()
      const codeVerifier: string = client.randomPKCECodeVerifier()
      const codeChallenge: string = await client.calculatePKCECodeChallenge(codeVerifier)
      const state: string = client.randomState()
      const nonce: string = client.randomNonce()
      const url: URL = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce
      })
      return { redirectUrl: url.href, state, nonce, codeVerifier }
    },
    async completeLogin(currentUrl, ctx) {
      const client = await lib()
      const config = await getConfig()
      const tokens = await client.authorizationCodeGrant(config, new URL(currentUrl), {
        pkceCodeVerifier: ctx.codeVerifier,
        expectedState: ctx.state,
        expectedNonce: ctx.nonce
      })
      const claims = tokens.claims()
      if (!claims?.email) throw new Error('OIDC: no email claim')
      return { email: String(claims.email), emailVerified: claims.email_verified === true, sub: String(claims.sub) }
    }
  }
}

/**
 * Deterministic in-memory fake for route tests. completeLogin asserts it received
 * the exact context beginLogin issued, so a route that fails to stash/retrieve
 * state/nonce/code_verifier across the redirect fails the test.
 */
export function createFakeOidc(result: OidcUser, opts: { failComplete?: boolean } = {}): OidcService {
  let issued: LoginContext | null = null
  return {
    async beginLogin() {
      issued = { state: randomUUID(), nonce: randomUUID(), codeVerifier: randomUUID() }
      return { redirectUrl: 'https://accounts.google.com/o/oauth2/v2/auth?fake=1', ...issued }
    },
    async completeLogin(_currentUrl, ctx) {
      if (opts.failComplete) throw new Error('OIDC exchange failed')
      if (issued && (ctx.state !== issued.state || ctx.nonce !== issued.nonce || ctx.codeVerifier !== issued.codeVerifier)) {
        throw new Error('OIDC: login context mismatch (state/nonce/verifier)')
      }
      return result
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/oidc-fake.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/server/oidc.ts electron/server/__tests__/oidc-fake.test.ts
git commit -m "feat(0b): OidcService interface + Google impl + context-asserting fake"
```

---

### Task 4: Fastify app bootstrap + `/healthz` + session

**Files:**
- Create: `apps/electron/electron/server/app.ts`
- Create: `apps/electron/electron/server/types.d.ts`
- Test: `apps/electron/electron/server/__tests__/app.test.ts`

**Interfaces:**
- Consumes: `OidcService` (Task 3).
- Produces: `interface AppDeps { oidc: OidcService; sessionSecret: string; adminEmail: string; publicUrl: string; cookieSecure: boolean }`; `buildApp(deps: AppDeps): Promise<FastifyInstance>`.

- [ ] **Step 1: Write the failing test**

Create `electron/server/__tests__/app.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { buildApp, AppDeps } from '../app'
import { createFakeOidc } from '../oidc'

export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    oidc: createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's' }),
    sessionSecret: 'a-very-long-secret-value',
    adminEmail: 'boss@x.com',
    publicUrl: 'https://hub.example.com',
    cookieSecure: false, // inject() has no TLS — a Secure cookie would not round-trip
    ...overrides
  }
}

describe('buildApp', () => {
  it('serves /healthz', async () => {
    const app = await buildApp(testDeps())
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
    await app.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/server/__tests__/app.test.ts`
Expected: FAIL — cannot find module `../app`.

- [ ] **Step 3: Write the implementation**

Create `electron/server/app.ts`:
```typescript
import Fastify, { FastifyInstance } from 'fastify'
import secureSession from '@fastify/secure-session'
import { createHash } from 'crypto'
import { OidcService } from './oidc'

export interface AppDeps {
  oidc: OidcService
  sessionSecret: string
  adminEmail: string
  publicUrl: string
  cookieSecure: boolean
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true })

  await app.register(secureSession, {
    sessionName: 'session',
    cookieName: 'hidock_session',
    key: createHash('sha256').update(deps.sessionSecret).digest(), // 32 bytes
    cookie: { path: '/', httpOnly: true, secure: deps.cookieSecure, sameSite: 'lax' }
  })

  app.decorate('appDeps', deps)
  app.get('/healthz', async () => ({ status: 'ok' }))

  // Auth + admin routes are registered here in Tasks 5 and 6.

  return app
}
```
Create `electron/server/types.d.ts`:
```typescript
import { preHandlerHookHandler } from 'fastify'
import { AppDeps } from './app'

declare module 'fastify' {
  interface FastifyInstance {
    appDeps: AppDeps
    requireAuth: preHandlerHookHandler
    requireAdmin: preHandlerHookHandler
    requireSameOrigin: preHandlerHookHandler
  }
  interface FastifyRequest {
    user?: { email: string; role: 'admin' | 'member' }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/server/app.ts electron/server/types.d.ts electron/server/__tests__/app.test.ts
git commit -m "feat(0b): Fastify app bootstrap + healthz + config-driven secure-session"
```

---

### Task 5: Auth routes (login/callback/logout) + guards

**Files:**
- Create: `apps/electron/electron/server/auth.ts`
- Modify: `apps/electron/electron/server/app.ts` (register the auth plugin)
- Test: `apps/electron/electron/server/__tests__/auth.test.ts`

**Interfaces:**
- Consumes: `AppDeps` (`oidc`, `publicUrl`); `getAllowedUser` from `../main/services/database`.
- Produces: `registerAuth(app)` adding `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`, `GET /api/me`; decorators `app.requireAuth`, `app.requireAdmin`, `app.requireSameOrigin`.

- [ ] **Step 1: Write the failing test**

Create `electron/server/__tests__/auth.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'

async function makeApp(oidcEmail: string) {
  return buildApp(testDeps({ oidc: createFakeOidc({ email: oidcEmail, emailVerified: true, sub: 'sub-' + oidcEmail }) }))
}

// Drive login → callback; return the callback response + the session cookie to reuse.
async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const start = await app.inject({ method: 'GET', url: '/auth/login' })
  const startCookie = start.cookies.find((c) => c.name === 'hidock_session')!
  const cb = await app.inject({
    method: 'GET', url: '/auth/callback?code=x&state=ignored-by-fake',
    cookies: { hidock_session: startCookie.value }
  })
  const cbCookie = cb.cookies.find((c) => c.name === 'hidock_session')
  return { start, cb, sessionCookie: (cbCookie ?? startCookie).value }
}

describe('auth routes', () => {
  let dir: string
  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-auth-'))
    process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin } = await import('../../main/services/database')
    await initializeFileStorage(); await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../../main/services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true }); delete process.env.HIDOCK_DATA_ROOT
  })

  it('GET /auth/login redirects to the provider', async () => {
    const app = await makeApp('boss@x.com')
    const res = await app.inject({ method: 'GET', url: '/auth/login' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('accounts.google.com')
    await app.close()
  })

  it('an allow-listed user gets a session; /api/me returns their role', async () => {
    const app = await makeApp('boss@x.com')
    const { sessionCookie } = await login(app)
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { hidock_session: sessionCookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ email: 'boss@x.com', role: 'admin' })
    await app.close()
  })

  it('a non-invited user is denied (403) at callback', async () => {
    const app = await makeApp('stranger@x.com')
    const { cb } = await login(app)
    expect(cb.statusCode).toBe(403)
    await app.close()
  })

  it('callback with no login-in-progress session → 400', async () => {
    const app = await makeApp('boss@x.com')
    const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x' }) // no session cookie
    expect(cb.statusCode).toBe(400)
    await app.close()
  })

  it('a revoked user is rejected by the guard (401)', async () => {
    const app = await makeApp('boss@x.com')
    const { sessionCookie } = await login(app)
    const { setAllowedUserStatus } = await import('../../main/services/database')
    setAllowedUserStatus('boss@x.com', 'revoked')
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { hidock_session: sessionCookie } })
    expect(me.statusCode).toBe(401)
    await app.close()
  })

  it('logout clears the session (subsequent /api/me is 401)', async () => {
    const app = await makeApp('boss@x.com')
    const { sessionCookie } = await login(app)
    const out = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { hidock_session: sessionCookie } })
    expect(out.statusCode).toBe(204)
    const cleared = out.cookies.find((c) => c.name === 'hidock_session')
    const me = await app.inject({ method: 'GET', url: '/api/me',
      cookies: { hidock_session: cleared ? cleared.value : '' } })
    expect(me.statusCode).toBe(401)
    await app.close()
  })
})
```
> Import-depth note: this test is at `electron/server/__tests__/`, so main-process modules are `../../main/...` (two levels up). `../app` and `../oidc` (one level up) reach the server modules. `./app.test` reuses the `testDeps` helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/server/__tests__/auth.test.ts`
Expected: FAIL — `registerAuth` / routes missing.

- [ ] **Step 3: Write the implementation**

Create `electron/server/auth.ts`:
```typescript
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getAllowedUser } from '../main/services/database'

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const { oidc, publicUrl } = app.appDeps

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    const email = req.session.get('email') as string | undefined
    if (!email) return reply.code(401).send({ error: 'unauthenticated' })
    const u = getAllowedUser(email)
    if (!u || u.status !== 'active') {
      req.session.delete()
      return reply.code(401).send({ error: 'unauthorized' })
    }
    req.user = { email: u.email, role: u.role }
  })

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || req.user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
  })

  // CSRF defense-in-depth: a present-but-foreign Origin on a mutating request is rejected.
  app.decorate('requireSameOrigin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (MUTATING.has(req.method)) {
      const origin = req.headers.origin
      if (origin && origin !== publicUrl) return reply.code(403).send({ error: 'bad origin' })
    }
  })

  app.get('/auth/login', async (req, reply) => {
    const { redirectUrl, state, nonce, codeVerifier } = await oidc.beginLogin()
    req.session.set('oidc', { state, nonce, codeVerifier })
    return reply.redirect(redirectUrl, 302)
  })

  app.get('/auth/callback', async (req, reply) => {
    const ctx = req.session.get('oidc') as { state: string; nonce: string; codeVerifier: string } | undefined
    if (!ctx) return reply.code(400).send({ error: 'no login in progress' })
    // Build the callback URL from PUBLIC_URL (not req.host — that is the internal proxy address).
    const currentUrl = new URL(req.url, publicUrl).href
    let user
    try {
      user = await oidc.completeLogin(currentUrl, ctx)
    } catch {
      req.session.set('oidc', undefined)
      return reply.code(400).send({ error: 'oidc exchange failed' })
    }
    req.session.set('oidc', undefined)
    if (!user.emailVerified) return reply.code(403).send({ error: 'email not verified' })
    const allowed = getAllowedUser(user.email)
    if (!allowed || allowed.status !== 'active') {
      req.session.delete()
      return reply.code(403).send({ error: 'not invited — contact the administrator' })
    }
    req.session.set('email', user.email)
    return reply.redirect('/', 302)
  })

  app.post('/auth/logout', async (req, reply) => {
    req.session.delete()
    return reply.code(204).send()
  })

  app.get('/api/me', { preHandler: [app.requireAuth] }, async (req) => {
    return { email: req.user!.email, role: req.user!.role }
  })
}
```
In `app.ts`, after `app.get('/healthz', ...)` and before `return app`:
```typescript
  const { registerAuth } = await import('./auth')
  await registerAuth(app)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/auth.test.ts`
Expected: PASS (6 tests). If `@fastify/secure-session`'s installed major rejects `set(key, undefined)` for clearing, replace those two lines with the version's documented clear (e.g. omit the clear — the one-time code is already consumed — and note it); do not weaken any assertion.

- [ ] **Step 5: Commit**

```bash
git add electron/server/auth.ts electron/server/app.ts electron/server/__tests__/auth.test.ts
git commit -m "feat(0b): OIDC login/callback/logout + auth/admin/same-origin guards + invite gate"
```

---

### Task 6: Admin user-management routes

**Files:**
- Create: `apps/electron/electron/server/routes/admin-users.ts`
- Modify: `apps/electron/electron/server/app.ts` (register the admin routes)
- Test: `apps/electron/electron/server/__tests__/admin-users.test.ts`

**Interfaces:**
- Consumes: `requireAuth`/`requireAdmin`/`requireSameOrigin` (Task 5); `listAllowedUsers`/`upsertAllowedUser`/`setAllowedUserStatus`/`getAllowedUser`/`countActiveAdmins` from `../../main/services/database`.
- Produces: `registerAdminUsers(app)` adding `GET /api/admin/users` (list), `POST /api/admin/users` (invite; body `{email, role?}`), `PATCH /api/admin/users` (update; body `{email, role?, status?}` — covers revoke/reactivate; rejects a change that would leave zero active admins). No path params; no hard delete.

- [ ] **Step 1: Write the failing test**

Create `electron/server/__tests__/admin-users.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'

async function makeApp(oidcEmail: string) {
  return buildApp(testDeps({ oidc: createFakeOidc({ email: oidcEmail, emailVerified: true, sub: 's' }) }))
}
async function loginAs(app: Awaited<ReturnType<typeof buildApp>>) {
  const start = await app.inject({ method: 'GET', url: '/auth/login' })
  const c = start.cookies.find((x) => x.name === 'hidock_session')!
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x', cookies: { hidock_session: c.value } })
  return (cb.cookies.find((x) => x.name === 'hidock_session') ?? c).value
}

describe('admin users routes', () => {
  let dir: string
  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-admin-')); process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, upsertAllowedUser } = await import('../../main/services/database')
    await initializeFileStorage(); await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
    upsertAllowedUser({ email: 'member@x.com', invitedBy: 'boss@x.com' })
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../../main/services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true }); delete process.env.HIDOCK_DATA_ROOT
  })

  it('admin can list users', async () => {
    const app = await makeApp('boss@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', cookies: { hidock_session: cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().users.map((u: { email: string }) => u.email)).toContain('member@x.com')
    await app.close()
  })

  it('admin can invite, change role, and revoke (via PATCH status)', async () => {
    const app = await makeApp('boss@x.com'); const cookie = await loginAs(app)
    const inv = await app.inject({ method: 'POST', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, payload: { email: 'new@x.com' } })
    expect(inv.statusCode).toBe(201)
    const patch = await app.inject({ method: 'PATCH', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, payload: { email: 'new@x.com', role: 'admin' } })
    expect(patch.statusCode).toBe(200)
    const revoke = await app.inject({ method: 'PATCH', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, payload: { email: 'new@x.com', status: 'revoked' } })
    expect(revoke.statusCode).toBe(200)
    const { getAllowedUser } = await import('../../main/services/database')
    expect(getAllowedUser('new@x.com')?.status).toBe('revoked')
  })

  it('refuses to revoke the last active admin (409)', async () => {
    const app = await makeApp('boss@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, payload: { email: 'boss@x.com', status: 'revoked' } })
    expect(res.statusCode).toBe(409)
    const { getAllowedUser } = await import('../../main/services/database')
    expect(getAllowedUser('boss@x.com')?.status).toBe('active')
  })

  it('refuses to demote the last active admin to member (409)', async () => {
    const app = await makeApp('boss@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, payload: { email: 'boss@x.com', role: 'member' } })
    expect(res.statusCode).toBe(409)
  })

  it('a member is forbidden (403)', async () => {
    const app = await makeApp('member@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', cookies: { hidock_session: cookie } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('a mutating request with a foreign Origin is rejected (403)', async () => {
    const app = await makeApp('boss@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'POST', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, headers: { origin: 'https://evil.example.com' },
      payload: { email: 'x@x.com' } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/server/__tests__/admin-users.test.ts`
Expected: FAIL — admin routes missing (404).

- [ ] **Step 3: Write the implementation**

Create `electron/server/routes/admin-users.ts`:
```typescript
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  listAllowedUsers, upsertAllowedUser, setAllowedUserStatus, getAllowedUser, countActiveAdmins
} from '../../main/services/database'

const inviteSchema = z.object({ email: z.email(), role: z.enum(['admin', 'member']).optional() })
const patchSchema = z.object({
  email: z.email(),
  role: z.enum(['admin', 'member']).optional(),
  status: z.enum(['active', 'revoked']).optional()
})

export async function registerAdminUsers(app: FastifyInstance): Promise<void> {
  const read = { preHandler: [app.requireAuth, app.requireAdmin] }
  const write = { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] }

  app.get('/api/admin/users', read, async () => ({ users: listAllowedUsers() }))

  app.post('/api/admin/users', write, async (req, reply) => {
    const body = inviteSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid', details: body.error.flatten() })
    upsertAllowedUser({ email: body.data.email, role: body.data.role, invitedBy: req.user!.email })
    return reply.code(201).send({ user: getAllowedUser(body.data.email) })
  })

  app.patch('/api/admin/users', write, async (req, reply) => {
    const body = patchSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid', details: body.error.flatten() })
    const current = getAllowedUser(body.data.email)
    if (!current) return reply.code(404).send({ error: 'not found' })

    // Last-admin guard: block a change that removes the final active admin.
    const willRemoveAdmin =
      current.role === 'admin' && current.status === 'active' &&
      ((body.data.role && body.data.role !== 'admin') || body.data.status === 'revoked')
    if (willRemoveAdmin && countActiveAdmins() <= 1) {
      return reply.code(409).send({ error: 'cannot remove the last active admin' })
    }

    if (body.data.role) upsertAllowedUser({ email: body.data.email, role: body.data.role })
    if (body.data.status) setAllowedUserStatus(body.data.email, body.data.status)
    return reply.send({ user: getAllowedUser(body.data.email) })
  })
}
```
In `app.ts`, after `await registerAuth(app)`:
```typescript
  const { registerAdminUsers } = await import('./routes/admin-users')
  await registerAdminUsers(app)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/admin-users.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/server/routes/admin-users.ts electron/server/app.ts electron/server/__tests__/admin-users.test.ts
git commit -m "feat(0b): admin user routes (invite/role/revoke) with last-admin + origin guards"
```

---

### Task 7: Server entry point + scripts

**Files:**
- Create: `apps/electron/electron/server/index.ts`
- Modify: `apps/electron/package.json` (add a `start:server` script)
- Test: `apps/electron/electron/server/__tests__/entry.test.ts`

**Interfaces:**
- Consumes: `bootFoundation` (`../main/boot-foundation`), `getServerConfig`, `createGoogleOidc`, `buildApp`, `ensureBootstrapAdmin`.
- Produces: `startServer(): Promise<FastifyInstance>` (boots foundation, ensures admin, builds app with `cookieSecure: true`, listens on `cfg.port`).

- [ ] **Step 1: Write the failing test**

Create `electron/server/__tests__/entry.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('startServer', () => {
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-entry-'))
    Object.assign(process.env, {
      HIDOCK_DATA_ROOT: dir, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec',
      PUBLIC_URL: 'https://hub.example.com', SESSION_SECRET: 'a-very-long-secret-value',
      ADMIN_EMAIL: 'boss@x.com', PORT: '0'
    })
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../../main/services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    for (const k of ['HIDOCK_DATA_ROOT','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','PUBLIC_URL','SESSION_SECRET','ADMIN_EMAIL','PORT']) delete process.env[k]
  })

  it('boots foundation, seeds the bootstrap admin, and serves /healthz', async () => {
    const { startServer } = await import('../index')
    const app = await startServer()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    const { getAllowedUser } = await import('../../main/services/database')
    expect(getAllowedUser('boss@x.com')?.role).toBe('admin')
    await app.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/server/__tests__/entry.test.ts`
Expected: FAIL — cannot find module `../index`.

- [ ] **Step 3: Write the implementation**

Create `electron/server/index.ts`:
```typescript
import { FastifyInstance } from 'fastify'
import { bootFoundation } from '../main/boot-foundation'
import { ensureBootstrapAdmin } from '../main/services/database'
import { getServerConfig } from './config'
import { createGoogleOidc } from './oidc'
import { buildApp } from './app'

export async function startServer(): Promise<FastifyInstance> {
  const cfg = getServerConfig()
  await bootFoundation()
  ensureBootstrapAdmin(cfg.adminEmail)
  const oidc = createGoogleOidc({ clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret, publicUrl: cfg.publicUrl })
  const app = await buildApp({
    oidc, sessionSecret: cfg.sessionSecret, adminEmail: cfg.adminEmail,
    publicUrl: cfg.publicUrl, cookieSecure: true
  })
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  return app
}

// Run when invoked directly (node out/server/index.js).
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  startServer().catch((err) => { console.error('[server] failed to start', err); process.exit(1) })
}
```
> The entry test sets all required env and `PORT=0` (ephemeral). `startServer` constructs the REAL `createGoogleOidc`, but the test only hits `/healthz` — `discovery()` is lazy, so no Google network call occurs. Live OAuth is verified by the operator with real creds. `trustProxy: true` (set in `buildApp`) lets Fastify honor `X-Forwarded-*` from nginxproxymanager.

In `package.json` scripts, add:
```json
"start:server": "node out/server/index.js"
```
(The build that produces `out/server/` is wired in sub-plan 0f; for now `start:server` documents the entry point — it will not run until 0f builds the server bundle.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/entry.test.ts`
Expected: PASS.

- [ ] **Step 5: Final gate**

Run: `npm run typecheck && npm run test:run`
Expected: PASS (full suite green, including all new server tests and the v34 schema-version updates).

- [ ] **Step 6: Commit**

```bash
git add electron/server/index.ts package.json electron/server/__tests__/entry.test.ts
git commit -m "feat(0b): server entry point (boot foundation + listen) + start:server script"
```

---

## Self-Review

**Spec coverage (§5):** Google OIDC → Task 3 (real) + Task 5 (routes); `allowed_users` table → Task 2; bootstrap admin via `ADMIN_EMAIL` → Task 2 + Task 7; callback gate (verify → look up → session/deny) → Task 5; admin CRUD → Task 6; session cookie attributes → Task 4; `email_verified` check → Task 5; CSRF origin check → Task 5/6; `/healthz` → Task 4. Guarded WS/media are 0c/0d (out of scope).

**Antagonistic-review fixes applied:** (1) test import depth corrected to `../../main/...` throughout Tasks 5–7; (2) `cookieSecure` is config-driven, `false` in tests (`testDeps`), `true` in `startServer` — Secure-cookie-in-inject blocker removed; (3) Zod v4 `z.email()` (not `z.string().email()`); (4) callback URL built from `PUBLIC_URL` via `new URL(req.url, publicUrl)` + `trustProxy: true` — no `req.host` garbage; (5) the fake asserts the login-context round-trip + a "no login-in-progress → 400" test covers state threading; (6) `oidc` temp cleared on both success and failure paths (with a fallback note if the secure-session major rejects `undefined`); (7) last-admin guard (409) on revoke/demote + tests; (8) email travels in the request body, no path params; (9) `requireSameOrigin` guard on mutating admin routes + a foreign-Origin test; (10) `start:server` documented as 0f-dependent.

**Placeholder scan:** none. The only deliberately-untested unit is the real `createGoogleOidc` (needs live creds) — full real code provided, deferral documented.

**Type consistency:** `AppDeps` (now `{ oidc, sessionSecret, adminEmail, publicUrl, cookieSecure }`) defined in Task 4, consumed in Tasks 5–7 and the shared `testDeps` helper. `OidcService`/`OidcUser`/`LoginContext` from Task 3 used unchanged. `AllowedUser` + the six DB functions (incl. `countActiveAdmins`) from Task 2 consumed in Tasks 5–6. Decorators `requireAuth`/`requireAdmin`/`requireSameOrigin` declared in `types.d.ts` (Task 4), defined in Task 5, consumed in Task 6. Session keys `'email'`/`'oidc'` consistent across Task 5.
