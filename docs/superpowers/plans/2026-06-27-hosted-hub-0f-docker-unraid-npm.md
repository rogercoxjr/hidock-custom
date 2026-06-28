# Hosted Hub — Plan 0f: Docker + Unraid + nginxproxymanager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the headless hub (Fastify REST/WS API + the built SPA) into one self-contained Docker image that serves everything on a single port, persists all state to a `/data` volume, and runs behind nginxproxymanager (NPM) on Unraid with TLS, WebSocket passthrough, and Google OAuth.

**Architecture:** A multi-stage `Dockerfile`. Stage 1 (`spa-build`) builds the React SPA with electron-vite/vite into `out/renderer`. Stage 2 (`server-build`) compiles `electron/server/index.ts` + the `electron/main/**` services it imports into `out/server/index.js`. Stage 3 (`native-deps`) does a **clean, production-only `npm install` against the runtime Node ABI** so the native modules (`better-sqlite3`, `sodium-native`, plus the bundled `ffmpeg-static` binary, and the Phase-2 `sherpa-onnx-node`) are correct for plain Node — **not** Electron, which the repo's `postinstall` (`electron-builder install-app-deps`) wrongly rebuilds for. Stage 4 (`runtime`) is a slim `node:22-bookworm-slim` image carrying only `out/`, the production `node_modules`, the SPA, and the models dir; it runs `node out/server/index.js`, which serves the SPA as static files with an SPA fallback and mounts the REST/WS API on the same port. All mutable state lives under `HIDOCK_DATA_ROOT=/data`, mapped to Unraid appdata. NPM terminates TLS (Let's Encrypt) and proxies HTTP + the `/ws` WebSocket upgrade to the container.

