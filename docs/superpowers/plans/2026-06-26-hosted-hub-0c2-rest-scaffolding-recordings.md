# Hosted Hub — Plan 0c-2: REST Scaffolding + Recordings (read / lifecycle / upload)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Establish the REST router scaffolding (typed errors + `setErrorHandler` + registration + test harness) that all of 0c-3…0c-5 reuse, and ship the recordings read/lifecycle endpoints plus a device-independent multipart **upload ingest** so the hosted hub is fillable.

**Architecture:** Thin Fastify controllers call the existing `database.ts`/`file-storage.ts`/`transcription.ts` service functions (unchanged) and `return` data; failures `throw` typed errors mapped to a JSON envelope by one `setErrorHandler`. Reuses 0b's `requireAuth`/`requireSameOrigin` guards and the better-sqlite3 services from 0a.

**Tech Stack:** Fastify 5, `@fastify/multipart` (upload), Zod v4, better-sqlite3, Vitest (`app.inject` + real DB).

## Global Constraints (from the approved 0c design)

- Routers live in `electron/server/routes/<domain>.ts`, registered in `buildApp` after admin routes. **Reads** = `preHandler: [requireAuth]`; **writes/actions** = `[requireAuth, requireSameOrigin]`.
- **Error model:** controllers `return` data on success; on failure `throw` a typed error from `routes/_errors.ts` (`NotFoundError`→404, `BadRequestError`→400, `ConflictError`→409). A Fastify `setErrorHandler` maps these + `ZodError`→400 to `{ error, details? }`; any other throw → `500 { error: 'internal' }` (no message leak). **Status is route-driven — never sniffed from a string.**
- **Result unwrapping is per-route, explicit.** Services return heterogeneous shapes; each controller unwraps its own (`if (!r.success) throw new BadRequestError(r.error); return r.data`) — no global heuristic.
- **Pagination:** list endpoints accept `?limit&offset`; `GET /api/recordings` paginates (default `limit=200`) and returns `{ items, total }`.
- **Body size:** raised `bodyLimit` only where needed (not in this batch except the multipart route, which `@fastify/multipart` bounds via `limits.fileSize`).
- **REST-only** (approved): action endpoints are pragmatic `POST /…/<verb>`; no `/rpc`.
- Services are imported and called directly (module singletons); do NOT re-implement logic. Line length 120; TS strict; Vitest; branch `feat/hosted-knowledge-hub`; run from `apps/electron/`.
- Test harness: every route test reuses `testDeps` from `electron/server/__tests__/app.test.ts`, sets `HIDOCK_DATA_ROOT` to a temp dir, `initializeFileStorage()` + `initializeDatabase()` + `ensureBootstrapAdmin('boss@x.com')`, logs in via the fake-OIDC `login()` cookie helper, and asserts against a real DB.

---

### Task 1: Scaffolding — typed errors + setErrorHandler + recordings router registered

**Files:**
- Create: `electron/server/routes/_errors.ts`
- Modify: `electron/server/app.ts` (register `setErrorHandler`; register the recordings router)
- Create: `electron/server/routes/recordings.ts` (router skeleton — `registerRecordings(app)`, no routes yet beyond a probe used only by the test, then real routes land in Tasks 2–4)
- Test: `electron/server/__tests__/rest-errors.test.ts`

**Interfaces:**
- Produces: `class NotFoundError extends Error`, `class BadRequestError extends Error`, `class ConflictError extends Error` (each with a `statusCode` field); `registerRecordings(app: FastifyInstance): Promise<void>`.

- [ ] **Step 1: Write the failing test** — `electron/server/__tests__/rest-errors.test.ts`
```typescript
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerErrorHandler } from '../routes/_errors'
import { NotFoundError, BadRequestError, ConflictError } from '../routes/_errors'
import { z } from 'zod'

function appWithRoutes() {
  const app = Fastify()
  registerErrorHandler(app)
  app.get('/nf', async () => { throw new NotFoundError('nope') })
  app.get('/br', async () => { throw new BadRequestError('bad') })
  app.get('/cf', async () => { throw new ConflictError('dup') })
  app.get('/zod', async () => { z.object({ a: z.string() }).parse({}); return {} })
  app.get('/boom', async () => { throw new Error('secret detail') })
  app.get('/ok', async () => ({ value: 1 }))
  return app
}

describe('REST error envelope', () => {
  it('maps typed errors + zod to status + {error}', async () => {
    const app = appWithRoutes()
    expect((await app.inject({ url: '/nf' })).statusCode).toBe(404)
    expect((await app.inject({ url: '/br' })).statusCode).toBe(400)
    expect((await app.inject({ url: '/cf' })).statusCode).toBe(409)
    expect((await app.inject({ url: '/zod' })).statusCode).toBe(400)
    const ok = await app.inject({ url: '/ok' }); expect(ok.statusCode).toBe(200); expect(ok.json()).toEqual({ value: 1 })
    await app.close()
  })
  it('maps unexpected throws to 500 without leaking the message', async () => {
    const app = appWithRoutes()
    const res = await app.inject({ url: '/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'internal' })
    expect(JSON.stringify(res.json())).not.toContain('secret detail')
    await app.close()
  })
})
```

