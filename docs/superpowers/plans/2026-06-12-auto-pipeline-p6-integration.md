# Auto-Pipeline P6 — Integration E2E + AC1 Readiness Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase P6 of `docs/superpowers/specs/2026-06-11-auto-pipeline-model-choice-design.md` (§8, §12 → AC1): the whisper+ollama integration e2e variant proving the full chain against the real database, final whole-app gates, and the hand-off package for the user's single physical P1 plug-in (the only physical-device criterion).

**Architecture:** One new test file mirroring `e2e-smoke.test.ts` (real in-memory sql.js, real temp audio file, boundary mocks only) but configured `transcription.provider='openai-whisper'` + `summarization.provider='ollama-cloud'`, with `fetch` (OpenAI + Ollama shapes) and `child_process` (ffmpeg) as the mocked boundaries. Plus a written AC1 checklist for the user.

---

## Environment / invariants

Same as P2-P5 (apps/electron; explicit RCs; `@vitest-environment node`; EOL parity; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`). Branch: `auto-pipeline-p5-p6` (already created — SKIP branch steps). ⛔ USB: ZERO hardware interaction — AC1's physical test is performed by the USER, never by an agent. This plan only *prepares* it.

---

### Task 1: `e2e-whisper-ollama.test.ts` — the integration variant

**Files:**
- Create (Test): `electron/main/services/__tests__/e2e-whisper-ollama.test.ts`

- [ ] **Step 1: Read `e2e-smoke.test.ts` fully** — copy its fixture architecture verbatim (hoisted temp dir, real `initializeDatabase()`, real temp audio file, boundary mocks: electron / config / file-storage / vector-store; it drives `processDownload` then `transcribeManually` with `autoTranscribe: false`). Note how its config mock is shaped (it gained `summarization` defaults in P3 and `openaiApiKey`/`whisperModel` fields in P2 — verify).
- [ ] **Step 2: Write the test.** One describe, one long test (mirroring e2e-smoke's style) plus a second test for the failure seam:
  - **Config mock:** `transcription: { provider: 'openai-whisper', openaiApiKey: 'sk-test', whisperModel: 'whisper-1', geminiApiKey: '', geminiModel: 'gemini-2.0-flash-exp', autoTranscribe: false, language: 'es' }`, `summarization: { provider: 'ollama-cloud', ollamaCloudApiKey: 'ok-test', ollamaCloudModel: 'gpt-oss:120b' }`.
  - **Boundary mocks:** (a) `vi.mock('child_process')` so audio-normalize's ffmpeg invocations succeed without a binary — `execFile` callback-style success; mock `fs.statfsSync`-dependent guard path or mock `../asr/audio-normalize` itself? **NO — exercise the real audio-normalize** with mocked `child_process` + a real small temp file (the transcode "output" is created by the test writing a small file at the expected `outPath` before/inside the execFile mock — read audio-normalize.ts to wire the mock so `statSync(outPath)` finds a ≤24MB file). If wiring the real module proves too brittle for an e2e (report it), mocking `../asr/audio-normalize` to return `{ files: [realTempAudioPath] }` is the sanctioned fallback — the unit suite already pins its internals; state which route you took. (b) `vi.stubGlobal('fetch', ...)` routing by URL: `api.openai.com/v1/audio/transcriptions` → `{ ok: true, json: async () => ({ text: 'WHISPER TRANSCRIPT TEXT', language: 'english' }) }`; `ollama.com/api/chat` → first call (analysis) returns `{ message: { content: '{"summary":"OLLAMA SUMMARY","action_items":["a1"],"topics":["t"],"key_points":["k"],"title_suggestion":"Title","question_suggestions":["q?"],"language":"en"}' } }`, second call (actionables) returns `{ message: { content: '[]' } }`.
  - **Flow:** seed a recording via the e2e-smoke idiom (processDownload with real bytes) → `transcribeManually(recordingId)` → assert the transcript row: `full_text === 'WHISPER TRANSCRIPT TEXT'`, `summary === 'OLLAMA SUMMARY'`, `transcription_provider === 'openai-whisper'`, `transcription_model === 'whisper-1'`, `summarization_provider === 'ollama-cloud'`, `summarization_model === 'gpt-oss:120b'`, `language === 'english'` (whisper-supplied, NOT overwritten by the analysis 'en' — the COALESCE contract end-to-end); recording `transcription_status === 'complete'`; the OpenAI fetch carried `Authorization: Bearer sk-test` and FormData with `model=whisper-1`; the Ollama fetch carried `Bearer ok-test` and `format:'json'`.
  - **Failure-seam test (AC5 chain, integration-level):** same fixture but `ollamaCloudApiKey: ''` → `transcribeManually` rejects with `Ollama Cloud API key not configured`; transcript row HAS `full_text` (Whisper ran, paid work preserved) and `summarization_provider` IS NULL (Stage-2-resumable).
- [ ] **Step 3: Run it + the full main-process suite, explicit RCs.** Commit: `test(electron): whisper+ollama integration e2e — full chain against real DB, per-stage provider columns (auto-pipeline P6)`

---

### Task 2: Final gates + AC1 readiness package

**Files:**
- Create: `docs/superpowers/plans/2026-06-12-ac1-physical-test-checklist.md`

- [ ] **Step 1: Full gates** from apps/electron: `npm run typecheck; echo RC=$?`, `npm run lint 2>&1 | tail -3; echo RC=${PIPESTATUS[0]}`, `npm run test:run > /tmp/p6gate.txt 2>&1; echo RC=$?; grep -E "Test Files|Tests " /tmp/p6gate.txt` — all RC 0.
- [ ] **Step 2: Write the AC1 checklist doc** (the user performs this — agents NEVER touch the device). Contents:
```markdown
# AC1 — Physical P1 Plug-In Test (performed by the user, ONCE)

Pre-flight (in the app, before plugging in):
1. Settings → Transcription: provider = OpenAI Whisper; paste OpenAI API key (sk-…); model shows whisper-1.
2. Settings → Summarization: provider = Ollama Cloud; paste ollama.com API key; Fetch models → pick your model (e.g. gpt-oss:120b); press Test → expect success toast.
3. Device page: Auto-connect ON, Auto-download ON, Auto-transcribe ON (defaults).
4. Leave the app running.

The test:
5. Plug in the HiDock P1. Expected on FIRST-EVER connect of this device: activity log shows
   "Baseline established: N existing recordings" and NOTHING downloads (AC2 baseline).
6. Record one short test recording on the P1 (or unplug, record, re-plug).
7. Re-plug / reconnect. Expected, with no interaction: the new recording downloads,
   transcribes via Whisper, summarizes via your Ollama model, and appears in the
   Library with transcript + summary (badges: synced → processing → complete).
8. Verify in the recording's detail panel: transcript text present, summary present,
   Re-summarize button available.

If anything fails: the failure chip / per-row badges show the error; check Settings keys
first (a key fix auto-retries the queue). Report what you saw — do NOT retry the USB
connection rapidly; one clean reconnect at most (USB safety).
```
  Adjust wording to match the real UI labels found in Settings.tsx/Device.tsx (read them; do not invent labels).
- [ ] **Step 3: Commit** the checklist + report AC evidence: integration test names (Task 1), gates output, and the statement that AC1 awaits the user's physical run.

## Done criteria (spec §12 P6)
- [ ] Whisper+Ollama integration e2e green against the real DB (full chain + failure seam + COALESCE language contract).
- [ ] All gates green on the final tree.
- [ ] AC1 checklist written with real UI labels; physical test explicitly handed to the user.