**Tech Stack:** Docker (multi-stage, BuildKit), `node:22-bookworm-slim`, electron-vite/vite (SPA), esbuild or `tsc` (server bundle), `@fastify/static` (SPA serving), `better-sqlite3` + `sodium-native` + `ffmpeg-static` (native runtime deps), `sherpa-onnx-node` (Phase 2, optional), nginxproxymanager (reverse proxy + Let's Encrypt), Unraid (Docker host).

## ⚠️ Operator-Only Verification (cannot be done autonomously)

The agent implementing this plan **can** author and locally lint/dry-validate the Dockerfile, compose file, `.dockerignore`, env template, and docs, and **can** run the SPA build + server build steps that the image depends on. The agent **cannot** do the final acceptance, which requires hardware, networking, a registered Google OAuth client, and a domain. These are the **operator's verification steps** and are explicitly out of scope for autonomous completion:

1. **A real `docker build`** — multi-arch / native-compilation steps need a Docker daemon and may pull large base images and compile `better-sqlite3`/`sodium-native`. The agent has no Docker daemon in this environment. The Dockerfile is authored "build-ready" but its first true compile happens on the operator's machine.
2. **The Unraid deploy** — adding the container template, mapping `/data` to appdata, setting env vars, and starting it on the Unraid box.
3. **Live Google OAuth** — registering the OAuth client, adding the exact redirect URI, and completing a real sign-in round-trip through NPM's TLS endpoint. OAuth cannot be exercised without a public HTTPS URL and a Google project the operator controls.

Every task below marks its operator-only steps with **(OPERATOR)**. Agent-runnable steps (file authoring, local builds, hadolint/compose validation) are marked normally.

## Global Constraints

- **Single port, single process.** `startServer()` (in `apps/electron/electron/server/index.ts`) already calls `app.listen({ port: cfg.port, host: '0.0.0.0' })`. The container serves SPA **and** API from this one Fastify instance. Default `PORT` is `8788` (`server/config.ts:25`). The image EXPOSEs and the compose maps this one port. **Do not** introduce a second web server (no separate nginx inside the image — NPM is the external reverse proxy).
- **All mutable state under `/data`.** `HIDOCK_DATA_ROOT=/data` drives `getDataRoot()` (`electron/main/runtime/env.ts`, from plan 0a), which is the root for the SQLite DB, recordings, transcripts, and `config.json` (`getConfigPath()` defaults to `<dataRoot>/config.json`). The image declares `VOLUME /data`. Nothing writable lives in the image layers.
- **Runtime Node ABI ≠ Electron ABI.** The native modules in the runtime image MUST be built for the plain-Node runtime (`node:22`), NOT Electron. The repo's `package.json` `postinstall` is `electron-builder install-app-deps`, which rebuilds native deps for **Electron's** bundled Node ABI — running that in the server image produces modules that crash under plain Node (`NODE_MODULE_VERSION` mismatch). The `native-deps` stage MUST install with `--ignore-scripts` (to skip that postinstall) and then explicitly rebuild `better-sqlite3` against the runtime Node, OR install in an environment where `npm rebuild` targets plain Node. (See Task 3 for the exact mechanism.)
- **Node version pin.** Base image `node:22-bookworm-slim`. Node 22 LTS matches the `@types/node@^22` floor in `package.json` and is a current LTS. Pin the same major across all stages so the ABI compiled in `native-deps` matches the `runtime` stage exactly.
- **Native modules in scope:** `better-sqlite3@^12.11.1` (compiled), `sodium-native@5.1.0` (transitive via `@fastify/secure-session`; ships prebuilds via `node-gyp-build`), `ffmpeg-static@^5.3.0` (downloads a platform ffmpeg binary at install; needs the Linux x64 binary), `sherpa-onnx-node@1.13.3` (**optionalDependency**, Phase 2 only — must not fail the build if it can't install). `usb@^2.17.0` is present but **device access is a browser/renderer WebUSB gesture in the hosted model (plan 0e)** — the server never opens USB, so a failed `usb` native build must not break the image (mark it skip-tolerant).
- **No secrets baked into the image.** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ADMIN_EMAIL`, `PUBLIC_URL`, `OLLAMA_URL`, `HIDOCK_DATA_ROOT`, `HIDOCK_SECRET_KEY` are supplied at **runtime** (compose env / Unraid template), never `COPY`'d in or `ENV`-baked with real values. The Dockerfile may declare them as `ENV` with empty/dev defaults only where harmless (e.g. `HIDOCK_DATA_ROOT=/data`, `NODE_ENV=production`, `PORT=8788`).
- **`server/config.ts` required-env contract (verbatim from code):** `SESSION_SECRET` (required, ≥16 chars), `GOOGLE_CLIENT_ID` (required), `GOOGLE_CLIENT_SECRET` (required), `PUBLIC_URL` (required, trailing slash stripped), `ADMIN_EMAIL` (optional, defaults to `rogercoxjr@gmail.com`), `PORT` (optional, defaults `8788`). A missing required var throws on boot — the container will exit. The compose/Unraid template MUST set all four required vars.
- **Line length 120**, follow existing repo conventions. **Branch:** `feat/hosted-knowledge-hub`. Unless noted, run commands from `apps/electron/`.
- **This sub-plan depends on 0a–0e being merged.** Specifically it relies on: 0a (`HIDOCK_DATA_ROOT`/`getDataRoot()`, better-sqlite3 engine, headless `bootFoundation()`), 0b (`startServer()`, `getServerConfig()`, `/healthz`, Google OIDC), 0c (REST routers + WS broadcaster on `/ws`), 0d (media range endpoint), 0e (renderer talks to REST/WS, no Electron-isms). If any service still imports `app` from `electron` at runtime, the server image will crash — see the Pre-flight task.

---

### Task 0 (Pre-flight): Confirm the server actually boots headless and identify Electron-runtime leaks

This task is a **gate**, not a build. Before writing any Docker artifacts, prove the server entrypoint runs under plain Node and surface any module that still imports `electron` on a code path the server touches. If this gate fails, the Docker image is futile — fix the leak (in the relevant 0a–0e plan's scope) first.

**Files:**
- Read-only inspection of: `apps/electron/electron/server/index.ts`, `apps/electron/electron/server/app.ts`, `apps/electron/electron/server/config.ts`, `apps/electron/electron/main/services/asr/audio-normalize.ts`
- No files created.

**Interfaces:**
- Consumes: `startServer()` (`server/index.ts`), `getServerConfig()` (`server/config.ts`).
- Produces: a documented list of any `from 'electron'` imports reachable from the server (input to a follow-up fix, NOT fixed here).

- [ ] **Step 1: Enumerate electron imports reachable from the server graph**

Run (from `apps/electron/`):
```bash
grep -rnE "from ['\"]electron['\"]" electron/main electron/server --include="*.ts" | grep -v "__tests__"
```
Expected: a finite list. **Known offender:** `electron/main/services/asr/audio-normalize.ts:3` imports `app` from `electron` and branches on `app.isPackaged` (`resolveFfmpegPath()`). This is on the transcription/ASR path. If the server imports any ASR/transcription code at boot or per-request, this import WILL execute under plain Node and throw (`app` is undefined). Record every hit.

- [ ] **Step 2: Decide each hit's disposition**

For each file from Step 1, classify:
- **Boot path** (imported by `app.ts` → routes at startup): MUST be fixed before the image is useful. Note it as a blocking dependency on the owning plan (0a–0e).
- **Lazy/request path** (only imported inside a route handler the SPA can hit): the container boots, but the feature 500s. Note as a runtime risk.
- **Dead/unreached**: no action.

For `audio-normalize.ts` specifically, the fix (out of scope here, flag to 0e/foundation) is to replace `app.isPackaged ? …unpacked… : …` with a runtime-neutral resolver — in a server image there is no asar, so `resolveFfmpegPath()` should return the `ffmpeg-static` path verbatim (and respect an `FFMPEG_PATH` override if set). **Do not implement** — record it.

- [ ] **Step 3: Smoke-boot the server under plain Node locally (agent-runnable)**

Build the server bundle (Task 2 produces the real one; for the gate, a quick check is enough) and attempt a boot with throwaway env:
```bash
SESSION_SECRET=local-dev-session-secret-0123 \
GOOGLE_CLIENT_ID=dummy GOOGLE_CLIENT_SECRET=dummy \
PUBLIC_URL=http://localhost:8788 \
HIDOCK_DATA_ROOT="$(pwd)/.hidock-data-smoke" \
PORT=8799 \
node -e "import('./electron/server/index.ts').catch(e=>{console.error('BOOT-FAIL:',e.message);process.exit(1)})" 2>&1 | head -30 || true
```
> Note: raw `.ts` won't run under bare `node`; this step's real form runs **after** Task 2 against `out/server/index.js`. At pre-flight, the meaningful signal is whether `getServerConfig()` validates env and whether any imported module throws an electron-related error at load. If you cannot run it pre-build, defer the live boot assertion to Task 2 Step 6 and only complete Steps 1–2 here.

- [ ] **Step 4: Record findings (no commit)**

Produce a short note (in the PR description or the executing session's scratch, NOT a committed report file) listing: boot-path electron imports (blocking), request-path electron imports (risk), and the `audio-normalize.ts` ffmpeg resolver caveat. This informs whether 0f can complete end-to-end or is blocked on a foundation fix.

---

### Task 1: `.dockerignore` + repo-root build context decision

**Files:**
- Create: `apps/electron/.dockerignore`

**Interfaces:**
- Produces: a lean build context so `COPY . .` in the Dockerfile doesn't drag `node_modules`, `out`, `dist`, `.hidock-data`, or model binaries into every layer.

- [ ] **Step 1: Write `.dockerignore`**

Create `apps/electron/.dockerignore`:
```gitignore
# Build outputs (regenerated inside the image)
out
dist
release

# Dependencies (reinstalled per-stage with the right ABI)
node_modules
**/node_modules

# Local runtime state — must NEVER enter the image (lives on the /data volume)
.hidock-data
.hidock-data-smoke

# Large model binaries — fetched into the image in a controlled step, not via COPY .
resources/models/*.onnx

# Dev / VCS / editor noise
.git
.vscode
.idea
*.log
coverage
.eslintcache

# Tests are not needed in the image
**/__tests__
**/*.test.ts
**/*.test.tsx

# Electron desktop packaging config (irrelevant to the server image)
electron-builder.yml
build
```
> Rationale: the build context is `apps/electron/`. Excluding `node_modules` forces each stage to install fresh against its own ABI (the whole point of Task 3). Excluding `resources/models/*.onnx` keeps the context small; the model is added deliberately in Task 4 (Phase 2), not swept in.

- [ ] **Step 2: Verify the ignore patterns resolve (agent-runnable)**

Run (from `apps/electron/`):
```bash
git ls-files --others --ignored --exclude-from=.dockerignore | head -5; echo "---"; test -f .dockerignore && echo "dockerignore present"
```
Expected: `dockerignore present`. (This is a sanity check that the file exists and is syntactically a gitignore-style file; Docker uses it at build time.)

- [ ] **Step 3: Commit**

```bash
git add apps/electron/.dockerignore
git commit -m "feat(0f): add .dockerignore for the server image build context"
```

---

### Task 2: Make the server a buildable artifact (`out/server/index.js`)

**Today the server is not a build target.** `electron.vite.config.ts` only builds `electron/main/index.ts` + the voiceprint worker; `package.json`'s `start:server` already points at `node out/server/index.js`, but nothing emits that file. This task wires the server build so the Dockerfile has a real artifact to run.

**Files:**
- Modify: `apps/electron/package.json` (add a `build:server` script)
- Create: `apps/electron/scripts/build-server.mjs` (esbuild bundler for the server)
- Modify: `apps/electron/package.json` devDependencies (add `esbuild`)

**Interfaces:**
- Consumes: `electron/server/index.ts` (entry; `startServer()` + the direct-invoke guard at the bottom).
- Produces: `out/server/index.js` — a Node-runnable, ESM bundle whose only externals are the native modules (`better-sqlite3`, `sodium-native`, `ffmpeg-static`, `sherpa-onnx-node`, `usb`) and Node built-ins. Run with `node out/server/index.js`.

- [ ] **Step 1: Add esbuild dev dependency**

Run (from `apps/electron/`):
```bash
npm install -D esbuild
```
Expected: `esbuild` appears under devDependencies in `package.json`.

- [ ] **Step 2: Write the server bundler script**

Create `apps/electron/scripts/build-server.mjs`:
```javascript
/**
 * build-server.mjs — bundle the headless Fastify server for plain Node.
 *
 * Entry: electron/server/index.ts (startServer + direct-invoke guard).
 * Output: out/server/index.js (ESM).
 *
 * Native modules and 'electron' are marked EXTERNAL: they are resolved from
 * node_modules at runtime (the native-deps stage installs them with the
 * correct Node ABI). 'electron' is external so any residual import resolves
 * to the package's stub rather than being inlined — but note: if 'electron'
 * is actually *called* at runtime it will throw. Task 0 audits for that.
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['electron/server/index.ts'],
  outfile: 'out/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // Keep native + electron out of the bundle; resolved from node_modules at runtime.
  external: [
    'better-sqlite3',
    'sodium-native',
    'ffmpeg-static',
    'sherpa-onnx-node',
    'usb',
    'electron',
    // Fastify + plugins are pure JS and CAN be bundled, but leaving the heavy
    // ones external keeps the bundle small and avoids ESM/CJS interop surprises.
    'fastify',
    '@fastify/secure-session',
    '@fastify/websocket',
    '@fastify/multipart',
    '@fastify/static'
  ],
  // ESM output needs a shim for __dirname/require used by some deps.
  banner: {
    js: [
      "import { createRequire as __cr } from 'module';",
      'const require = __cr(import.meta.url);',
      "import { fileURLToPath as __f } from 'url';",
      "import { dirname as __d } from 'path';",
      'const __filename = __f(import.meta.url);',
      'const __dirname = __d(__filename);'
    ].join('\n')
  },
  logLevel: 'info'
})
console.log('[build-server] wrote out/server/index.js')
```
> Note on the direct-invoke guard: `index.ts` ends with `if (process.argv[1] && process.argv[1].endsWith('index.js'))`. The bundle output is `out/server/index.js`, so `process.argv[1]` will end with `index.js` when run as `node out/server/index.js` — the guard fires correctly. Keep the outfile basename `index.js`.

- [ ] **Step 3: Add the `build:server` script**

Edit `apps/electron/package.json` scripts — add:
```json
"build:server": "node scripts/build-server.mjs",
```
(Place it next to `start:server`.)

- [ ] **Step 4: Build the server bundle (agent-runnable)**

Run (from `apps/electron/`):
```bash
npm run build:server
```
Expected: `out/server/index.js` and `out/server/index.js.map` exist; esbuild prints no errors. If esbuild reports unresolved imports that are pure JS, add them to neither external nor entry — they bundle automatically; only add to `external` if they are native or cause interop errors.

- [ ] **Step 5: Verify the artifact (agent-runnable)**

Run:
```bash
test -f out/server/index.js && head -c 400 out/server/index.js && echo "...OK"
```
Expected: file exists; the banner shim (createRequire) appears at the top.

- [ ] **Step 6: Live headless boot smoke (agent-runnable; completes Task 0 Step 3)**

This requires `node_modules` present with native deps built for the **local** Node (dev machine). If the local Node major ≠ 22, the better-sqlite3 ABI may mismatch — that's fine, it just means this smoke runs on the dev Node; the image uses Node 22 consistently. Run:
```bash
SESSION_SECRET=local-dev-session-secret-0123 \
GOOGLE_CLIENT_ID=dummy GOOGLE_CLIENT_SECRET=dummy \
PUBLIC_URL=http://localhost:8799 \
HIDOCK_DATA_ROOT="$(pwd)/.hidock-data-smoke" \
PORT=8799 \
node out/server/index.js &
sleep 4
curl -fsS http://localhost:8799/healthz && echo " <- healthz OK"
kill %1 2>/dev/null || true
rm -rf .hidock-data-smoke
```
Expected: `{"status":"ok"} <- healthz OK`. If boot fails with an electron-related error, Task 0's audit found a real boot-path leak — stop and fix it in the owning plan before continuing. (If the dev Node's better-sqlite3 ABI mismatches, rebuild locally with `npm rebuild better-sqlite3` first, or defer this assertion to the operator's real `docker build` + run.)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json scripts/build-server.mjs
git commit -m "feat(0f): build the headless server to out/server/index.js (esbuild)"
```

---

### Task 3: Serve the SPA from the Fastify server (static + SPA fallback)

The container serves the built SPA from the **same** Fastify instance on the **same** port as the API. `app.ts` currently registers no static handler. This task adds `@fastify/static` serving `out/renderer` with an SPA history-fallback, registered **after** the API routes so `/api/*`, `/ws`, `/healthz`, and the OAuth routes still win.

**Files:**
- Modify: `apps/electron/package.json` (add `@fastify/static`)
- Modify: `apps/electron/electron/server/app.ts` (register static + SPA fallback at the end of `buildApp`)
- Create: `apps/electron/electron/server/static.ts` (the static/SPA registration helper)
- Test: `apps/electron/electron/server/__tests__/static.test.ts`

**Interfaces:**
- Consumes: the `FastifyInstance` from `buildApp`; `getDataRoot()` is NOT used here (SPA is image content, not data). SPA dir resolves from `HIDOCK_SPA_DIR` env (default: resolved relative to the server bundle — `<out>/renderer`).
- Produces: `registerStatic(app: FastifyInstance): Promise<void>` (exported from `server/static.ts`). After registration: `GET /` and any non-API/non-asset path returns `index.html`; hashed assets are served from `out/renderer/assets`.

- [ ] **Step 1: Add the static plugin dependency**

Run (from `apps/electron/`):
```bash
npm install @fastify/static
```
Expected: `@fastify/static` under dependencies. (It is a pure-JS plugin; keep it in `external` for the server bundle per Task 2's list so it resolves from node_modules — already listed there.)

- [ ] **Step 2: Write the failing test**

Create `apps/electron/electron/server/__tests__/static.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Fastify, { FastifyInstance } from 'fastify'
import { registerStatic } from '../static'

describe('server/static (SPA serving)', () => {
  let app: FastifyInstance
  let spaDir: string

  beforeAll(async () => {
    spaDir = mkdtempSync(join(tmpdir(), 'hidock-spa-'))
    mkdirSync(join(spaDir, 'assets'), { recursive: true })
    writeFileSync(join(spaDir, 'index.html'), '<!doctype html><title>HiDock</title><div id=root></div>')
    writeFileSync(join(spaDir, 'assets', 'app-abc123.js'), 'console.log("spa")')
    process.env.HIDOCK_SPA_DIR = spaDir

    app = Fastify()
    // Simulate a real API route registered BEFORE static, to prove precedence.
    app.get('/api/ping', async () => ({ ok: true }))
    app.get('/healthz', async () => ({ status: 'ok' }))
    await registerStatic(app)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    rmSync(spaDir, { recursive: true, force: true })
    delete process.env.HIDOCK_SPA_DIR
  })

  it('serves index.html at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id=root')
  })

  it('serves a hashed asset', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('spa')
  })

  it('falls back to index.html for an unknown client route (SPA history mode)', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/some/deep/route' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id=root')
  })

  it('does NOT shadow an API route', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ping' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
  })

  it('returns 404 JSON for an unknown /api path, not the SPA shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toMatch(/json/)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run electron/server/__tests__/static.test.ts`
Expected: FAIL — cannot find module `../static`.

- [ ] **Step 4: Write `server/static.ts`**

Create `apps/electron/electron/server/static.ts`:
```typescript
import { FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Resolve the built SPA directory.
 * - HIDOCK_SPA_DIR overrides (set in the Docker image).
 * - Otherwise resolve <serverBundleDir>/../renderer (out/server -> out/renderer).
 */
function resolveSpaDir(): string {
  if (process.env.HIDOCK_SPA_DIR) return process.env.HIDOCK_SPA_DIR
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'renderer')
}

/**
 * Serve the built SPA from the same Fastify instance as the API.
 * MUST be registered AFTER all /api, /ws, /healthz, and auth routes so those win.
 * Unknown non-API GETs fall back to index.html (client-side history routing);
 * unknown /api paths return Fastify's JSON 404 (handled by the notFound logic).
 */
export async function registerStatic(app: FastifyInstance): Promise<void> {
  const root = resolveSpaDir()
  if (!existsSync(join(root, 'index.html'))) {
    app.log?.warn?.(`[static] SPA not found at ${root}; serving API only`)
    return
  }

  await app.register(fastifyStatic, { root, prefix: '/', wildcard: false })

  // SPA history fallback: any GET that didn't match an API route or a real file
  // returns index.html — EXCEPT /api/* and /ws, which must 404/handle normally.
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      reply.code(404).type('application/json').send({ error: 'Not Found', path: req.url })
      return
    }
    reply.sendFile('index.html', root)
  })
}
```
> `wildcard: false` lets `@fastify/static` serve real files by path while leaving unmatched routes to the `setNotFoundHandler`, which implements the SPA fallback. The `/api`/`/ws` guard prevents the shell HTML from masking genuine API 404s (important for the SPA's fetch error handling).

- [ ] **Step 5: Wire it into `buildApp` (registered last)**

Edit `apps/electron/electron/server/app.ts`. At the **very end** of `buildApp`, after `await registerMedia(app)` and before `return app`:
```typescript
  // Static SPA + history fallback — MUST be last so /api, /ws, /healthz, auth win.
  const { registerStatic } = await import('./static')
  await registerStatic(app)

  return app
