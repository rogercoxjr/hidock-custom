# Hosted Hub — Plan 0c-1: WebSocket Event Broadcaster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Electron `webContents.send` event channel with an injectable `Broadcaster` backed by an authenticated Fastify WebSocket endpoint, de-Electroning every server-originated-event site.

**Architecture:** A tiny `broadcaster.ts` registry (interface + `set/getBroadcaster`, no-op default) lets main-process services emit events without knowing the transport. Every current `webContents.send(channel, payload)` / `setMainWindow*` site switches to `getBroadcaster().broadcast(channel, payload)`. The hosted server registers `@fastify/websocket`, exposes an auth-gated `/ws` route, and installs a `WsBroadcaster` that fans `{channel, payload}` JSON out to all connected (authenticated) clients. The renderer's WS subscription is 0e; the REST routers that emit progress are 0c-2+.

**Tech Stack:** Fastify 5, `@fastify/websocket`, better-sqlite3/0a + 0b server, Vitest (`app.injectWS` + fake broadcaster).

## Global Constraints

- **`Broadcaster` interface:** `{ broadcast(channel: string, payload: unknown): void }`. Registry in `electron/main/services/broadcaster.ts`: `setBroadcaster(b: Broadcaster | null): void`, `getBroadcaster(): Broadcaster` (returns a **no-op** when unset, so services never crash pre-wire or in headless tests).
- **WS endpoint:** `GET /ws`, `{ websocket: true }`, gated by an auth `preValidation` (reuse `app.requireAuth`) — an unauthenticated upgrade is rejected **401** before the socket opens. Wire message format: `JSON.stringify({ channel, payload })`.
- **`@fastify/websocket` MUST be registered before any route** (per the plugin docs) — register it first in `buildApp`, before `/healthz`/auth/admin.
- **No global-state leak in tests:** `buildApp` installs the `WsBroadcaster` via `setBroadcaster(...)` on registration and clears it via `setBroadcaster(null)` in an `onClose` hook.
- **De-Electron is grep-driven, not a fixed list.** Enumerate EVERY `webContents.send(` and `setMainWindow`/`getAllWindows()` site under `electron/main`. Known sites: `event-bus.ts` (`'domain-event'`), `recording-watcher.ts` (`'recording:new'`), `transcription.ts` (`'transcription:*'`), `download-service.ts` (`'download-service:state-update'`), `activity-log.ts` (`'activity-log:entry'`), plus the `setMainWindowFor{Migration,Speakers}` consumers wired in `index.ts` and any others the grep finds. Convert ALL; remove the `setMainWindow*` setters and their `electron/main/index.ts` call sites.
- **`event-bus.ts` keeps `sanitizeEventPayload`** — sanitize before `broadcast('domain-event', sanitized)`.
- The Electron `index.ts` is fully removed in 0e; here, only delete the now-dangling `setMainWindow*` imports/calls so typecheck stays green. Leave the rest of `index.ts` alone.
- Line length 120; TS strict; Vitest; branch `feat/hosted-knowledge-hub`; run from `apps/electron/`. Device sync, REST domain routers (0c-2+), renderer (0e), Docker (0f) are OUT of scope.

---

### Task 1: `@fastify/websocket` dependency + broadcaster registry

**Files:**
- Modify: `apps/electron/package.json`
- Create: `apps/electron/electron/main/services/broadcaster.ts`
- Test: `apps/electron/electron/main/services/__tests__/broadcaster.test.ts`

**Interfaces:**
- Produces: `interface Broadcaster { broadcast(channel: string, payload: unknown): void }`; `setBroadcaster(b: Broadcaster | null): void`; `getBroadcaster(): Broadcaster`.

- [ ] **Step 1: Install the dependency**

Run: `npm install @fastify/websocket`
Expected: added under `dependencies`.

- [ ] **Step 2: Write the failing test**

