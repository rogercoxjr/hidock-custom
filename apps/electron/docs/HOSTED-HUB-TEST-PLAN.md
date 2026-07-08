# HiDock Hosted Hub — Comprehensive Test Plan

**Status:** living document · created 2026-07-07 · owner: hosted-hub track
**Scope:** the hosted knowledge hub — the `apps/electron` renderer served as a browser SPA + the headless Fastify server (`electron/server`), running under plain Node in Docker. Electron-desktop mode is out of scope (superseded; see the audit doc).

---

## 0. Why this plan exists — the failure mode it must close

Across this project's live testing, one defect class recurred again and again:

> **Each side's unit tests pass in isolation while the boundary between them drifts.**

Concretely, defects that shipped green:
- SDK sends `{recordingIds}`, route's zod wants `{ids}` → **400**, feature silently dead.
- Route returns `{items,total}`, SDK returns `r.data` unwrapped → **`x is not iterable` / `undefined.map`**.
- SDK posts `/api/rag/session/clear`, route is `/api/rag/sessions/:id/clear` → **404**.
- Renderer calls a **Phase-1 stub** (`downloadService.*`) that rejects `device path is Phase 1` → frozen UI.
- A route dynamically imports a service that imports **`electron`** → runtime crash in hosted Node (voiceprint).
- The **transcription processor** interval is started by Electron's main process but **not by the hosted server** → queued items stick at `pending`.
- Renderer unit tests **mock `window.electronAPI`**, so they can never catch any of the above — the mock is a fiction the real server doesn't honor.

**The mission of this plan:** make every one of those classes fail in **CI or a local pre-commit gate**, not in the user's browser. The single highest-ROI addition is **Layer 2 (Contract tests)** — see §3.

A regression table mapping every defect found this session to the layer that now catches it is in **§9**.

---

## 1. Test-layer overview

| Layer | Name | Catches | Automatable | Runs in CI |
|------|------|---------|-------------|-----------|
| 0 | Static & build gates | type errors, lint, electron on boot path, electron **reachable from routes**, missing SPA build | ✅ | ✅ |
| 1 | Unit | pure logic per module/function | ✅ | ✅ |
| 2 | **Contract (SDK↔route)** | request-key / query / path / response-envelope / error-shape **drift** | ✅ | ✅ |
| 3 | Server integration / E2E (inject) | full request→DB→response flows, error codes, auth gates | ✅ | ✅ |
| 4 | Hosted-mode invariant guards | boot wiring, registration/composition completeness, stub reachability, single-device, SPA serving | ✅ | ✅ |
| 5 | Renderer component / hook | UI behavior, state, event handling (against a mocked facade) | ✅ | ✅ |
| 6 | Manual live (device + OAuth) | real WebUSB device, real Google login, real large-file upload, real browser | ❌ (human) | ❌ (pre-release checklist) |

**Golden rule:** Layers 1 and 5 mock the boundary and therefore **cannot** catch contract drift. Layer 2 is the only automated layer that exercises the SDK and the route **against each other**. Do not let Layer 2 rot.

---

## 2. Layer 0 — Static & build gates

Cheap, fast, run first (and in pre-commit).

| Gate | Command (from `apps/electron/`) | Catches |
|------|----------------------------------|---------|
| Type check | `npm run typecheck` (node + web tsconfigs) | type/shape errors, missing exports |
| Lint | `npm run lint` (0 errors) | unused vars, `no-empty-function`, style |
| Server bundle + boot-path electron audit | `npm run build:server` → prints `no boot-path "electron" imports` | electron on the **static boot graph** |
| **Electron-reachability (NEW)** | `npm run test:run -- electron/server/__tests__/electron-reachability.test.ts` | electron reachable from a route via **static OR dynamic** import (voiceprint-class); see §4 G1b |
| SPA build | `npm run build` → `test -f out/renderer/index.html` | broken renderer build |
| Docker build | `docker compose build` | image assembly, native-deps ABI (node:22), `HIDOCK_SPA_DIR` |

**Note:** the existing `build:server` audit only inspects the *static* boot graph. The voiceprint leak proved electron can enter via a **route's dynamic import** — Layer 0 must add the reachability test (§4 G1b), which walks each route's transitive import graph including `import()` targets.

---

