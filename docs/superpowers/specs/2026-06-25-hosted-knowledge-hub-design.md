# Hosted Knowledge Hub — Design Spec

- **Date:** 2026-06-25
- **Status:** Draft (awaiting review)
- **Topic:** Convert the `apps/electron/` Universal Knowledge Hub from an installed Electron desktop app into a self-hosted web application, running in a Docker container on an Unraid server, served to the internet through nginxproxymanager (NPM), with browser-side device sync via WebUSB and Google-OAuth access control.

---

## 1. Context & goals

`apps/electron/` is a mature Electron desktop app (the "Universal Knowledge Hub"): a React renderer talking to a Node main process over IPC, with USB device sync (Jensen protocol), AI transcription, RAG chat, calendar correlation, diarization, and a SQLite (`sql.js`) knowledge store.

The goal is to **run the full app — including HiDock device sync — in a browser**, hosted on Unraid, reachable over the internet behind NPM. The hosted web app **replaces** the Electron desktop app (the desktop shell is retired, not maintained in parallel).

### Why this is an architecture change, not a packaging change

Electron is a desktop runtime, not a web server. The renderer reaches privileged capabilities (USB, filesystem, custom protocols) through the Electron main process via IPC. Hosting requires re-homing the main process as a network server, replacing IPC with a network API, relocating device access to the browser, and replacing all desktop-only assumptions with web equivalents.

---

## 2. Settled decisions

| Decision | Choice | Rationale |
|---|---|---|
| Primary goal | Full app in the browser, **including device sync** | User requirement |
| Device location | HiDock plugs into the **machine running the browser** | Drives WebUSB-in-browser, not server-side node-usb |
| Electron's fate | **Hosted replaces desktop** | Delete Electron-isms outright; no dual-path maintenance |
| Auth | **Google OAuth (OIDC)** + admin-managed **invite system** | Self-contained, internet-safe, foundation for future multi-user |
| Admin identity | `rogercoxjr@gmail.com` (bootstrap admin) | User-specified |
| AI runtime | **Hybrid / configurable** (Ollama on Unraid *or* Gemini) | Preserve existing flexibility |
| Transport | **Proper REST + WebSocket** (Approach B) | Conventional, foundation for external/multi-user clients |
| DB engine | **Migrate `sql.js` → `better-sqlite3`** | Safe concurrent access + durability; opens the existing SQLite file directly (no data migration) |
| Existing data | **Start fresh on the server** | Re-sync from device; collapses the path-migration workstream |
| Browser support | **Chromium-based only** (Chrome / Edge / Opera) | WebUSB is unavailable in Firefox/Safari |

### Key de-risking finding (spike, 2026-06-25)

Browser WebUSB **can** drive the HiDock. Evidence: (1) the Jensen comms interface is vendor-specific (class `0xFF`) — both `apps/electron` and the stock-browser `apps/web` claim `interface 0` with no protected-class handling, which only works for a non-protected class; (2) neither HiDock vendor ID (`0x10d6`, `0x3887`) appears in Chromium's static WebUSB blocklist (`kStaticEntries`); (3) the official HiNotes website and `apps/web` already drive the device from a stock browser. The Electron `disable-usb-blocklist` switch is a precaution from the Electron 37 upgrade (which began enforcing the blocklist), not evidence the device is listed. **Risk closed by analysis; no hardware probe was run** (per the repo's USB safety rule).

---

## 3. Constraints & non-goals

**Constraints (user-facing and permanent):**
- **Chromium-based browser required** for device sync (Chrome/Edge/Opera). No Firefox/Safari WebUSB.
- **HTTPS / secure context required** (WebUSB + OAuth). Satisfied by NPM + Let's Encrypt; `localhost` is also a secure context for dev.
- **First device connect needs a user gesture** — `navigator.usb.requestDevice()` must be triggered by a click. Silent reconnect afterward via `navigator.usb.getDevices()` (already supported in `jensen.ts`).
- Single shared knowledge hub. Invite system gates **access**, not **data visibility** — all invited users see the same data.

**Non-goals (this spec):**
- Per-user data isolation / multi-tenancy (future Phase 3).
- Migrating existing desktop `~/HiDock` data into the hosted instance (explicitly "start fresh").
- Maintaining the Electron desktop build.
- Server-side USB passthrough (device is at the client, not the server).
- New knowledge-source types (PDF/DOCX/etc.) — orthogonal to hosting.

---

## 4. Target architecture

