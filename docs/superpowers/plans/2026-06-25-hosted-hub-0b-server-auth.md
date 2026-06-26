# Hosted Hub — Plan 0b: Fastify Server + Google OIDC + Invite System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the hosted web server: a Fastify app on top of `bootFoundation()` with Google-OIDC login gated by an admin-managed `allowed_users` invite list, and admin-only user-management routes.

**Architecture:** A new `electron/server/` tree boots the 0a foundation (`bootFoundation()`), then runs Fastify. Auth is OIDC (Google) behind an injectable `OidcService` interface (real impl uses `openid-client`; a fake drives tests). The session cookie (`@fastify/secure-session`) holds only the authenticated `email`; an auth guard re-reads `allowed_users` on every request so revocation is instant. Admin routes manage the invite list. Domain REST routers, media, renderer, device sync, and Docker are later sub-plans.

**Tech Stack:** Node 20+, Fastify 5, `@fastify/secure-session`, `openid-client` v6, better-sqlite3 (via 0a), Vitest (`app.inject` + real DB).

## Global Constraints

- **Server lives in `apps/electron/electron/server/`** (covered by `tsconfig.node.json` `electron/**`). It imports the foundation via `../main/boot-foundation` and DB via `../main/services/database`.
- **Env (read by `getServerConfig()`):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL` (e.g. `https://hub.example.com`), `ADMIN_EMAIL` (default `rogercoxjr@gmail.com`), `SESSION_SECRET` (≥16 chars), `PORT` (default `8788`). Missing required (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`PUBLIC_URL`/`SESSION_SECRET`) → throw at startup.
- **`allowed_users` schema:** `email TEXT PRIMARY KEY`, `role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member'))`, `status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked'))`, `invited_by TEXT`, `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`. **Schema version 33 → 34.**
- **Session cookie:** name `hidock_session`; `httpOnly: true, secure: true, sameSite: 'lax', path: '/'`; holds only `{ email }`. Key = `sha256(SESSION_SECRET)` (32 bytes).
- **Auth guard re-reads `allowed_users` each request** — never trust a role cached in the cookie; revoked/missing → 401 + clear session.
- **OIDC:** scope `openid email profile`; `redirect_uri = ${PUBLIC_URL}/auth/callback`; PKCE (state, nonce, code_verifier stashed in session between login redirect and callback). Reject if `email_verified !== true`.
- **`openid-client` is ESM-only** — load it via dynamic `import('openid-client')` inside the real impl to avoid CJS interop issues; the real impl is NOT unit-tested (needs live Google creds) — its live verification is deferred to the user. All route/gate logic is tested with the **fake** `OidcService`.
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
Expected: all three added under `dependencies`.

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
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json electron/server/config.ts electron/server/__tests__/config.test.ts
git commit -m "feat(0b): server deps + env config module"
```

---

### Task 2: v34 `allowed_users` table + DB access functions

**Files:**
- Modify: `apps/electron/electron/main/services/database.ts` (`SCHEMA_VERSION` line 11; `SCHEMA` const ~line 13; `MIGRATIONS` registry ~line 666; add functions near the other domain functions)
- Test: `apps/electron/electron/main/services/__tests__/allowed-users.test.ts`

**Interfaces:**
- Produces (exported from `database.ts`):
  - `interface AllowedUser { email: string; role: 'admin' | 'member'; status: 'active' | 'revoked'; invited_by: string | null; created_at: string }`
  - `getAllowedUser(email: string): AllowedUser | undefined`
  - `listAllowedUsers(): AllowedUser[]`
  - `upsertAllowedUser(input: { email: string; role?: 'admin' | 'member'; invitedBy?: string | null }): void`
  - `setAllowedUserStatus(email: string, status: 'active' | 'revoked'): void`
  - `ensureBootstrapAdmin(adminEmail: string): void` (idempotent; inserts the admin as `admin`/`active` if absent)

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
    const u = db.getAllowedUser('boss@x.com')
    expect(u).toMatchObject({ email: 'boss@x.com', role: 'admin', status: 'active' })
    expect(db.listAllowedUsers()).toHaveLength(1)
  })

  it('upsert + status + lookup round-trip', async () => {
    const db = await import('../database')
    db.upsertAllowedUser({ email: 'm@x.com', invitedBy: 'boss@x.com' })
    expect(db.getAllowedUser('m@x.com')).toMatchObject({ role: 'member', status: 'active', invited_by: 'boss@x.com' })
    db.setAllowedUserStatus('m@x.com', 'revoked')
    expect(db.getAllowedUser('m@x.com')?.status).toBe('revoked')
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

export function upsertAllowedUser(input: { email: string; role?: 'admin' | 'member'; invitedBy?: string | null }): void {
  run(
    `INSERT INTO allowed_users (email, role, status, invited_by)
     VALUES (?, ?, 'active', ?)
     ON CONFLICT(email) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by`,
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

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run electron/main/services/__tests__/allowed-users.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Confirm no schema-version regressions**

Run: `npx vitest run electron/main/services/__tests__/database.boot.test.ts`
Expected: FAIL on the "schema version 33" assertion (it now reaches 34). Update that assertion in `database.boot.test.ts` from `toBe(33)` to `toBe(34)`, and update the same constant in `electron/main/__tests__/headless-foundation.test.ts`. Re-run both → PASS.

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
  - `createFakeOidc(result: OidcUser, opts?: { failComplete?: boolean }): OidcService` (test helper)

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

  it('completeLogin returns the canned user', async () => {
    const oidc = createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's1' })
    const ctx = await oidc.beginLogin()
    const u = await oidc.completeLogin('https://hub/auth/callback?code=x&state=' + ctx.state, ctx)
    expect(u).toEqual({ email: 'a@x.com', emailVerified: true, sub: 's1' })
  })

  it('completeLogin can be made to throw', async () => {
    const oidc = createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's1' }, { failComplete: true })
    const ctx = await oidc.beginLogin()
    await expect(oidc.completeLogin('https://hub/auth/callback', ctx)).rejects.toThrow()
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
  let configPromise: Promise<any> | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lib = (): Promise<any> => import('openid-client')
  const getConfig = async () => {
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

/** Deterministic in-memory fake for route tests. */
export function createFakeOidc(result: OidcUser, opts: { failComplete?: boolean } = {}): OidcService {
  return {
    async beginLogin() {
      return {
        redirectUrl: 'https://accounts.google.com/o/oauth2/v2/auth?fake=1',
        state: randomUUID(), nonce: randomUUID(), codeVerifier: randomUUID()
      }
    },
    async completeLogin() {
      if (opts.failComplete) throw new Error('OIDC exchange failed')
      return result
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/oidc-fake.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/server/oidc.ts electron/server/__tests__/oidc-fake.test.ts
git commit -m "feat(0b): OidcService interface + Google impl + test fake"
```