- [ ] **Step 2: Run → fail** — `npx vitest run electron/server/__tests__/rest-errors.test.ts` (cannot find `../routes/_errors`).

- [ ] **Step 3: Implement `routes/_errors.ts`**
```typescript
import { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); this.name = new.target.name }
}
export class BadRequestError extends HttpError { constructor(m = 'bad request') { super(400, m) } }
export class NotFoundError extends HttpError { constructor(m = 'not found') { super(404, m) } }
export class ConflictError extends HttpError { constructor(m = 'conflict') { super(409, m) } }

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid', details: err.flatten() })
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message })
    // Fastify's own validation errors carry a statusCode 400
    if ((err as { statusCode?: number }).statusCode === 400) return reply.code(400).send({ error: err.message })
    app.log.error(err)
    return reply.code(500).send({ error: 'internal' })
  })
}
```

- [ ] **Step 4: Create `routes/recordings.ts` skeleton + wire into `app.ts`**

`routes/recordings.ts`:
```typescript
import { FastifyInstance } from 'fastify'

export async function registerRecordings(app: FastifyInstance): Promise<void> {
  // routes added in Tasks 2–4
  void app
}
```
In `app.ts`, after `registerErrorHandler(app)` is called (add that call right after `buildApp` creates `app`, before routes) and after `registerAdminUsers(app)`:
```typescript
import { registerErrorHandler } from './routes/_errors'
// ...near the top of buildApp, after Fastify() is created:
registerErrorHandler(app)
// ...after registerAdminUsers(app):
const { registerRecordings } = await import('./routes/recordings')
await registerRecordings(app)
```

- [ ] **Step 5: Run → pass** — `npx vitest run electron/server/__tests__/rest-errors.test.ts` (2 tests). Also `npx vitest run electron/server/__tests__/app.test.ts` (healthz still green).

- [ ] **Step 6: Commit**
```bash
git add electron/server/routes/_errors.ts electron/server/routes/recordings.ts electron/server/app.ts electron/server/__tests__/rest-errors.test.ts
git commit -m "feat(0c-2): REST scaffolding — typed errors + setErrorHandler + recordings router"
```

---

### Task 2: Recordings reads

**Files:** Modify `routes/recordings.ts`; Test `electron/server/__tests__/recordings.read.test.ts`.

**Endpoints + exact service calls** (all `preHandler: [requireAuth]`):
- `GET /api/recordings?limit&offset&status&quality` → paginate over `getRecordings()` (sort already by date); filter by `status`/`quality` in the controller; return `{ items, total }`. (Default `limit=200`, `offset=0`.)
- `GET /api/recordings/with-transcripts?limit&offset` → `getRecordings()` mapped with `getTranscriptByRecordingId(id)` → `{ items: RecordingWithTranscript[], total }`.
- `GET /api/recordings/:id` → `getRecordingById(id)`; if undefined `throw new NotFoundError()`; else return it.