```
┌─────────────────────── client machine (Chrome/Edge) ───────────────────┐
│  React SPA (the current renderer, Electron-isms removed)                │
│   • WebUSB → HiDock plugged in HERE (claimInterface 0, ep1 OUT/ep2 IN)  │
│   • Typed client SDK (preserves the electronAPI facade shape)           │
│   • Google OAuth login                                                  │
└──────────────┬───────────────────────────────────────────┬────────────┘
               │ HTTPS (REST + resumable upload)             │ WSS (push events)
               ▼                                             ▼
       ┌──────────────── nginxproxymanager (TLS, WS passthrough) ─────────┐
       └───────────────────────────────┬──────────────────────────────────┘
                                        ▼
       ┌──────────────── Docker container on Unraid ──────────────────────┐
       │  Fastify server  (= the ex-Electron main process)                │
       │   • Google OIDC verify + session + invite/allowlist gate         │
       │   • REST routers  ← from electron/main/ipc/*-handlers.ts          │
       │   • WS broadcaster ← replaces webContents.send                    │
       │   • services (better-sqlite3 db, transcription, rag, vector,      │
       │     calendar, outputs, storage, diarization, voiceprint…)        │
       │   • HTTP range media endpoint ← replaces hidock-media://          │
       │  Volume /data → /mnt/user/appdata/hidock (db, recordings, …)      │
       └───────────┬──────────────────────────────────┬────────────────────┘
                   ▼                                   ▼
           Ollama container (optional)         Gemini API (cloud)
           — AI runtime is configurable —
```

### Code reshaping (three buildable units)

The work splits `apps/electron/`. Whether we create a new `apps/server/` + `apps/web-hub/` or reshape in place is a planning decision; conceptually:

**`server/` (was `electron/main/`)**
- **Framework: Fastify** — first-class WebSocket support, Zod schema validation at the route boundary (`zod` is already a dependency), fast. (Express is the fallback.)
- **`server/services/*`** — lifted from `electron/main/services/*` (already Electron-free business logic). Main edit: replace the `setMainWindow(win)` + `webContents.send(channel, payload)` pattern with an injected **event broadcaster** (→ WS). Audit each `setMainWindow*` caller — some may use `webContents` beyond `.send()`.
- **`server/routes/*`** — rewritten from `electron/main/ipc/*-handlers.ts`. Each `ipcMain.handle('group:method', fn)` body is extracted into a controller mounted on a REST route. **Logic is reused; the registration layer is rewritten.**
- **`server/auth`** — Google OIDC + session + invite gate.
- **`server/media`** — HTTP range endpoint replacing `media-protocol.ts` / `hidock-media://`.

**`web/` (was the renderer, `src/`)**
- React SPA stays. Two swaps:
  - The `window.electronAPI` **facade is preserved in shape, reimplemented as a typed client SDK** over REST/WS. Today every call funnels through one `callIPC(channel, ...args)` helper (`preload/index.ts:32`); the renderer's ~40 API groups all route through it. The SDK reimplements those group methods as `fetch`/WS calls, localizing the migration to one client module + the server routes.
  - **Device layer is already WebUSB** (`src/services/jensen.ts`, `hidock-device.ts`). It survives; we add an explicit "Connect device" button (user gesture) and route synced bytes to an upload endpoint instead of a local path.

**`deploy/`** — multi-stage Dockerfile, Unraid volume layout, NPM configuration notes.

**Deleted outright:** `electron/main/index.ts` (app/window/splash lifecycle, USB session glue), the preload bridge, the `usb` npm dependency, `electron-builder`, `media-protocol.ts`, `ENABLE_REMOTE_DEBUGGING`, window-chrome assumptions.

---

## 5. Authentication & access control

**Mechanism:** Google OIDC via Fastify + `openid-client`.

**Flow:** unauthenticated request → redirect to Google → callback verifies the ID token → email looked up in the `allowed_users` table → if `active`, issue a signed session cookie (`httpOnly; Secure; SameSite=Lax`); else deny with a clear "not invited — contact the admin" response. OAuth `state` parameter guards the login round-trip against CSRF.

**Invite system (admin-managed):**
- `allowed_users` table: `email`, `role` (`admin` | `member`), `status` (`active` | `revoked`), `invited_by`, `created_at`.
- **Bootstrap:** `ADMIN_EMAIL` env (`rogercoxjr@gmail.com`) seeds the first admin on first boot; the first matching Google login gets `admin`.
- **Admin Settings panel** (admin-only section in the existing Settings page): add an email to invite, set role, revoke access, list who has access. Backed by `GET/POST/PATCH/DELETE /api/admin/users` routes guarded by an `admin` role check.
- **Members** share the single knowledge hub; the only role distinction in Phase 0 is access to the admin panel.

**Guarded surfaces (all of them):** `/api/*`, the **WS upgrade** (validates the session cookie during the handshake), and the **media + upload** endpoints. State-changing routes additionally enforce an origin check (defense-in-depth with `SameSite`).