---

### Task 4: Fastify app bootstrap + `/healthz` + session

**Files:**
- Create: `apps/electron/electron/server/app.ts`
- Test: `apps/electron/electron/server/__tests__/app.test.ts`

**Interfaces:**
- Consumes: `OidcService` (Task 3).
- Produces: `interface AppDeps { oidc: OidcService; sessionSecret: string; adminEmail: string }`; `buildApp(deps: AppDeps): Promise<FastifyInstance>`.

- [ ] **Step 1: Write the failing test**

Create `electron/server/__tests__/app.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'

function deps() {
  return { oidc: createFakeOidc({ email: 'a@x.com', emailVerified: true, sub: 's' }),
           sessionSecret: 'a-very-long-secret-value', adminEmail: 'boss@x.com' }
}

describe('buildApp', () => {
  it('serves /healthz', async () => {
    const app = await buildApp(deps())
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
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  await app.register(secureSession, {
    sessionName: 'session',
    cookieName: 'hidock_session',
    key: createHash('sha256').update(deps.sessionSecret).digest(), // 32 bytes
    cookie: { path: '/', httpOnly: true, secure: true, sameSite: 'lax' }
  })

  app.get('/healthz', async () => ({ status: 'ok' }))

  // Auth + admin routes are registered here in Tasks 5 and 6.
  app.decorate('appDeps', deps)

  return app
}
```
Add the decorator type so TypeScript knows about `appDeps`. Create `electron/server/types.d.ts`:
```typescript
import { AppDeps } from './app'
declare module 'fastify' {
  interface FastifyInstance { appDeps: AppDeps }
  interface FastifyRequest { user?: { email: string; role: 'admin' | 'member' } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/server/app.ts electron/server/types.d.ts electron/server/__tests__/app.test.ts
git commit -m "feat(0b): Fastify app bootstrap + healthz + secure-session"
```

---

### Task 5: Auth routes (login/callback/logout) + guards

**Files:**
- Create: `apps/electron/electron/server/auth.ts`
- Modify: `apps/electron/electron/server/app.ts` (register the auth plugin)
- Test: `apps/electron/electron/server/__tests__/auth.test.ts`

**Interfaces:**
- Consumes: `OidcService`; `getAllowedUser` from `../main/services/database`; `AppDeps`.
- Produces: a Fastify plugin `registerAuth(app)` adding routes `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`, `GET /api/me`; and decorators `app.requireAuth` / `app.requireAdmin` (preHandlers).