- [ ] **Step 1: Write the failing test** (`recordings.read.test.ts`) — seed 3 recordings via `insertRecording(...)`, log in, then:
```typescript
// list paginated
const r = await app.inject({ method: 'GET', url: '/api/recordings?limit=2&offset=0', cookies: { hidock_session: cookie } })
expect(r.statusCode).toBe(200)
expect(r.json().total).toBe(3); expect(r.json().items).toHaveLength(2)
// filter by status
expect((await app.inject({ url: '/api/recordings?status=ready', cookies:{hidock_session:cookie} })).json().items.every((x:any)=>x.status==='ready')).toBe(true)
// getById 404
expect((await app.inject({ url: '/api/recordings/does-not-exist', cookies:{hidock_session:cookie} })).statusCode).toBe(404)
// getById 200
expect((await app.inject({ url: `/api/recordings/${seededId}`, cookies:{hidock_session:cookie} })).json().id).toBe(seededId)
// unauthenticated → 401
expect((await app.inject({ url: '/api/recordings' })).statusCode).toBe(401)
```
(Use the `login()` cookie helper + `testDeps` per Global Constraints. Inspect `insertRecording`'s required fields from `database.ts` to seed valid rows.)

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement the three read routes** in `registerRecordings`:
```typescript
import { getRecordings, getRecordingById, getTranscriptByRecordingId } from '../../main/services/database'
import { NotFoundError } from './_errors'
import { z } from 'zod'

const listQ = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().optional(),
  quality: z.string().optional()
})

app.get('/api/recordings', { preHandler: [app.requireAuth] }, async (req) => {
  const q = listQ.parse(req.query)
  let rows = getRecordings()
  if (q.status) rows = rows.filter((r) => r.status === q.status)
  if (q.quality) rows = rows.filter((r) => (r as { quality_rating?: string }).quality_rating === q.quality)
  return { items: rows.slice(q.offset, q.offset + q.limit), total: rows.length }
})

app.get('/api/recordings/with-transcripts', { preHandler: [app.requireAuth] }, async (req) => {
  const q = listQ.parse(req.query)
  const rows = getRecordings()
  const page = rows.slice(q.offset, q.offset + q.limit)
  return { items: page.map((r) => ({ ...r, transcript: getTranscriptByRecordingId(r.id) })), total: rows.length }
})

app.get('/api/recordings/:id', { preHandler: [app.requireAuth] }, async (req) => {
  const { id } = req.params as { id: string }
  const rec = getRecordingById(id)
  if (!rec) throw new NotFoundError('recording not found')
  return rec
})
```
> Route order: register `/api/recordings/with-transcripts` BEFORE `/api/recordings/:id` so the literal path isn't captured by the param route (Fastify's router actually prioritizes static over param, but keep them ordered for clarity).

- [ ] **Step 4: Run → pass. Step 5: Commit** `feat(0c-2): recordings read endpoints (list paginated, with-transcripts, getById)`.

---

### Task 3: Recordings lifecycle (update / delete / link / candidates)

**Files:** Modify `routes/recordings.ts`; Test `electron/server/__tests__/recordings.lifecycle.test.ts`.

**Endpoints** (writes/actions → `[requireAuth, requireSameOrigin]`; exact service calls from the mapping):
- `PATCH /api/recordings/:id` body `{ status?, transcriptionStatus? }` → `updateRecordingStatus(id,status)` and/or `updateRecordingTranscriptionStatus(id,transcriptionStatus)`; then return `getRecordingById(id)` (404 if absent).
- `DELETE /api/recordings/:id` → `getRecordingById`; if absent 404; else `deleteRecording(rec.file_path)` (file-storage) → `updateRecordingStatus(id,'deleted')` → `deleteLabelEmbeddingsForRecording(id)` → `deleteWindowEmbeddingsForRecording(id)`; return `{ ok: true }`.
- `POST /api/recordings/batch-delete` body `{ ids }` → loop the delete logic; return `{ deleted, failed, errors }`.
- `POST /api/recordings/:id/link-meeting` body `{ meetingId, confidence?, method? }` → `linkRecordingToMeeting(id, meetingId, confidence ?? 1.0, method ?? 'manual')`; return `getRecordingById(id)`.
- `POST /api/recordings/:id/unlink-meeting` → `linkRecordingToMeeting(id, '', 0, '')`; return `getRecordingById(id)`.
- `POST /api/recordings/:id/select-meeting` body `{ meetingId: string | null }` → if null `linkRecordingToMeeting(id,'',0,'')` else `linkRecordingToMeeting(id, meetingId, 1.0, 'manual')`; return `getRecordingById(id)`.
- `GET /api/recordings/:id/candidates` → `getCandidatesForRecordingWithDetails(id)`.
- `GET /api/recordings/meetings-near-date?date=` → `getMeetingsNearDate(date)`.

- [ ] **Step 1: Failing test** — seed a recording (+ a meeting for link tests), log in, then assert: PATCH status persists (re-GET shows it); DELETE returns ok + getById→404 after; batch-delete returns counts; link-meeting sets `meeting_id` (re-GET); select-meeting null clears it; unauthenticated PATCH → 401; foreign-Origin PATCH → 403 (reuses `requireSameOrigin`). Use real DB assertions (`getRecordingById` after).
- [ ] **Step 2: Run → fail. Step 3: Implement** the routes above with Zod body schemas; throw `NotFoundError` where the entity is absent. **Step 4: Run → pass. Step 5: Commit** `feat(0c-2): recordings lifecycle (update/delete/batch/link/candidates)`.

---