```
(Replace the existing bare `return app` with the block above.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/static.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Full server suite regression (agent-runnable)**

Run: `npx vitest run electron/server`
Expected: PASS — adding a `setNotFoundHandler` must not break existing route tests. If a prior test relied on the default 404 shape, reconcile (the handler above preserves JSON 404 for `/api`).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json electron/server/static.ts electron/server/app.ts electron/server/__tests__/static.test.ts
git commit -m "feat(0f): serve SPA + history fallback from the Fastify server"
```

---

### Task 4: The multi-stage Dockerfile

The core deliverable. Four stages: SPA build, server build, native-deps install (correct ABI), slim runtime. Authored to be build-ready; the actual `docker build` is **(OPERATOR)**.

**Files:**
- Create: `apps/electron/Dockerfile`

**Interfaces:**
- Consumes: `npm run build` (SPA → `out/renderer`), `npm run build:server` (Task 2 → `out/server/index.js`), the production `node_modules` with runtime-Node ABI native deps.
- Produces: an image whose `CMD` is `node out/server/index.js`, EXPOSE `8788`, `VOLUME /data`, `HIDOCK_DATA_ROOT=/data`, `HIDOCK_SPA_DIR=/app/out/renderer`.

- [ ] **Step 1: Write the Dockerfile**