- [ ] **Step 1: Write the failing test**

Create `electron/server/__tests__/auth.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function setup(oidcEmail: string) {
  const { createFakeOidc } = await import('../oidc')
  const { buildApp } = await import('../app')
  const db = await import('../main/services/database') // resolved relative to this test file
  return { db, app: await buildApp({
    oidc: createFakeOidc({ email: oidcEmail, emailVerified: true, sub: 'sub-' + oidcEmail }),
    sessionSecret: 'a-very-long-secret-value', adminEmail: 'boss@x.com'
  }) }
}

// Drive login → callback and return the session cookie string.
async function login(app: any) {
  const start = await app.inject({ method: 'GET', url: '/auth/login' })
  const cookie = start.cookies.find((c: any) => c.name === 'hidock_session')
  // Replay the stashed cookie into the callback (state/nonce live in the session).
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=y',
    cookies: { hidock_session: cookie.value } })
  return { cb, sessionCookie: (cb.cookies.find((c: any) => c.name === 'hidock_session') || cookie).value }
}

describe('auth routes', () => {
  let dir: string
  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-auth-'))
    process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin } = await import('../main/services/database')
    await initializeFileStorage(); await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../main/services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true }); delete process.env.HIDOCK_DATA_ROOT
  })

  it('GET /auth/login redirects to the provider', async () => {
    const { app } = await setup('boss@x.com')
    const res = await app.inject({ method: 'GET', url: '/auth/login' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('accounts.google.com')
    await app.close()
  })

  it('an allow-listed user gets a session and /api/me returns their role', async () => {
    const { app } = await setup('boss@x.com')
    const { sessionCookie } = await login(app)
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { hidock_session: sessionCookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ email: 'boss@x.com', role: 'admin' })
    await app.close()
  })

  it('a non-invited user is denied (403) and gets no session', async () => {
    const { app } = await setup('stranger@x.com')
    const { cb } = await login(app)
    expect(cb.statusCode).toBe(403)
    await app.close()
  })

  it('a revoked user is rejected by the guard (401)', async () => {
    const { app, db } = await setup('boss@x.com')
    const { sessionCookie } = await login(app)
    db.setAllowedUserStatus('boss@x.com', 'revoked')
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { hidock_session: sessionCookie } })
    expect(me.statusCode).toBe(401)
    await app.close()
  })
})
```
> Note on imports: this test file lives at `electron/server/__tests__/`, so `../main/...` resolves to `electron/main/...`. Verify the relative depth when writing (`../../main/...` if needed) and adjust.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/server/__tests__/auth.test.ts`
Expected: FAIL — `registerAuth` / routes missing.

- [ ] **Step 3: Write the implementation**

Create `electron/server/auth.ts`:
```typescript
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getAllowedUser } from '../main/services/database'

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const { oidc } = app.appDeps

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
    // run requireAuth first via composition at the route level; here just check role
    if (!req.user || req.user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
  })

  app.get('/auth/login', async (req, reply) => {
    const { redirectUrl, state, nonce, codeVerifier } = await oidc.beginLogin()
    req.session.set('oidc', { state, nonce, codeVerifier })
    return reply.redirect(redirectUrl, 302)
  })

  app.get('/auth/callback', async (req, reply) => {
    const ctx = req.session.get('oidc') as { state: string; nonce: string; codeVerifier: string } | undefined
    if (!ctx) return reply.code(400).send({ error: 'no login in progress' })
    let user
    try {
      const fullUrl = `${app.appDeps ? '' : ''}${req.protocol}://${req.host}${req.url}`
      user = await oidc.completeLogin(fullUrl, ctx)
    } catch {
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
Add to `types.d.ts`:
```typescript
import { preHandlerHookHandler } from 'fastify'
declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler
    requireAdmin: preHandlerHookHandler
  }
}
```
In `app.ts`, after the `app.decorate('appDeps', deps)` line and before `return app`:
```typescript
const { registerAuth } = await import('./auth')
await registerAuth(app)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/auth.test.ts`
Expected: PASS (4 tests). If the callback URL reconstruction trips on host/proto under inject, simplify to `new URL(req.url, app.appDeps ? 'http://localhost' : 'http://localhost').href` — the fake ignores the URL, so any well-formed absolute URL is fine for tests; the real impl needs the true external URL (see Task 7 note on `trustProxy`).

- [ ] **Step 5: Commit**

```bash
git add electron/server/auth.ts electron/server/app.ts electron/server/types.d.ts electron/server/__tests__/auth.test.ts
git commit -m "feat(0b): Google OIDC login/callback/logout + auth guards + invite gate"
```

---

### Task 6: Admin user-management routes

**Files:**
- Create: `apps/electron/electron/server/routes/admin-users.ts`
- Modify: `apps/electron/electron/server/app.ts` (register the admin routes)
- Test: `apps/electron/electron/server/__tests__/admin-users.test.ts`

**Interfaces:**
- Consumes: `requireAuth`/`requireAdmin` (Task 5); `listAllowedUsers`/`upsertAllowedUser`/`setAllowedUserStatus`/`getAllowedUser` from `../../main/services/database`.
- Produces: `registerAdminUsers(app)` adding `GET /api/admin/users`, `POST /api/admin/users`, `PATCH /api/admin/users/:email`, `DELETE /api/admin/users/:email` (each gated by `[requireAuth, requireAdmin]`).

- [ ] **Step 1: Write the failing test**

Create `electron/server/__tests__/admin-users.test.ts` (reuse the `login` helper pattern from `auth.test.ts`; seed two users — an admin `boss@x.com` and a member):
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function build(oidcEmail: string) {
  const { createFakeOidc } = await import('../oidc')
  const { buildApp } = await import('../app')
  return (await import('../app')).buildApp
    ? buildApp({ oidc: createFakeOidc({ email: oidcEmail, emailVerified: true, sub: 's' }),
                 sessionSecret: 'a-very-long-secret-value', adminEmail: 'boss@x.com' })
    : Promise.reject()
}
async function loginAs(app: any) {
  const start = await app.inject({ method: 'GET', url: '/auth/login' })
  const c = start.cookies.find((x: any) => x.name === 'hidock_session')
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x', cookies: { hidock_session: c.value } })
  return (cb.cookies.find((x: any) => x.name === 'hidock_session') || c).value
}

describe('admin users routes', () => {
  let dir: string
  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-admin-')); process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, upsertAllowedUser } = await import('../main/services/database')
    await initializeFileStorage(); await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
    upsertAllowedUser({ email: 'member@x.com', invitedBy: 'boss@x.com' })
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../main/services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true }); delete process.env.HIDOCK_DATA_ROOT
  })

  it('admin can list users', async () => {
    const app = await build('boss@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', cookies: { hidock_session: cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().users.map((u: any) => u.email)).toContain('member@x.com')
    await app.close()
  })

  it('admin can invite, patch role, and revoke', async () => {
    const app = await build('boss@x.com'); const cookie = await loginAs(app)
    const inv = await app.inject({ method: 'POST', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, payload: { email: 'new@x.com' } })
    expect(inv.statusCode).toBe(201)
    const patch = await app.inject({ method: 'PATCH', url: '/api/admin/users/new@x.com',
      cookies: { hidock_session: cookie }, payload: { role: 'admin' } })
    expect(patch.statusCode).toBe(200)
    const del = await app.inject({ method: 'DELETE', url: '/api/admin/users/new@x.com',
      cookies: { hidock_session: cookie } })
    expect(del.statusCode).toBe(200)
    const { getAllowedUser } = await import('../main/services/database')
    expect(getAllowedUser('new@x.com')?.status).toBe('revoked')
  })

  it('a member is forbidden (403)', async () => {
    const app = await build('member@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', cookies: { hidock_session: cookie } })
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
import { listAllowedUsers, upsertAllowedUser, setAllowedUserStatus, getAllowedUser } from '../../main/services/database'

const inviteSchema = z.object({ email: z.string().email(), role: z.enum(['admin', 'member']).optional() })
const patchSchema = z.object({ role: z.enum(['admin', 'member']).optional(), status: z.enum(['active', 'revoked']).optional() })

export async function registerAdminUsers(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin] }

  app.get('/api/admin/users', guard, async () => ({ users: listAllowedUsers() }))

  app.post('/api/admin/users', guard, async (req, reply) => {
    const body = inviteSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid', details: body.error.flatten() })
    upsertAllowedUser({ email: body.data.email, role: body.data.role, invitedBy: req.user!.email })
    return reply.code(201).send({ user: getAllowedUser(body.data.email) })
  })

  app.patch('/api/admin/users/:email', guard, async (req, reply) => {
    const email = (req.params as { email: string }).email
    if (!getAllowedUser(email)) return reply.code(404).send({ error: 'not found' })
    const body = patchSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid', details: body.error.flatten() })
    if (body.data.role) upsertAllowedUser({ email, role: body.data.role })
    if (body.data.status) setAllowedUserStatus(email, body.data.status)
    return reply.send({ user: getAllowedUser(email) })
  })

  app.delete('/api/admin/users/:email', guard, async (req, reply) => {
    const email = (req.params as { email: string }).email
    if (!getAllowedUser(email)) return reply.code(404).send({ error: 'not found' })
    setAllowedUserStatus(email, 'revoked') // soft-delete: revoke, never hard-delete (audit trail)
    return reply.send({ ok: true })
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
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/server/routes/admin-users.ts electron/server/app.ts electron/server/__tests__/admin-users.test.ts
git commit -m "feat(0b): admin user-management routes (invite/role/revoke)"
```

---

### Task 7: Server entry point + scripts

**Files:**
- Create: `apps/electron/electron/server/index.ts`
- Modify: `apps/electron/package.json` (add a `start:server` script)
- Test: `apps/electron/electron/server/__tests__/entry.test.ts`

**Interfaces:**
- Consumes: `bootFoundation` (`../main/boot-foundation`), `getServerConfig`, `createGoogleOidc`, `buildApp`, `ensureBootstrapAdmin`.
- Produces: `startServer(): Promise<FastifyInstance>` (boots foundation, ensures admin, builds app, listens) — exported so the test can call it without `process.env.PORT` collisions by injecting port 0.

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
    const { closeDatabase } = await import('../main/services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    for (const k of ['HIDOCK_DATA_ROOT','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','PUBLIC_URL','SESSION_SECRET','ADMIN_EMAIL','PORT']) delete process.env[k]
  })

  it('boots foundation, seeds the bootstrap admin, and serves /healthz', async () => {
    const { startServer } = await import('../index')
    const app = await startServer()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    const { getAllowedUser } = await import('../main/services/database')
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
  const app = await buildApp({ oidc, sessionSecret: cfg.sessionSecret, adminEmail: cfg.adminEmail })
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  return app
}

// Run when invoked directly (node out/server/index.js)
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  startServer().catch((err) => { console.error('[server] failed to start', err); process.exit(1) })
}
```
> Note: `startServer` uses the REAL `createGoogleOidc`, but the test never triggers a login (only `/healthz`), so no Google network call happens — `discovery()` is lazy. Live OAuth is verified by the operator with real creds.

In `package.json` scripts, add:
```json
"start:server": "node out/server/index.js"
```
(The build that produces `out/server/` is wired in sub-plan 0f; for now `start:server` documents the entry.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/entry.test.ts`
Expected: PASS.

- [ ] **Step 5: Final gate**

Run: `npm run typecheck && npm run test:run`
Expected: PASS (full suite green, including the new server tests and the v34 schema-version updates).

- [ ] **Step 6: Commit**

```bash
git add electron/server/index.ts package.json electron/server/__tests__/entry.test.ts
git commit -m "feat(0b): server entry point (boot foundation + listen) + start:server script"
```

---

## Self-Review

**Spec coverage (§5 Authentication & access control):** Google OIDC → Task 3 (real impl) + Task 5 (routes); `allowed_users` table → Task 2; bootstrap admin via `ADMIN_EMAIL` → Task 2 (`ensureBootstrapAdmin`) + Task 7 (wired at startup); OAuth callback gate (verify → look up → session or deny) → Task 5; admin-only `/api/admin/users` CRUD → Task 6; guarded WS/media — N/A this sub-plan (0c/0d); session cookie attributes → Task 4; `email_verified` check → Task 5. `/healthz` → Task 4.

**Placeholder scan:** No TBD/TODO. The one deliberately-untested unit is the real `createGoogleOidc` (needs live Google creds) — documented as deferred-to-operator, with full real code provided (not a placeholder). The Task 5 callback-URL reconstruction has an explicit fallback note for the inject environment.

**Type consistency:** `OidcService` / `OidcUser` / `LoginContext` are defined in Task 3 and consumed unchanged in Tasks 4–7. `AllowedUser` and the five DB functions defined in Task 2 are consumed with matching signatures in Tasks 5–6. `AppDeps` defined in Task 4, consumed in Tasks 5–7. Session keys `'email'` and `'oidc'` are written/read consistently across Task 5. `requireAuth`/`requireAdmin` decorated in Task 5, consumed in Task 6.

**Risks flagged for the executor:** (1) relative import depth from `electron/server/__tests__/` to `electron/main/...` — verify `../main` vs `../../main` when writing each test; (2) `@fastify/secure-session` v8 API (`session.set/get/delete`) — if the installed major differs, adjust; (3) the real callback needs the true external URL — Task 7's real server should set Fastify `trustProxy: true` when behind NPM (note for 0f); (4) `openid-client` v6 ESM-only — loaded via dynamic import.