**Secrets (Unraid env):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ADMIN_EMAIL`, `GEMINI_API_KEY`, `OLLAMA_URL`, `PUBLIC_URL` (for the OAuth redirect URI). The Google OAuth client must register the redirect URI for the exact public hostname.

---

## 6. API surface

**REST resources** (Fastify routers, Zod-validated), grouped by domain — `recordings`, `transcripts`, `meetings`, `contacts`, `projects`, `outputs`, `calendar`, `storage`, `voiceprints`, `speakers`, `knowledge`, `actionables`, `config`, `admin/users`, etc. Resource-shaped operations map to verbs (`GET /api/recordings`, `PATCH /api/recordings/:id`); RPC-style operations become **action endpoints** (`POST /api/rag/chat`, `POST /api/recordings/:id/transcribe`) — valid REST, not a workaround.

**WebSocket — server-originated push only:** transcription progress, RAG indexing progress, calendar auto-sync, migration/integrity/storage notifications, and `recording:new` (fired by the upload handler, broadcast to the user's other tabs). The WS upgrade is authenticated with the session cookie. **Device connect/disconnect events stay browser-local** (they originate from WebUSB in the renderer) — they never reach the server or WS.

**Client SDK:** a typed facade preserving the `electronAPI` method shape, so renderer call sites barely change; it is the REST API's first consumer. The REST layer is kept genuinely resourceful so the "proper REST" investment pays off for future external/multi-user clients rather than being cosmetic.

---

## 7. Data flows

**Device sync & upload (Phase 1):**
1. User clicks **Connect** → WebUSB picker → `claimInterface(0)` → Jensen file-list read (the ~90 s / 1400-file multi-transfer behavior is already solved in the renderer's `jensen.ts` continuous-`transferIn` loop).
2. To pull a recording, the browser streams `transferIn` chunks into a **resumable, content-range upload** — never buffering a 200–440 MB WAV in tab memory.
3. Server writes to `/data/recordings`, inserts the row (with a **data-root-relative** path), enqueues transcription, broadcasts `recording:new`.
4. **Dedup** reuses the existing 4-layer reconciliation logic (signature/version/size).
5. Designed resumable because when the user browses away from home, bytes cross the WAN (device → browser → server).

**Media playback:** an **authenticated HTTP range endpoint** (`GET /api/recordings/:id/media`) replaces the `hidock-media://` protocol; `<audio>` points at the authed URL with range/seek support for large files.

**AI (transcription / embeddings / RAG):** runs server-side, runtime configurable (Ollama-on-Unraid or Gemini), progress streamed over WS.

---

## 8. Data layer

**Engine: `better-sqlite3`.** `sql.js` is in-memory, single-writer, and persists by serializing the entire DB file — unsafe under a concurrent server (interleaved writes corrupt it, even with one user + two tabs + background workers). `better-sqlite3` opens the **existing SQLite file format directly** (no data migration), provides WAL mode (concurrent readers + one safe writer), real transactions, and durability. It also **eliminates the `runInTransaction`/`runNoSave` "cannot rollback" foot-gun** documented in the codebase. Work is an API-layer rewrite of `database.ts` + query re-verification, not a data migration. It is a native module, Dockerized alongside `ffmpeg`/`sherpa-onnx`.

**Paths:** all stored file paths become **relative to a configured data root** (or ID-derived), resolved at runtime. Because the hosted instance starts fresh, this is simply "write relative paths from day one" — no migration of legacy absolute paths.

**Volume layout** (`/data` → `/mnt/user/appdata/hidock`): `hidock.db`, `recordings/`, `transcripts/`, `config.json`, ASR/temp scratch (cleaned on boot).

---

## 9. Deployment

**Docker image (multi-stage):** build SPA (`vite build`) → build server (tsc/esbuild) → slim Node runtime carrying native deps (`better-sqlite3`, `ffmpeg`; Phase 2 adds `sherpa-onnx-node` + fetched models). One Node process serves the static SPA **and** the API/WS on a single port. `/healthz` for Unraid/NPM health checks.

**Unraid:** volume `/data` → `/mnt/user/appdata/hidock`; env/secrets per §5; Ollama runs as a separate container referenced by `OLLAMA_URL` (optional GPU).

**nginxproxymanager:** proxy host → container port; Let's Encrypt cert (HTTPS mandatory); **WebSocket support enabled** on the proxy host (Upgrade/Connection passthrough — a common failure point that silently kills the event channel if missed); proxy buffering tuned for large uploads/streamed media.

---

## 10. Phased rollout

The headline feature (device sync) is **Phase 1, not Phase 0** — Phase 0 de-risks the entire platform on a fresh DB before adding the riskiest moving part.