Create `apps/electron/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1.7
# HiDock Hosted Hub — single-image server: built SPA + REST/WS API on one port.
# Build context: apps/electron/  (build from that directory).

# ---------------------------------------------------------------------------
# Stage 1: spa-build — build the React SPA with electron-vite/vite.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS spa-build
WORKDIR /app
# Install ALL deps (dev included) — vite/electron-vite are devDependencies.
# --ignore-scripts: skip electron-builder install-app-deps (Electron-ABI rebuild
# we do NOT want; the SPA build needs no native modules).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
# electron-vite build emits main + preload + renderer; we only keep out/renderer.
RUN npm run build
# Sanity: the SPA must exist.
RUN test -f out/renderer/index.html

# ---------------------------------------------------------------------------
# Stage 2: server-build — bundle electron/server/index.ts -> out/server/index.js.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS server-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:server
RUN test -f out/server/index.js

# ---------------------------------------------------------------------------
# Stage 3: native-deps — production install with native modules compiled for the
# RUNTIME Node (node:22), NOT Electron.
#
# WHY --ignore-scripts then explicit rebuild: package.json's postinstall is
# `electron-builder install-app-deps`, which rebuilds better-sqlite3/sodium-native
# against ELECTRON's Node ABI. Under plain Node that yields NODE_MODULE_VERSION
# mismatches at require() time. We skip that postinstall and let the native
# modules build/select prebuilds against THIS image's Node.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS native-deps
WORKDIR /app
# Build toolchain for native compilation (better-sqlite3 builds from source if no
# prebuild matches; sodium-native/usb ship prebuilds via node-gyp-build).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Production deps only; skip the Electron-ABI postinstall.
RUN npm ci --omit=dev --ignore-scripts
# Rebuild the native deps against THIS image's plain Node ABI.
# better-sqlite3: compiled (or prebuild for node22 linux-x64).
# sodium-native / usb: node-gyp-build picks the matching prebuild.
# ffmpeg-static: its install script downloads the linux-x64 ffmpeg binary; run it.
RUN npm rebuild better-sqlite3 \
    && npm rebuild sodium-native \
    && node node_modules/ffmpeg-static/install.js
# usb is optional for the server (device access is a browser gesture in hosted
# mode). If its native build is absent, the server must still run — do not fail.
RUN npm rebuild usb || echo "[native-deps] usb rebuild skipped (not required server-side)"
# Phase 2 (optional): sherpa-onnx-node is an optionalDependency; tolerate failure.
RUN npm rebuild sherpa-onnx-node 2>/dev/null || echo "[native-deps] sherpa-onnx-node not installed (Phase 2)"
# Smoke-load the must-have native modules to fail the build early on ABI mismatch.
RUN node -e "require('better-sqlite3'); require('sodium-native'); console.log('native ABI OK')"

# ---------------------------------------------------------------------------
# Stage 4: runtime — slim image, no toolchain, no dev deps, no source.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8788 \
    HIDOCK_DATA_ROOT=/data \
    HIDOCK_SPA_DIR=/app/out/renderer
# Production node_modules with runtime-ABI native deps.
COPY --from=native-deps /app/node_modules ./node_modules
# Built server bundle + sourcemap.
COPY --from=server-build /app/out/server ./out/server
# Built SPA.
COPY --from=spa-build /app/out/renderer ./out/renderer
# package.json present so node resolves "type"/exports correctly for the bundle.
COPY package.json ./

# /data holds the SQLite db, recordings, transcripts, config.json — bind to a
# host path (Unraid appdata) at run time.
VOLUME /data
EXPOSE 8788

# Run as the non-root 'node' user shipped in the base image; ensure it owns /data.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

# Container healthcheck hits the same /healthz the orchestrator/NPM can use.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "out/server/index.js"]
```