### Task 4: Upload ingest (`POST /api/recordings/upload`)

**Files:** Modify `package.json` (`@fastify/multipart`), `app.ts` (register the plugin), `routes/recordings.ts`; Test `electron/server/__tests__/recordings.upload.test.ts`.

**Behavior:** accept one multipart audio file → save bytes via `saveRecording(filename, buffer)` (reuses collision handling + `.hda`→`.wav`) → `insertRecording({ id: randomUUID(), filename, file_path, date_recorded: now, status: 'ready', location: 'local-only', transcription_status: 'none', source: 'upload', is_imported: 1, ...other required fields per the Recording type })` → if `?enqueue=1`: `addToQueue(id)` + `processQueueManually()` (fire-and-forget) → return `{ recording: getRecordingById(id) }` with `201`. Reject non-audio extensions with `BadRequestError`. Bound size via `@fastify/multipart` `limits.fileSize`.

- [ ] **Step 1: Install** `npm install @fastify/multipart`.
- [ ] **Step 2: Failing test** — log in, build a multipart body with a small fake `.wav` buffer (use `app.inject` `payload` + `Content-Type: multipart/form-data` with a boundary, or the `form-data` package if already available; otherwise construct the multipart body manually), POST to `/api/recordings/upload`, assert `201` + a recording row exists in the DB (`getRecordings()` length grew, file exists under `getRecordingsPath()`), and a non-audio file → 400. Confirm `requireAuth` (no cookie → 401).
- [ ] **Step 3: Register `@fastify/multipart`** in `buildApp` (after `@fastify/websocket`), and implement the upload route in `registerRecordings`. Inspect the `Recording` type + `insertRecording`'s required columns from `database.ts` to populate all NOT-NULL fields; reuse `saveRecording`/`getRecordingsPath` from `file-storage.ts` and `addToQueue` (database) + `processQueueManually` (transcription).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Final gate** — `npm run typecheck && npm run test:run` → PASS (full suite green).
- [ ] **Step 6: Commit** `feat(0c-2): multipart audio upload ingest (POST /api/recordings/upload)`.

---

## Self-Review (antagonistic pass)

**Spec coverage:** scaffolding (errors+handler+registration+harness) → Task 1; recordings reads (paginated list, with-transcripts, getById-404) → Task 2; lifecycle (patch/delete/batch/link/unlink/select/candidates/near-date) → Task 3; upload ingest → Task 4. The `0c design` recordings rows are all covered except the meeting-scoped `GET /api/meetings/:id/recordings` (deferred to the 0c-3 meetings router; `?meetingId` filter is not added here to avoid overloading the list — flagged).

**Type/asset consistency:** controllers call the exact service fns from the verified mapping (`getRecordings`, `getRecordingById`, `getRecordingsForMeeting`/`getTranscriptByRecordingId`, `updateRecordingStatus`, `updateRecordingTranscriptionStatus`, `deleteRecording`+`deleteLabel/WindowEmbeddingsForRecording`, `linkRecordingToMeeting`, `getCandidatesForRecordingWithDetails`, `getMeetingsNearDate`, `insertRecording`, `saveRecording`, `addToQueue`, `processQueueManually`). `registerErrorHandler`/`registerRecordings` consumed in `app.ts`.

**Risks flagged for the executor:**
1. **`insertRecording` required columns.** The upload route must populate every NOT-NULL `Recording` column or the insert throws. Read the `recordings` schema + the `Recording` type before writing the insert; mirror `addExternal`'s field defaults (`status:'ready'`, `location:'local-only'`, `transcription_status:'none'`, `source:'upload'/'external'`, `is_imported:1`).
2. **`registerErrorHandler` placement.** It must be registered on the app instance once, early in `buildApp` (a Fastify instance has one error handler). Confirm it doesn't clobber an existing handler and that the WS route's pre-upgrade errors still surface (they use Fastify's normal path).
3. **Multipart test construction.** `app.inject` multipart bodies are fiddly; if `form-data` isn't available, build the body string manually with an explicit boundary, or add `form-data` as a devDep. Don't weaken the test to skip the actual file bytes.
4. **`deleteRecording` is file-storage (returns boolean) — not a DB call.** The delete controller does file delete + DB status flip + embedding cleanup (4 calls), matching the IPC handler exactly; don't shortcut to a single DB delete.
5. **`processQueueManually()` is fire-and-forget** in the upload path — do not `await` it in the request (it processes the queue async); return `201` immediately after enqueue.
6. **`requireSameOrigin` on writes** — the lifecycle + upload routes are mutations; include it in the preHandler so the foreign-Origin test passes.