Create `electron/main/services/__tests__/broadcaster.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { getBroadcaster, setBroadcaster } from '../broadcaster'

describe('broadcaster registry', () => {
  afterEach(() => setBroadcaster(null))

  it('returns a no-op broadcaster when none is set (no throw)', () => {
    expect(() => getBroadcaster().broadcast('x', { a: 1 })).not.toThrow()
  })

  it('routes broadcast() to the active broadcaster', () => {
    const calls: Array<{ channel: string; payload: unknown }> = []
    setBroadcaster({ broadcast: (channel, payload) => calls.push({ channel, payload }) })
    getBroadcaster().broadcast('transcription:progress', { recordingId: 'r1', percent: 42 })
    expect(calls).toEqual([{ channel: 'transcription:progress', payload: { recordingId: 'r1', percent: 42 } }])
  })

  it('setBroadcaster(null) reverts to the no-op', () => {
    setBroadcaster({ broadcast: () => { throw new Error('should not be called') } })
    setBroadcaster(null)
    expect(() => getBroadcaster().broadcast('x', 1)).not.toThrow()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/broadcaster.test.ts`
Expected: FAIL — cannot find module `../broadcaster`.

- [ ] **Step 4: Write the implementation**

Create `electron/main/services/broadcaster.ts`:
```typescript
/**
 * Transport-agnostic event broadcaster. Main-process services emit
 * server-originated events through getBroadcaster().broadcast(channel, payload)
 * without knowing the transport. The hosted server installs a WebSocket-backed
 * implementation (see electron/server/ws.ts); unset (or headless tests) → no-op.
 */
export interface Broadcaster {
  broadcast(channel: string, payload: unknown): void
}

const NOOP: Broadcaster = { broadcast: () => { /* no transport wired */ } }

let active: Broadcaster | null = null

export function setBroadcaster(b: Broadcaster | null): void {
  active = b
}

export function getBroadcaster(): Broadcaster {
  return active ?? NOOP
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/main/services/__tests__/broadcaster.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json electron/main/services/broadcaster.ts electron/main/services/__tests__/broadcaster.test.ts
git commit -m "feat(0c-1): @fastify/websocket dep + broadcaster registry"
```

---

### Task 2: De-Electron every event-send site to use the broadcaster

**Files:**
- Modify: `apps/electron/electron/main/services/event-bus.ts`, `recording-watcher.ts`, `transcription.ts`, `download-service.ts`, `activity-log.ts`, and any other site the enumeration finds (e.g. `ipc/migration-handlers.ts`, `ipc/speakers-handlers.ts`).
- Modify: `apps/electron/electron/main/index.ts` (remove dangling `setMainWindow*` imports + calls).
- Test: `apps/electron/electron/main/services/__tests__/event-bus.broadcast.test.ts`

**Interfaces:**
- Consumes: `getBroadcaster` (Task 1).
- Produces: all five+ services emit via `getBroadcaster().broadcast(channel, payload)`; the `setMainWindow*` setters are deleted.

- [ ] **Step 1: Enumerate every send/setMainWindow site**

Run:
```bash
grep -rnE "webContents\.send\(|setMainWindow|getAllWindows\(\)|BrowserWindow" electron/main --include="*.ts" | grep -v "__tests__"
```
Record every hit. (Known: event-bus, recording-watcher, transcription, download-service, activity-log, migration-handlers, speakers-handlers.) Each is converted below; none may remain after this task except inside `index.ts`'s own window creation (which 0e removes).

- [ ] **Step 2: Write the failing test**

Create `electron/main/services/__tests__/event-bus.broadcast.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getEventBus } from '../event-bus'
import { setBroadcaster } from '../broadcaster'

describe('event-bus broadcasts via the broadcaster', () => {
  const calls: Array<{ channel: string; payload: any }> = []
  beforeEach(() => { calls.length = 0; setBroadcaster({ broadcast: (channel, payload) => calls.push({ channel, payload: payload as any }) }) })
  afterEach(() => setBroadcaster(null))

  it('emitDomainEvent sends a sanitized domain-event over the broadcaster', () => {
    getEventBus().emitDomainEvent({
      type: 'storage:tier-assigned', timestamp: '',
      payload: { recordingId: 'r1', tier: 'cold', reason: 'C:\\\\Users\\\\me\\\\secret.wav too old' }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].channel).toBe('domain-event')
    expect(calls[0].payload.type).toBe('storage:tier-assigned')
    // sanitize still applied: absolute path scrubbed to [path]
    expect(calls[0].payload.payload.reason).toContain('[path]')
    expect(calls[0].payload.payload.reason).not.toContain('secret.wav')
  })

  it('emitDomainEvent still notifies in-process listeners', () => {
    let seen = 0
    const off = getEventBus().onDomainEvent('quality:assessed', () => { seen++ })
    getEventBus().emitDomainEvent({ type: 'quality:assessed', timestamp: '', payload: { recordingId: 'r1', quality: 'high', assessmentMethod: 'auto', confidence: 1 } })
    off()
    expect(seen).toBe(1)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/event-bus.broadcast.test.ts`