- [ ] **Step 2: Lint the Dockerfile (agent-runnable if hadolint is available)**

Run (from `apps/electron/`):
```bash
command -v hadolint >/dev/null && hadolint Dockerfile || echo "hadolint not installed — skip (operator can run it)"
```
Expected: either hadolint passes (or only low-severity style hints), or a clear skip message. Hadolint is optional; absence does not block.

- [ ] **Step 3: (OPERATOR) Real build**

On a machine with Docker + BuildKit, from `apps/electron/`:
```bash
DOCKER_BUILDKIT=1 docker build -t hidock-hub:local .
```
Expected: all four stages complete; the `native ABI OK` line prints in the `native-deps` stage. **This is an operator step** — it compiles `better-sqlite3` and downloads the ffmpeg binary, needs a Docker daemon, and is not autonomously verifiable in this environment. If `better-sqlite3` fails to compile, confirm `python3 make g++` are present in the `native-deps` stage (they are) and that the base image is `node:22` (prebuilds exist for node22 linux-x64).

- [ ] **Step 4: (OPERATOR) Run + healthz**

```bash
docker run --rm -p 8788:8788 \
  -e SESSION_SECRET="$(openssl rand -hex 24)" \
  -e GOOGLE_CLIENT_ID=dummy -e GOOGLE_CLIENT_SECRET=dummy \
  -e PUBLIC_URL=http://localhost:8788 \
  -v /tmp/hidock-data:/data \
  hidock-hub:local &
sleep 6
curl -fsS http://localhost:8788/healthz && echo " healthz OK"
curl -fsS http://localhost:8788/ | grep -q '<div id="root"' && echo "SPA served OK"
```
Expected: `healthz OK` and `SPA served OK`. (OAuth won't complete with dummy creds — that's Task 7.)

- [ ] **Step 5: Commit**

```bash
git add apps/electron/Dockerfile
git commit -m "feat(0f): multi-stage Dockerfile (SPA + server + runtime-ABI native deps)"
```

---

### Task 5: docker-compose for local/operator runs + env template

A compose file documents the exact run contract (env, port, volume) and gives the operator a one-command local equivalent of the Unraid deploy.

**Files:**
- Create: `apps/electron/docker-compose.yml`
- Create: `apps/electron/.env.example`

**Interfaces:**
- Consumes: the image from Task 4.
- Produces: a reproducible run contract: one service, port `8788`, volume `./data:/data`, env from `.env`.

- [ ] **Step 1: Write `.env.example`**

Create `apps/electron/.env.example`:
```bash
# ── Required (server refuses to boot without these; see server/config.ts) ──
# Google OAuth client (Web application type) — from Google Cloud Console.
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
# Public HTTPS URL users hit (NPM's domain). NO trailing slash needed (stripped).
# This is also the base for the OAuth redirect URI (see Task 7).
PUBLIC_URL=https://hub.example.com
# Session cookie signing key — MUST be >= 16 chars. Generate: openssl rand -hex 24
SESSION_SECRET=change-me-to-a-long-random-string

# ── Optional ──
# First admin (bootstrapped into allowed_users). Defaults to rogercoxjr@gmail.com.
ADMIN_EMAIL=you@yourdomain.com
# Internal listen port. Default 8788. NPM forwards to this.
PORT=8788
# Data root inside the container — keep /data (mapped to a host volume).
HIDOCK_DATA_ROOT=/data
# Encryption key for sensitive config values at rest (API keys in config.json).
# Absent => plaintext fallback. Generate: openssl rand -hex 32
HIDOCK_SECRET_KEY=

# Ollama base URL for local RAG/embeddings. Inside a container, 'localhost' is the
# CONTAINER, not the host — point at the host or the Ollama container.
#   Unraid host Ollama:        http://<unraid-host-ip>:11434
#   Docker Desktop host:       http://host.docker.internal:11434
#   Sibling Ollama container:  http://ollama:11434
# NOTE: config default is http://localhost:11434 (config.ts). See Task 6 for how
# OLLAMA_URL is applied (config override at boot, since the code reads config, not
# this env directly today).
OLLAMA_URL=http://host.docker.internal:11434

# Optional explicit ffmpeg path override (image bundles ffmpeg-static; usually unset).
# FFMPEG_PATH=/app/node_modules/ffmpeg-static/ffmpeg
```

- [ ] **Step 2: Write `docker-compose.yml`**

Create `apps/electron/docker-compose.yml`:
```yaml
# Local/operator run of the HiDock Hosted Hub.
# On Unraid this is expressed as a container template (Task 6) instead, but the
# contract (env, port, volume) is identical.
services:
  hidock-hub:
    build:
      context: .
      dockerfile: Dockerfile
    image: hidock-hub:local
    container_name: hidock-hub
    restart: unless-stopped
    env_file: .env
    ports:
      # host:container — NPM forwards to the host port; or attach NPM to the same
      # docker network and target the container directly on 8788.
      - "8788:8788"
    volumes:
      - ./data:/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8788/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

- [ ] **Step 3: Validate compose syntax (agent-runnable if docker compose CLI present)**

Run (from `apps/electron/`):
```bash
command -v docker >/dev/null && docker compose -f docker-compose.yml config >/dev/null && echo "compose valid" \
  || echo "docker compose CLI not present — operator validates"
```
Expected: `compose valid`, or a clear skip. (`docker compose config` parses + interpolates without building, so it's safe and needs no daemon image pulls.) If it complains about a missing `.env`, create one from `.env.example` first: `cp .env.example .env`.

- [ ] **Step 4: Confirm `.env` is gitignored**

Run (from repo root or `apps/electron/`):
```bash
grep -qE "(^|/)\.env$" ../../.gitignore apps/electron/.gitignore 2>/dev/null && echo "ignored" || echo "ADD .env to .gitignore"
```
Expected: `ignored`. If `ADD .env to .gitignore`, append `.env` to `apps/electron/.gitignore` (commit that, not `.env`). **Never commit a real `.env`** — only `.env.example`.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/docker-compose.yml apps/electron/.env.example
git commit -m "feat(0f): docker-compose + .env.example for operator runs"
```

---