### Phase 0 — Hub in a browser, no device *(this spec's detailed scope)*
Stand up the platform end-to-end with no device sync:
- Fastify server: `better-sqlite3` data layer, REST routers for the core domains, WS broadcaster.
- Google OIDC auth + `allowed_users` invite system + admin settings panel + bootstrap admin.
- Renderer: facade swapped to the REST/WS client SDK; Electron shell + Electron-isms removed; Electron-specific UI (window chrome, native dialogs, `shell.openExternal`, `hidock-media://`) replaced with web equivalents.
- Media range endpoint.
- Multi-stage Dockerfile; deployed on Unraid behind NPM with TLS + WS passthrough.
- **Acceptance:** log in via Google (admin + an invited member), browse Library/Search/Calendar/Outputs/Contacts/Projects, run RAG chat, play media — all against a fresh DB, over HTTPS, through NPM. No device features yet.

**Clears:** transport, auth/invite, deploy, DB concurrency, path model.

### Phase 1 — Device sync (the #1 goal)
- Port the WebUSB device layer (`jensen.ts`, `hidock-device.ts`) into the SPA; add the "Connect device" gesture and silent reconnect.
- Resumable large-file upload pipeline (browser WebUSB stream → content-range upload).
- Server ingest: store, dedup (4-layer reconciliation), enqueue transcription, WS progress.
- **Acceptance:** connect the HiDock in Chrome/Edge, sync recordings, see them transcribe server-side. One user-driven live smoke test (no scripted hardware probing).

**Clears:** WAN upload pipeline; full browser-driven sync.

### Phase 2 — Heavy AI & hardening
- Dockerize `sherpa-onnx-node` + models for diarization (CPU-only on Unraid expected).
- Rewrite `voiceprint-worker-pool.ts` from Electron `utilityProcess` → Node `worker_threads`/`child_process`.
- Storage policy, backups, performance.
- Security review: rate limiting, CSRF depth, WS/media/upload auth audit, secrets handling.

### Phase 3 — Multi-user *(future, optional)*
Per-identity data separation on the REST foundation.

---

## 11. Risk register

| # | Risk | Status | Phase / mitigation |
|---|---|---|---|
| 1 | Browser WebUSB can't claim the HiDock | **Cleared** (spike §2) | n/a |
| A | `sql.js` single-writer vs. concurrent server → corruption | Addressed | Phase 0 — `better-sqlite3` + WAL |
| B | Absolute local paths stored in the DB | Collapsed | Phase 0 — relative paths, fresh start |
| C | `voiceprint-worker-pool.ts` uses Electron-only `utilityProcess` | Open | Phase 2 — rewrite to `worker_threads` |
| D | `sherpa-onnx-node` native addon in Docker (CPU-only) | Open | Phase 2 — Linux build + `models:fetch` |
| E | 200–440 MB WAV upload over WAN | Open | Phase 1 — resumable, progress, integrity check |
| F | Internet-exposed security depth (WS/media/upload auth, CSRF, rate-limit, secrets) | Partial | Phase 0 baseline + Phase 2 review |
| G | Electron-coupling in the renderer beyond device (dialogs, `shell.openExternal`, window chrome, media protocol) | Open | Phase 0 — inventory + web equivalents |
| H | `setMainWindow*` callers using `webContents` beyond `.send()` | Open | Phase 0 — audit during broadcaster swap |

---

## 12. Testing & error handling

**Testing:**
- The existing Vitest service suites are Electron-free and largely survive the move to `server/`.
- Add: REST route tests (Fastify `inject`), auth-middleware + invite-gate tests, upload-pipeline tests (mocked WebUSB + streaming), WS event tests.
- **WebUSB stays mocked — never hardware in tests** (repo USB safety rule). The only live check is the user-driven Connect at the end of Phase 1.
- Docker build CI + a smoke test that the container boots, serves the SPA, and passes `/healthz`.

**Error handling:**
- REST: consistent error envelope — Zod validation → 400, auth → 401/403, missing → 404, server → 500 with a safe message.
- Upload: resumable retry + post-upload integrity check (signature/size).
- WS: client SDK auto-reconnects with backoff; events are idempotent.
- Device: existing `jensen.ts` error handling ports over; the USB-lockup recovery guidance remains relevant on the client machine.

---

## 13. Assumptions to confirm

1. **Shared-hub access model** — invited users see the same single knowledge hub; the invite system gates entry, not data visibility. (Per-user isolation = future Phase 3.)
2. **Start fresh** — no migration of existing desktop `~/HiDock` data; recordings are re-synced from the device.
3. **Repository layout** — whether to create new `apps/server/` + `apps/web-hub/` directories or reshape `apps/electron/` in place is deferred to the implementation plan.
4. **`apps/web` reuse** — the *current* device code to port is the Electron renderer's `src/services/jensen.ts` (updated for newer P1 Mini IDs), not necessarily `apps/web`'s older adapter.