Expected: FAIL — event-bus still uses `webContents.send`/`mainWindow`, never calls the broadcaster.

- [ ] **Step 4: Convert `event-bus.ts`**

Replace the Electron coupling:
```typescript
// BEFORE
import { EventEmitter } from 'events'
import { BrowserWindow } from 'electron'
...
class DomainEventBus extends EventEmitter {
  private mainWindow: BrowserWindow | null = null
  ...
  setMainWindow(window: BrowserWindow): void { this.mainWindow = window }
  emitDomainEvent<T extends DomainEvent>(event: T): void {
    ...
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const sanitized = sanitizeEventPayload(enrichedEvent)
      this.mainWindow.webContents.send('domain-event', sanitized)
    }
    ...
  }
}
export function setMainWindowForEventBus(window: BrowserWindow): void { getEventBus().setMainWindow(window) }
```
```typescript
// AFTER
import { EventEmitter } from 'events'
import { getBroadcaster } from './broadcaster'
...
class DomainEventBus extends EventEmitter {
  // (no mainWindow field, no setMainWindow)
  ...
  emitDomainEvent<T extends DomainEvent>(event: T): void {
    ...
    getBroadcaster().broadcast('domain-event', sanitizeEventPayload(enrichedEvent))
    ...
  }
}
// setMainWindowForEventBus removed
```

- [ ] **Step 5: Convert the other sites (same mechanical pattern)**

For `recording-watcher.ts` and `transcription.ts`: their private `notifyRenderer(channel, data)` becomes `getBroadcaster().broadcast(channel, data)`; delete the `setMainWindow`/`setMainWindowForTranscription` setters and the `mainWindow` field. For `download-service.ts` and `activity-log.ts`: replace the `BrowserWindow.getAllWindows().forEach(w => w.webContents.send(channel, payload))` loop with `getBroadcaster().broadcast(channel, payload)`. For `ipc/migration-handlers.ts` and `ipc/speakers-handlers.ts` (and anything else Step 1 found): same — `setMainWindowFor*` setter deleted, the `webContents.send` swapped to `getBroadcaster().broadcast(...)`. Remove every `import { BrowserWindow } from 'electron'` that becomes unused.

- [ ] **Step 6: Update `electron/main/index.ts`**

Remove the now-deleted setter imports and their call sites: `setWatcherMainWindow`, `setMainWindowForTranscription`, `setMainWindowForEventBus`, `setMainWindowForMigration`, `setMainWindowForSpeakers` (and any other Step-1 setter). Leave the rest of `index.ts` (window creation, USB session, `startRecordingWatcher()`/`startTranscriptionProcessor()`) untouched — those are removed in 0e.

- [ ] **Step 7: Verify no send-sites remain + typecheck**