### Task 6: Unraid appdata mapping + OLLAMA_URL wire-in note

Two things: (a) the Unraid-specific deployment notes (template fields, appdata volume), and (b) reconciling the requested `OLLAMA_URL` env with the fact that the code reads Ollama URLs from **config**, not directly from that env. This task ships a docs file and a tiny, well-scoped boot shim so `OLLAMA_URL` actually takes effect.

**Files:**
- Create: `apps/electron/docs/DEPLOY-UNRAID.md`
- Modify: `apps/electron/electron/server/index.ts` (apply `OLLAMA_URL` override into config at boot)
- Test: `apps/electron/electron/server/__tests__/ollama-env.test.ts`

**Interfaces:**
- Consumes: `getConfig()`/`updateConfig()` from `electron/main/services/config.ts` (config has `rag.ollamaBaseUrl` default `http://localhost:11434` and `summarization`/`transcription` Ollama fields).
- Produces: `applyEnvOverrides(): Promise<void>` (exported from `server/index.ts`) — at boot, if `OLLAMA_URL` is set, write it into the config's Ollama base URL so RAG/embeddings reach the host's Ollama instead of `localhost` inside the container.

- [ ] **Step 1: Write the failing test**

Create `apps/electron/electron/server/__tests__/ollama-env.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('OLLAMA_URL boot override', () => {
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-ollama-'))
    process.env.HIDOCK_DATA_ROOT = dir
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
    delete process.env.OLLAMA_URL
  })

  it('writes OLLAMA_URL into the RAG ollama base url when set', async () => {
    process.env.OLLAMA_URL = 'http://host.docker.internal:11434'
    const cfg = await import('../../main/services/config')
    await cfg.initializeConfig()
    const { applyEnvOverrides } = await import('../index')
    await applyEnvOverrides()
    expect(cfg.getConfig().rag.ollamaBaseUrl).toBe('http://host.docker.internal:11434')
  })

  it('leaves config untouched when OLLAMA_URL is unset', async () => {
    delete process.env.OLLAMA_URL
    const cfg = await import('../../main/services/config')
    await cfg.initializeConfig()
    const before = cfg.getConfig().rag.ollamaBaseUrl
    const { applyEnvOverrides } = await import('../index')
    await applyEnvOverrides()
    expect(cfg.getConfig().rag.ollamaBaseUrl).toBe(before)
  })
})
```
> Note: if the live config shape names the field differently (verify against `config.ts` — it has `rag.ollamaBaseUrl` per the read at lines 41–43), align the assertion and the implementation to the real key. Adjust both together.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/server/__tests__/ollama-env.test.ts`
Expected: FAIL — `applyEnvOverrides` is not exported from `../index`.

- [ ] **Step 3: Implement `applyEnvOverrides` and call it in `startServer`**

Edit `apps/electron/electron/server/index.ts`. Add the export and invoke it right after `bootFoundation()`:
```typescript
import { getConfig, updateConfig } from '../main/services/config'
```
```typescript
/**
 * Apply container-env overrides onto the on-disk config after the foundation
 * boots. Today the only one is OLLAMA_URL: inside a container, the config's
 * default http://localhost:11434 points at the container itself, so the operator
 * sets OLLAMA_URL to the host/sibling Ollama. We write it into config so the
 * existing RAG/embedding code (which reads config, not env) picks it up.
 */
export async function applyEnvOverrides(): Promise<void> {
  const ollama = process.env.OLLAMA_URL
  if (ollama && getConfig().rag.ollamaBaseUrl !== ollama) {
    await updateConfig('rag', { ollamaBaseUrl: ollama })
  }
}
```
In `startServer`, after `await bootFoundation()`:
```typescript
  await bootFoundation()
  await applyEnvOverrides()
  ensureBootstrapAdmin(cfg.adminEmail)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/server/__tests__/ollama-env.test.ts`
Expected: PASS (2 tests). If the field name differs, fix `applyEnvOverrides` + the test together and re-run.

- [ ] **Step 5: Write the Unraid deploy doc**

Create `apps/electron/docs/DEPLOY-UNRAID.md`:
```markdown
# Deploying the HiDock Hosted Hub on Unraid (behind nginxproxymanager)

This is the **operator runbook**. The image is the multi-stage build from
`apps/electron/Dockerfile`. The agent that wrote this cannot perform these steps
— they need the Unraid host, a domain, and a Google OAuth client.

## 1. Build & publish the image

On a build host (or Unraid with the Docker buildx plugin), from `apps/electron/`:

    DOCKER_BUILDKIT=1 docker build -t <registry>/hidock-hub:<tag> .
    docker push <registry>/hidock-hub:<tag>

(Or build locally on Unraid and reference the local image tag.)

## 2. Unraid container template

Add a container (Docker tab → Add Container) with:

| Field            | Value                                                        |
|------------------|-------------------------------------------------------------|
| Repository       | `<registry>/hidock-hub:<tag>`                               |
| Network Type     | the same custom bridge NPM is on (so NPM can reach it by name), or `bridge` |
| Port             | Container `8788` → Host `8788` (only needed if NPM targets host:port) |
| Restart Policy   | `unless-stopped`                                            |

### Volume mapping (the /data appdata mount)

| Container Path | Host Path                              | Mode |
|----------------|----------------------------------------|------|
| `/data`        | `/mnt/user/appdata/hidock-hub`         | RW   |

This single mount holds the SQLite DB, recordings, transcripts, and
`config.json`. Back up `/mnt/user/appdata/hidock-hub` to back up everything.
The container runs as the `node` user (uid 1000); ensure the appdata dir is
writable by uid 1000 (Unraid's default appdata perms usually are; if not,
`chown -R 1000:1000 /mnt/user/appdata/hidock-hub`).

### Environment variables

| Variable               | Required | Example / Notes                                   |
|------------------------|----------|---------------------------------------------------|
| `GOOGLE_CLIENT_ID`     | yes      | `…apps.googleusercontent.com`                     |
| `GOOGLE_CLIENT_SECRET` | yes      | from Google Cloud Console                         |
| `PUBLIC_URL`           | yes      | `https://hub.example.com` (your NPM domain)       |
| `SESSION_SECRET`       | yes      | `openssl rand -hex 24` (≥16 chars)                |
| `ADMIN_EMAIL`          | no       | first admin; defaults to `rogercoxjr@gmail.com`   |
| `PORT`                 | no       | `8788` (match the container port)                 |
| `HIDOCK_DATA_ROOT`     | no       | keep `/data`                                      |
| `HIDOCK_SECRET_KEY`    | no       | `openssl rand -hex 32`; encrypts API keys at rest |
| `OLLAMA_URL`           | no       | `http://<unraid-ip>:11434` or `http://ollama:11434` |

> `localhost` inside the container is NOT the Unraid host. Point `OLLAMA_URL` at
> the host IP or a sibling Ollama container. If you run the Ollama Unraid app,
> use the same custom network and `http://<ollama-container-name>:11434`.

## 3. Start it

