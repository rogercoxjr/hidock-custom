> **STATUS 2026-07-07: ALL 13 FIXED** — Class A in commit 5366f267, Class B in 3b624bde (each TDD + reviewed). See below for the original findings.

# Hosted-mode contract & wiring audit — 2026-07-07

Adversarially-verified findings (13 confirmed of 35 flagged) from a fan-out audit of every REST SDK group vs its Fastify route + a Phase-1 stub-consumer scan. All break in **hosted mode only** (Electron desktop uses the preload bridge / main-process device).

## Class A — SDK↔route contract mismatches (7) — direct HTTP breaks

| # | Method | Kind | Effect | Fix |
|---|--------|------|--------|-----|
| A1 | `assistant.getConversations` | response envelope | route returns `{items,total}`, SDK returns `r.data` unwrapped → Chat history never loads (`history is not iterable`) | unwrap `.items` in SDK |
| A2 | `calendar.toggleAutoSync` | request key | SDK sends `{autoSync}`, route wants `{syncEnabled}` → 400 | rename SDK key to `syncEnabled` |
| A3 | `quality.batchAutoAssess` | request key | SDK sends `{recordingIds}`, route wants `{ids}` → 400 | rename SDK key to `ids` |
| A4 | `rag.removeLastMessages` | path | SDK POSTs `/api/rag/session/trim`, route is `/api/rag/sessions/:id/trim` → 404 | fix SDK path + move id to path segment |
| A5 | `rag.clearSession` | path | SDK POSTs `/api/rag/session/clear`, route is `/api/rag/sessions/:id/clear` → 404 | fix SDK path + id in path |
| A6 | `storagePolicy.executeCleanup` | request key | SDK sends `{recordingIds,archive}`, route wants `{ids}` → 400 | align SDK/route keys |
| A7 | `deviceCache.saveAll` | request shape | SDK PUTs a bare array, route wants `{files:[...]}` → 400 (the device-cache 400 seen live) | wrap body as `{files}` |

## Class B — Phase-1 stub consumers (6) — device paths still calling stubs

| # | Stub method | Consumer / user action | Severity |
|---|-------------|------------------------|----------|
| B1 | `downloadService.ensureBaseline` | `useDeviceSubscriptions.ts:31` — auto-sync-on-connect throws before it starts | high |
| B2 | `downloadService.getFilesToSync` | `Device.tsx:554` — **"Sync All" button** (computes files-to-sync *before* performSync; still broken even after the bulk fix) | high |
| B3 | `downloadService.retryFailed` | `useDownloadOrchestrator.ts:85` → OperationsPanel "Retry failed" button | high |
| B4 | `downloadService.cancelActive` | `useDeviceSubscriptions.ts:132` — disconnect cleanup throws (unhandled) | medium |
| B5 | `downloadService.getState` | `useDownloadOrchestrator.ts:260` — renderer download-queue loop (largely vestigial in hosted) | medium |
| B6 | `downloadService.cancelAll` | `useOperations.ts:230` — "Cancel all downloads" toast never shows | medium |

## Unverified (verifier agent died on API error — manual check needed)
- `rag.globalSearch` (flagged, verify incomplete)
- `downloadService.getState` / `cancelAll` had a verify retry die but were confirmed via other runs (B5/B6).

## Notes
- Class A fixes are all one-liners (key rename / path fix / `.items` unwrap) — same class as the already-fixed `transcripts.getByRecordingIds` and `knowledge.getAll`. Each needs a contract test pinning the request key / response shape.
- Class B needs the hosted device-sync client or graceful no-op handling. B2 means "Sync All" is still broken despite the performSync fix — getFilesToSync must be handled first.
- Root pattern: the 0e REST-SDK migration and Phase-1 device stubs were tested per-side in isolation, so SDK↔route drift and stub-consumer reachability went uncaught until real end-to-end use.