## 3. Layer 2 — Contract tests (SDK ↔ route) — **the centerpiece**

### 3.1 The harness
Drive each SDK group's methods against the **real** `buildApp()` Fastify instance so the SDK and the route are exercised **together**:

- A `contract-harness.ts` test util that:
  1. builds the app with `buildApp({ oidc: createFakeOidc(...), ... })` (the fake OIDC already exists in `oidc.ts`) against a **temp DB** (seeded fixtures).
  2. logs in (fake OIDC → session cookie) and injects an allowed admin user.
  3. shims the SDK's `http` transport (`http.ts`) so `fetch(path, init)` is routed to `app.inject({ method, url: path, payload, headers, cookies })` instead of a real network — i.e. the **real SDK code** runs against the **real route code** in-process.
- Per group: `src/lib/electron-api/__tests__/<group>.contract.test.ts` that calls each SDK method and asserts:

| Assertion | Catches |
|-----------|---------|
| happy path returns 2xx (never 400/404/405) | request-key / query / path / verb drift |
| returned value is the **unwrapped/typed** shape the consumer expects (array, not `{items,total}`) | response-envelope drift |
| a deliberately-bad call surfaces the error per the SDK's contract (RESULT `{success:false}` vs thrown) | error-shape drift |
| for paginated lists: `total` honored, `.items` unwrapped, empty → `[]` | envelope + empty-state |

### 3.2 Coverage matrix (every SDK method must appear)
Build the matrix in the harness dir as `CONTRACT-MATRIX.md`: rows = every method of every group in `src/lib/electron-api/groups/*.ts`; columns = `path`, `verb`, `route file:line`, `request asserted`, `response asserted`, `error asserted`. A method with a blank cell is a coverage hole.

### 3.3 Why this is worth the cost
Every contract defect this session (`transcripts.getByRecordingIds`, `knowledge/actionables/projects.getAll`, `assistant.getConversations`, `calendar.toggleAutoSync`, `quality.batchAutoAssess`, `rag.removeLastMessages`/`clearSession`, `storagePolicy.executeCleanup`, `deviceCache.saveAll`) would have been caught by a single happy-path contract test for that method. That's ~11 user-facing breakages one harness prevents.

### 3.4 Device path caveat
`jensen.*` / `downloadService.*` are WebUSB stubs in hosted mode with **no route** — exclude them from the HTTP contract harness. Their contract is verified by the **WebUSB mock conformance test** (`webusb-mock.conformance.test.ts`) + Layer 4 G5 (stub reachability) + Layer 6 (live).

---

## 4. Layer 4 — Hosted-mode invariant guards

Regression nets for the exact wiring bugs this session produced. Each is a small, fast test.