Apply the template. Check the container log for `app.listen` success and hit the
healthcheck: `curl http://<unraid-ip>:8788/healthz` → `{"status":"ok"}`.
(Direct host access bypasses TLS — fine for a smoke test; real access is via NPM.)

## 4. Reverse proxy & OAuth

See `DEPLOY-NPM.md` for the nginxproxymanager proxy host (TLS, WebSocket, upload
tuning) and the Google OAuth redirect URI. **Do those before sign-in works.**
```

- [ ] **Step 6: Run the server suite (agent-runnable)**

Run: `npx vitest run electron/server`
Expected: PASS — the new override + test are green and nothing else regressed.

- [ ] **Step 7: Commit**

```bash
git add electron/server/index.ts electron/server/__tests__/ollama-env.test.ts docs/DEPLOY-UNRAID.md
git commit -m "feat(0f): OLLAMA_URL boot override + Unraid deploy runbook"
```

---

### Task 7: nginxproxymanager config notes (TLS, WebSocket, uploads, OAuth redirect)

NPM is the external reverse proxy: it terminates TLS (Let's Encrypt), forwards HTTP to the container, and must pass the `/ws` WebSocket upgrade and large recording uploads. This task ships the NPM runbook and pins the exact OAuth redirect URI. All live verification is **(OPERATOR)**.

**Files:**
- Create: `apps/electron/docs/DEPLOY-NPM.md`

**Interfaces:**
- Consumes: `PUBLIC_URL` (must equal the NPM domain), the OIDC callback route from plan 0b (the OAuth redirect URI), the `/ws` route from plan 0c, the upload routes guarded by `@fastify/multipart` (`fileSize: 500 MB`, `app.ts:33`).
- Produces: operator-facing NPM config (no code).

- [ ] **Step 1: Confirm the OAuth callback path from plan 0b (read-only)**

Run (from `apps/electron/`):
```bash
grep -rnE "callback|redirect_uri|/auth/|/oauth" electron/server/auth.ts electron/server/oidc.ts | head -20
```
Expected: the exact callback route (e.g. `/api/auth/google/callback` or `/auth/callback`). **Record the literal path** — the Google redirect URI is `${PUBLIC_URL}<that path>`. The doc below uses `${PUBLIC_URL}/api/auth/google/callback` as the placeholder; replace it with the real path this grep prints.

- [ ] **Step 2: Write the NPM deploy doc**

Create `apps/electron/docs/DEPLOY-NPM.md`:
```markdown
# nginxproxymanager (NPM) config for the HiDock Hosted Hub

NPM sits in front of the container: it terminates HTTPS with a Let's Encrypt cert
and proxies to the hub on port 8788. **These are operator steps** — they need the
domain, DNS, and the running container.

## 1. Proxy Host (Details tab)