Run:
```bash
grep -rnE "webContents\.send\(|setMainWindow" electron/main --include="*.ts" | grep -v "__tests__" | grep -v "index.ts" || echo "clean"
npm run typecheck
```
Expected: grep `clean` (only `index.ts`'s own window code may reference `webContents`, not `.send`); typecheck PASS. If a test elsewhere references a deleted `setMainWindow*`, update it.

- [ ] **Step 8: Run the event-bus test + affected service suites**

Run: `npx vitest run electron/main/services/__tests__/event-bus.broadcast.test.ts electron/main/services electron/main/ipc`
Expected: PASS. Fix any test that mocked a deleted setter.

- [ ] **Step 9: Commit**

```bash
git add electron/main/services electron/main/ipc/migration-handlers.ts electron/main/ipc/speakers-handlers.ts electron/main/index.ts electron/main/services/__tests__/event-bus.broadcast.test.ts
git commit -m "feat(0c-1): de-electron event sites onto the broadcaster registry"
```
(Add any other files Step 1 surfaced.)

---

### Task 3: Authenticated WebSocket endpoint + `WsBroadcaster`, wired into `buildApp`

**Files:**
- Create: `apps/electron/electron/server/ws.ts`
- Modify: `apps/electron/electron/server/app.ts` (register `@fastify/websocket` first; call `registerWs` after auth; clear broadcaster on close)
- Test: `apps/electron/electron/server/__tests__/ws.test.ts`

**Interfaces:**
- Consumes: `setBroadcaster`/`Broadcaster` (Task 1); `app.requireAuth` (0b); `app.injectWS` (plugin-decorated).
- Produces: `registerWs(app: FastifyInstance): Promise<void>` — registers the `/ws` route, builds a `WsBroadcaster` over `app.websocketServer.clients`, installs it via `setBroadcaster`, and clears it on `app.onClose`.

- [ ] **Step 1: Write the failing test**

Create `electron/server/__tests__/ws.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'
import { getBroadcaster } from '../../main/services/broadcaster'

async function makeApp(email: string) {
  return buildApp(testDeps({ oidc: createFakeOidc({ email, emailVerified: true, sub: 's' }) }))
}
async function loginCookie(app: Awaited<ReturnType<typeof buildApp>>) {
  const start = await app.inject({ method: 'GET', url: '/auth/login' })
  const c = start.cookies.find((x) => x.name === 'hidock_session')!
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x', cookies: { hidock_session: c.value } })
  return (cb.cookies.find((x) => x.name === 'hidock_session') ?? c).value
}

describe('WebSocket broadcaster', () => {
  let dir: string
  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-ws-')); process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin } = await import('../../main/services/database')
    await initializeFileStorage(); await initializeDatabase(); ensureBootstrapAdmin('boss@x.com')
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../../main/services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true }); delete process.env.HIDOCK_DATA_ROOT
  })

  it('rejects an unauthenticated upgrade (401)', async () => {
    const app = await makeApp('boss@x.com'); await app.ready()
    await expect(app.injectWS('/ws')).rejects.toBeTruthy() // upgrade refused before open
    await app.close()
  })

  it('an authenticated client receives a broadcast', async () => {
    const app = await makeApp('boss@x.com'); await app.ready()
    const cookie = await loginCookie(app)
    const ws = await app.injectWS('/ws', { headers: { cookie: `hidock_session=${cookie}` } })
    const got = new Promise<string>((resolve) => ws.on('message', (d) => resolve(d.toString())))
    getBroadcaster().broadcast('transcription:progress', { recordingId: 'r1', percent: 50 })
    const msg = JSON.parse(await got)
    expect(msg).toEqual({ channel: 'transcription:progress', payload: { recordingId: 'r1', percent: 50 } })
    ws.terminate(); await app.close()
  })

  it('clears the broadcaster on app close (back to no-op)', async () => {
    const app = await makeApp('boss@x.com'); await app.ready()
    await app.close()
    expect(() => getBroadcaster().broadcast('x', 1)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/server/__tests__/ws.test.ts`
Expected: FAIL — `/ws` 404 / `injectWS` undefined (plugin not registered).

- [ ] **Step 3: Write `ws.ts`**

Create `electron/server/ws.ts`:
```typescript
import { FastifyInstance } from 'fastify'
import { setBroadcaster, Broadcaster } from '../main/services/broadcaster'

export async function registerWs(app: FastifyInstance): Promise<void> {
  // Auth-gated upgrade: requireAuth runs as preValidation (before the socket opens);
  // an unauthenticated/ revoked request is rejected 401 and never upgraded.
  app.get('/ws', { websocket: true, preValidation: [app.requireAuth] }, (socket) => {
    // No inbound protocol yet (server→client push only). Keep the socket open;
    // attach a no-op message handler so backpressure does not pause it.
    socket.on('message', () => { /* reserved for future client→server messages */ })
  })

  const wsBroadcaster: Broadcaster = {
    broadcast(channel, payload) {
      const data = JSON.stringify({ channel, payload })
      for (const client of app.websocketServer.clients) {
        if (client.readyState === 1 /* OPEN */) client.send(data)
      }
    }
  }
  setBroadcaster(wsBroadcaster)
  app.addHook('onClose', async () => { setBroadcaster(null) })
}
```

- [ ] **Step 4: Wire into `app.ts`**

`@fastify/websocket` must be registered BEFORE any route. In `buildApp`, register it right after `secure-session` and before `/healthz`:
```typescript
import websocket from '@fastify/websocket'
...
await app.register(secureSession, { /* ...existing... */ })
await app.register(websocket)            // before any route
app.decorate('appDeps', deps)
app.get('/healthz', async () => ({ status: 'ok' }))
const { registerAuth } = await import('./auth')
await registerAuth(app)                  // decorates requireAuth (used by /ws)
const { registerWs } = await import('./ws')
await registerWs(app)
const { registerAdminUsers } = await import('./routes/admin-users')
await registerAdminUsers(app)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/ws.test.ts`
Expected: PASS (3 tests). If `injectWS` on an unauthenticated upgrade resolves instead of rejecting, assert on the close/401 the plugin surfaces in your installed version and adjust the assertion to match real behavior (do NOT weaken — confirm the upgrade is genuinely refused for no/invalid cookie).

- [ ] **Step 6: Final gate**

Run: `npm run typecheck && npm run test:run`
Expected: PASS (full suite green).

- [ ] **Step 7: Commit**

```bash
git add electron/server/ws.ts electron/server/app.ts electron/server/__tests__/ws.test.ts
git commit -m "feat(0c-1): authenticated /ws endpoint + WsBroadcaster wired into buildApp"
```

---

## Self-Review

**Spec coverage:** Broadcaster abstraction → Task 1; de-Electron all send-sites + remove setMainWindow*/index.ts → Task 2 (grep-enumerated, not a fixed 5); authenticated WS endpoint + WsBroadcaster + buildApp wiring + clear-on-close → Task 3. Renderer WS subscription is 0e; event-emitting REST routers are 0c-2+ (out of scope).

**Placeholder scan:** none. The de-Electron of the 4 non-event-bus services is specified as a mechanical pattern (their exact `notifyRenderer`/`getAllWindows` bodies are read at implementation time) gated by a grep-clean + typecheck + full suite — not a placeholder.

**Type consistency:** `Broadcaster`/`setBroadcaster`/`getBroadcaster` defined in Task 1, consumed in Tasks 2 and 3. `registerWs` defined in Task 3, called in `app.ts`. The WS route reuses `app.requireAuth` (0b decorator). Message shape `{channel, payload}` is produced by `WsBroadcaster` (Task 3) and asserted by the Task 3 test.

**Risks flagged for the executor (antagonistic pass):**
1. **Blast radius > 5 sites.** `index.ts` wires `setMainWindowFor{Migration,Speakers}` too — Step 1's grep is authoritative; convert every hit, not just the five named services. Expect existing tests that stub a deleted setter to need updating (Task 2 Step 8).
2. **`requireAuth` as `preValidation` on a WS route.** It's an `async (req, reply)` that replies 401 — valid in the `preValidation` slot, and the plugin runs pre-upgrade hooks before opening the socket. The unauthenticated-upgrade test is the proof; if the installed plugin surfaces the refusal differently (reject vs. immediate close), match the real behavior without weakening the "upgrade refused" guarantee.
3. **`app.websocketServer.clients` membership.** Broadcasting iterates the raw `ws` server client set; only `readyState === OPEN` clients are sent to. This includes the `/ws` clients (the only WS route). Fine for one route; revisit if more WS routes appear.
4. **Global broadcaster vs. test isolation.** `setBroadcaster` is a module singleton; `buildApp` sets it on register and clears on `onClose`. Tests build one app each + `vi.resetModules()`, so no cross-test bleed — but two concurrently-open apps in one test would share the singleton (not done here).
5. **`@fastify/websocket` register order.** Must precede all routes or it won't intercept upgrades — registered immediately after `secure-session` in `buildApp`.