| ID | Guard | Assertion | Prevents |
|----|-------|-----------|----------|
| G1a | No electron on boot path | `build:server` audit passes | server won't boot under Node |
| G1b | **No electron reachable from routes** | reachability test walks each route's transitive imports (static + dynamic `import()`) — none reach `from 'electron'` in a hosted-executed path | voiceprint-class runtime crash |
| G2 | Processor starts at boot | `startServer` wires `startTranscriptionProcessor()` (assert it's called / the interval is armed) | queued transcripts stuck `pending` |
| G3 | Route registration complete | every `routes/*.ts` registrar is invoked in `app.ts` | endpoint 404 |
| G4 | Facade composition complete | every `groups/*.ts` factory is composed in `index.ts` | `electronAPI.x.y` undefined |
| G5 | No user-reachable rejecting stub | no `src` (non-test) call site invokes a still-rejecting Phase-1 stub in a user action | frozen UI / unhandled rejection |
| G6 | Partfile lifecycle | create→finalize integrity (hash+size match required, mismatch → 4xx + cleanup); delete removes partfile; TTL sweep; stream error handled (no uncaught) | server crash / orphaned disk / corrupt ingest |
| G7 | Auth coverage | every mutating route has `[requireAuth, requireSameOrigin]`; every data GET has `requireAuth`; only `/healthz`, `/auth/*`, static are public | data leak / CSRF |
| G8 | WS channel contract | every `broadcast('<ch>')` has a renderer subscription and vice versa | dead / never-firing events |
| G9 | Single WebUSB device | facade device group uses `getJensenDevice()` singleton (not `new JensenDevice()`) | double `claimInterface(0)` → device lockup |
| G10 | SPA served + fallback | `/` → 200 html; unknown non-`/api` GET → `index.html`; `/api/*` unknown → JSON 404 (resolve `HIDOCK_SPA_DIR`) | white-screen deploy |

---

## 5. Layer 3 — Server integration / E2E (inject)

Full flows through `buildApp()` against a temp DB (many already exist under `electron/server/**/__tests__`). Enumerate and fill gaps.

**Flows:**
- Auth: unauth 401; login (fake OIDC) → session; not-invited → 403; bad Origin on mutating → 403.
- Recordings: list (envelope), get, upload (multipart → save → enqueue), delete (file + row).
- Transcripts: by-id, by-recording-ids (map), search, turns PATCH, export, transcribe/retry/cancel, queue process/status.
- **Device-sync:** `POST /sync` (stream → partfile → serverSha256) → `finalize` (hash+size verify; reconcile-skip dupe; save→enqueue→WS) → `DELETE`; integrity-mismatch → 4xx + cleanup; re-sync → skipped.
- Chat / RAG: session create, chat, trim, clear, global search, conversations list.
- Knowledge / actionables / projects / contacts / meetings: CRUD + list envelopes.
- Config round-trip (get → patch → get); calendar settings; storage policy; quality; speakers/diarization; voiceprints.
- Media: `GET /api/recordings/:id/media` → 200 full + 206 range (seek).
- Static: `/` 200 html, `/library` fallback, `/api/nope` JSON 404, asset 200.

**Error/edge matrix (apply per flow):** 400 (bad body/zod), 401 (no session), 403 (invite/origin), 404 (unknown api + unknown id), 413 (oversized upload), empty-result, pagination boundary.

---

## 6. Layer 5 — Renderer component / hook

Against a **mocked** `electronAPI` (fast, but see the golden rule — these do NOT validate the contract; Layer 2 does).

- `useUnifiedRecordings` (merge device+db+synced; location classification; localPath).
- `useOperations` — `queueDownload` / `queueBulkDownloads` / `syncDeviceFiles` (serial, device-only guard, per-item error continue), `cancelAll`.
- Library — bulk/selected download wiring, transcript enrichment fetch, expand/view.
- Device/sync page — Connect gesture, silent reconnect, **Sync All via `syncDeviceFiles`** (not `getFilesToSync`), total-failure toast.
- Chat — conversations load (unwrapped), session ops.
- Settings/Calendar — config + auto-sync toggle round-trips.
- Device SDK group — mock-backed behavioral coverage of the delegated `jensen.*` methods (currently only ~4/26 exercised — **coverage hole**).

---

## 7. Layer 6 — Manual live checklist (un-automatable)

The WebUSB device path and Google OAuth cannot be automated (repo USB-safety rule; no headless OAuth). Run before a release, in Chrome/Edge.

**⛔ USB safety (CLAUDE.md):** ONE clean `claimInterface(0)`; never probe/iterate; on `LIBUSB_ERROR_ACCESS` → drain → power-cycle; **STOP after the first failure**, fix against mocks, then one clean retry.

**Checklist:**
1. Log in via Google (admin + an invited member).
2. Connect device — one clean connect; verify device info/model/settings.
3. Single download → appears synced → transcribes → **summary + detailed transcript + speakers** visible.
4. Re-sync the same file → **"Already synced" (skipped)**, no duplicate.
5. **Bulk / "Sync All"** → files sync **serially** (`CMD: Download File` per file), progress, then all appear.
6. Total-failure UX: with server unreachable, bulk shows a **"Sync failed"** toast (not false "nothing to sync").
7. Playback (media range / seek). Chat + RAG. Calendar auto-sync toggle persists.
8. Cross-tab: `recording:new` updates a second tab.
9. Browsers: Chrome + Edge (WebUSB); Firefox/Safari expected to lack device sync.

---

## 8. How to run + CI wiring

**Local full gate (from `apps/electron/`):**
```bash
npm run typecheck
npm run lint
npm run build:server        # electron boot-path audit
npx vitest run              # unit + contract + integration + guards (Layers 1–5)
npm run build               # SPA build
```

**Pre-commit (fast subset):** typecheck + lint + `vitest run` on changed areas + the Layer-4 guard tests (they're cheap and catch the worst regressions).

**CI (GitHub Actions), all mock/inject — no hardware:**
1. `typecheck` → `lint` → `build:server` (audit) → `build` (SPA).
2. `vitest run` (Layers 1–5) with coverage.
3. `docker compose build` (image + native ABI sanity).
4. Manual-live checklist (§7) is a **release-gate document**, not CI.

**Order of investment (highest ROI first):** Layer 2 contract harness → Layer 4 guards (G1b, G2, G5, G7, G9) → fill Layer 3 device-sync/error gaps → Layer 5 device-group behavioral coverage.

---

## 9. Regression table — every defect this session → the test that now catches it

| Defect (this session) | Layer / test that catches it |
|-----------------------|------------------------------|
| `knowledge/actionables/projects.getAll` envelope not unwrapped | L2 contract (`.items` unwrap assertion) |
| `transcripts.getByRecordingIds` `{recordingIds}` vs `{ids}` | L2 contract (happy path 2xx) |
| `assistant.getConversations` envelope | L2 contract |
| `calendar.toggleAutoSync` key mismatch | L2 contract |
| `quality.batchAutoAssess` key mismatch | L2 contract |
| `rag.removeLastMessages` / `clearSession` path 404 | L2 contract |
| `storagePolicy.executeCleanup` key mismatch | L2 contract |
| `deviceCache.saveAll` bare-array body | L2 contract |
| better-sqlite3 ABI (Electron vs Node) | L0 docker build + `require` smoke |
| static SPA path (`HIDOCK_SPA_DIR`) | L4 G10 |
| transcription processor not started in hosted | L4 G2 |
| voiceprint `electron` leak in hosted route | L0 / L4 G1b (reachability) |
| device group used `new JensenDevice()` (2nd claim) | L4 G9 |
| `/sync` + auto-sync calling Phase-1 stubs | L4 G5 + L5 (Device/useOperations) |
| partfile stream error → server crash | L4 G6 |
| bulk download serial (USB safety) | L5 (`syncDeviceFiles` serial) + L6 |

---

## 10. Known open gaps / follow-ups (tracked)

- Device SDK group: only ~4/26 delegated `jensen.*` methods have mock-backed behavioral tests (L5 hole).
- `sync-reconcile`: 2/4 branches unit-covered directly (rest transitive) (L1 hole).
- Hosted `/sync` progress bar/ETA doesn't animate (deviceSync client doesn't feed progress) — UX, not correctness.
- Hosted auto-sync-on-connect is a deliberate no-op (full hosted auto-sync deferred).
- Diarization models in the image = Phase 2.
- `finished` upload map + partfile TTL sweep are boot-only (no scheduled sweep) — fine for restart-frequent localhost; revisit for long-running WAN.
- **Findings from the 2026-07-07 exhaustive audit are folded into §4/§9 and fixed under their own commits — see `HOSTED-EXHAUSTIVE-AUDIT-2026-07-07.md` (3 confirmed) and `.superpowers/sdd/contract-harness.md` (9 more, all fixed).**
- **~~Known flaky test~~ FIXED (2026-07-08):** `electron/server/__tests__/transcripts.test.ts` › "…transcription/retry … sets recording status to pending" was **non-deterministic** — the route writes `pending` synchronously then fire-and-forgets `processQueueManually()`, which in the keyless test env failed and flipped status→`error` before the assertion. **Root cause was two-layered:** (1) a leaked `setInterval` — `startTranscriptionProcessor()` in the `processor/start` test was never stopped, and `vi.resetModules()` gives a fresh module but does NOT clear the OS timer, so it kept firing `processQueue()` against later tests' torn-down DBs; (2) the retry route's own fire-and-forget racing the assertion. **Fix (no module mock — 3 `vi.mock` variants all broke the stateful sibling routes):** (a) `afterEach` now calls `stopTranscriptionProcessor()` before the DB closes, killing the interval leak; (b) the retry test **holds the transcription mutex** (`acquireTranscriptionLock(...)`) before the POST so the route's `processQueueManually()` finds the lock taken and skips — making the synchronous `pending` write observable deterministically via the module's own API. Verified 5× stable + full suite. **Suite is now 100% green (`vitest run` → 3581 passed / 0 failed).**