| Field                  | Value                                                     |
|------------------------|----------------------------------------------------------|
| Domain Names           | `hub.example.com` (must equal `PUBLIC_URL`'s host)       |
| Scheme                 | `http`                                                    |
| Forward Hostname / IP  | the container name (if NPM is on the same docker network) or the Unraid host IP |
| Forward Port           | `8788`                                                    |
| Cache Assets           | off (the SPA is already hash-cached; avoid stale shells)  |
| Block Common Exploits  | on                                                        |
| **Websockets Support** | **ON** ← required for `/ws` (see §3 if the toggle isn't enough) |

## 2. TLS (SSL tab)

- SSL Certificate → **Request a new SSL Certificate** (Let's Encrypt).
- **Force SSL: ON** (redirect http→https).
- **HTTP/2 Support: ON.**
- Agree to the Let's Encrypt ToS; DNS for `hub.example.com` must already resolve
  to the NPM host and ports 80/443 must reach NPM for the ACME challenge.
- `PUBLIC_URL` MUST be `https://hub.example.com` (https, exact host). The server
  sets the session cookie `secure: true` (`app.ts` `cookieSecure: true`), so the
  cookie only travels over HTTPS — TLS at NPM is mandatory, not optional.

## 3. WebSocket Upgrade passthrough for /ws

The "Websockets Support" toggle adds the standard upgrade headers globally. If
the `/ws` endpoint (plan 0c broadcaster) still fails to upgrade, add an explicit
location in the proxy host's **Advanced** tab:

    location /ws {
        proxy_pass http://$forward_scheme://$server:$port;  # NPM fills these
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;   # long-lived WS; don't time out idle sockets
        proxy_send_timeout 3600s;
    }

(With the toggle ON, the global config usually suffices; this block is the
fallback. The server runs Fastify with `trustProxy: true` — `app.ts:20` — so it
honors `X-Forwarded-*`.)

## 4. Large-upload proxy tuning

Recording uploads can be large (`@fastify/multipart` allows up to 500 MB —
`app.ts:33`). NPM's nginx defaults cap the body well below that. In the
**Advanced** tab add (or set in NPM's global config):

    client_max_body_size 0;        # 0 = no nginx-side limit; the app enforces 500MB
    proxy_request_buffering off;    # stream large uploads through, don't buffer to disk
    proxy_read_timeout 3600s;       # allow slow/large uploads + long transcriptions
    proxy_send_timeout 3600s;

> `client_max_body_size 0` defers the limit to the app (Fastify's 500 MB). If you
> prefer a hard proxy cap, set it slightly above 500m, e.g. `client_max_body_size 520m`.

## 5. Google OAuth redirect URI

In Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Client
(Web application):

- **Authorized JavaScript origins:** `https://hub.example.com`
- **Authorized redirect URIs:** `https://hub.example.com/api/auth/google/callback`
  ← REPLACE the path with the actual callback route from plan 0b
  (Task 7 Step 1's grep prints it). It MUST be `${PUBLIC_URL}` + that exact path,
  https, exact host, no trailing slash mismatch — Google matches it literally.

The flow: user hits `https://hub.example.com` → SPA → sign-in → Google →
redirect back to the callback on the SAME public URL → session cookie set
(secure, over TLS) → `allowed_users` gate (plan 0b) → app.

## 6. Operator verification checklist (cannot be automated)

- [ ] `https://hub.example.com/healthz` returns `{"status":"ok"}` over a valid cert.
- [ ] `https://hub.example.com/` loads the SPA shell.
- [ ] DevTools → Network → WS shows `/ws` connected (status 101), not failing.
- [ ] A real Google sign-in completes and lands in the app (redirect URI matches).
- [ ] A large recording upload succeeds (no nginx 413).
```

- [ ] **Step 3: Cross-check the redirect path placeholder against real code**

Re-run the Step 1 grep and confirm the path written in `DEPLOY-NPM.md` §5 matches what `auth.ts`/`oidc.ts` actually register. If the real callback is, e.g., `/auth/google/callback` (no `/api`), update §5 and the §3 examples accordingly. Consistency here is load-bearing — a wrong redirect URI silently breaks OAuth.

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOY-NPM.md
git commit -m "feat(0f): nginxproxymanager runbook (TLS, WS passthrough, uploads, OAuth)"
```

---

### Task 8: README pointer + final gate

Make the deployment artifacts discoverable and run the repo's quality gates one last time.

**Files:**
- Modify: `apps/electron/README.md` (add a "Self-hosting (Docker)" pointer)

**Interfaces:**
- Consumes: all prior tasks' artifacts.
- Produces: a discoverable entry point to the deploy docs.

- [ ] **Step 1: Add a self-hosting section to the README**

Edit `apps/electron/README.md` — add near the top-level usage section:
```markdown
## Self-hosting (Docker, single container)

The hub can run headless as one container serving the SPA + REST/WS API on one
port, behind a reverse proxy. See:

- `Dockerfile` — multi-stage build (SPA + server + runtime-ABI native deps)
- `docker-compose.yml` + `.env.example` — local/operator run contract
- `docs/DEPLOY-UNRAID.md` — Unraid appdata mapping + container template
- `docs/DEPLOY-NPM.md` — nginxproxymanager TLS, WebSocket passthrough, OAuth

Required env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL`,
`SESSION_SECRET` (see `.env.example`). State persists to the `/data` volume.

> The real `docker build`, Unraid deploy, and live Google OAuth are operator
> steps (need a Docker host, the Unraid box, a domain, and a Google project).
```

- [ ] **Step 2: Repo quality gates (agent-runnable)**

Run (from `apps/electron/`):
```bash
npm run typecheck && npm run lint && npx vitest run electron/server
```
Expected: typecheck clean, lint clean, server suite green. (Full `npm run test:run` is fine too but the server suite is the slice this plan touches.)

- [ ] **Step 3: Verify both build artifacts produce (agent-runnable)**

Run (from `apps/electron/`):
```bash
npm run build && test -f out/renderer/index.html && echo "SPA OK"
npm run build:server && test -f out/server/index.js && echo "SERVER OK"
```
Expected: `SPA OK` and `SERVER OK`. This proves the two build inputs the Dockerfile relies on actually emit, without needing Docker.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "feat(0f): README self-hosting pointer + final gate"
```

---

## Operator Acceptance (the autonomous boundary)

Everything above the agent can author, locally build (SPA + server), and unit-test. The end-to-end acceptance below **cannot** be done in the agent's environment and is the operator's responsibility:

1. **`docker build`** of `apps/electron/Dockerfile` on a Docker host (compiles `better-sqlite3`, downloads the ffmpeg binary, smoke-loads native modules). Verifiable only with a Docker daemon.
2. **Unraid deploy** — container template + `/data` → `/mnt/user/appdata/hidock-hub` + env vars + start.
3. **NPM proxy host** — Let's Encrypt TLS, WebSocket toggle/passthrough, upload tuning.
4. **Live Google OAuth** — register the client, set the exact redirect URI (`${PUBLIC_URL}` + the real callback path), complete a sign-in round-trip over HTTPS.
5. **The native-ABI guarantee in practice** — the `native ABI OK` line in the `native-deps` stage and a successful `require('better-sqlite3')` under the runtime Node prove the ABI is right; the failure mode this plan guards against (running `electron-builder install-app-deps` and getting an Electron-ABI module) is only fully observable on the real image.

---

## Self-Review

**Scope coverage (the 0f brief):**
- Multi-stage Dockerfile (SPA via electron-vite/vite, server build, slim Node runtime carrying `better-sqlite3` + `sodium-native` + `ffmpeg` + Phase-2 `sherpa-onnx`) → **Task 4** (4 stages), with the SPA/server builds made real in **Tasks 2–3**.
- Serving static SPA + REST/WS on one port from `electron/server/index.ts` (`startServer`) → **Task 3** (static + fallback, registered last in `buildApp`); single `app.listen` is preserved (`index.ts` unchanged on that axis).
- `/data` volume for SQLite db + recordings + transcripts + config → **Task 4** (`VOLUME /data`, `HIDOCK_DATA_ROOT=/data`) + **Global Constraints** (state-under-/data) + **Task 6** appdata mapping.
- Env (`GOOGLE_CLIENT_ID/SECRET`, `PUBLIC_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, `OLLAMA_URL`, `HIDOCK_DATA_ROOT`) → **Task 5** `.env.example` + **Task 6** Unraid env table; required-var contract pulled verbatim from `server/config.ts` into Global Constraints; `OLLAMA_URL` actually wired (config override) in **Task 6** because the code reads config, not that env.
- Unraid appdata mapping → **Task 6** `DEPLOY-UNRAID.md`.
- NPM config (TLS via Let's Encrypt, WebSocket Upgrade passthrough for `/ws`, large-upload tuning, OAuth redirect URI) → **Task 7** `DEPLOY-NPM.md`, all four sub-items as explicit sections; the 500 MB multipart limit is sourced from `app.ts:33` and `trustProxy:true` from `app.ts:20`.
- **CALLED OUT**: real docker build + Unraid deploy + live Google OAuth are operator steps → the **⚠️ Operator-Only Verification** banner up top, per-task **(OPERATOR)** markers, and the **Operator Acceptance** section.
- **CALLED OUT**: better-sqlite3/sodium-native ABI must target the runtime Node, and the Electron `postinstall` rebuild is wrong for the server image → **Global Constraints** (Runtime Node ABI ≠ Electron ABI) + **Task 4** `native-deps` stage (`--ignore-scripts` then explicit `npm rebuild` + a `require()` smoke-load).
- **Do NOT implement** → this is a plan document only; every task is checkbox steps, no code was applied to the repo.

**Discovered prerequisites surfaced (not silently assumed):** the server is not yet a build target (**Task 2** adds `build:server`), the SPA is not yet served by Fastify (**Task 3** adds `@fastify/static`), and `audio-normalize.ts` still imports `electron` `app` (**Task 0** gate flags it as a blocking/risk dependency on the foundation plans, with the fix described but deliberately not implemented).

**Placeholder scan:** No "TBD/TODO/handle edge cases". The one intentional placeholder is the OAuth callback **path** in `DEPLOY-NPM.md`, which Task 7 Steps 1 + 3 resolve against `auth.ts`/`oidc.ts` by grep (the path lives in plan 0b's code, not 0f's) — it is a documented lookup, not an unfilled blank.

**Type/contract consistency:** `registerStatic(app)` defined in Task 3 and called in Task 3 Step 5 + the test match. `applyEnvOverrides()` defined in Task 6 Step 3, exported from `server/index.ts`, asserted in Task 6 Step 1 test, and called in `startServer` — names/signatures consistent. Env var names match across Global Constraints, `.env.example` (Task 5), Unraid table (Task 6), and `server/config.ts`. The single-port/single-process invariant is asserted in Global Constraints and never violated (no second web server; NPM is external). Native-dep set (`better-sqlite3`, `sodium-native`, `ffmpeg-static`, `usb`, `sherpa-onnx-node`) is identical across the esbuild `external` list (Task 2), the `native-deps` rebuild block (Task 4), and Global Constraints.
