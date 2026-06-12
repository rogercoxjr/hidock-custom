# Auto-Pipeline P2 — Whisper ASR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase P2 of `docs/superpowers/specs/2026-06-11-auto-pipeline-model-choice-design.md` (§12; sections §5.1, §5.4, §5.6 → AC4): the `openai-whisper` ASR provider with always-transcode ffmpeg normalization + chunking, encrypted `openaiApiKey` config, the Settings Transcription-card provider picker, and the `transcription:validateConfig` preflight that replaces the hardcoded Gemini-key gates in `useOperations`.

**Architecture:** All in `apps/electron`. New: `asr/whisper-asr.ts`, `asr/audio-normalize.ts` (ffmpeg), `services/provider-errors.ts` (typed errors — P3 reuses, P4's parking consumes). Modified: `config.ts` (provider union + 2 new fields + crypto both-sites + `__enc__` guard), the two duplicated renderer `AppConfig` types, `asr-provider.ts` (factory case), `transcription.ts` (Stage-1 model per provider + 1 NON_RETRYABLE string), `recording-handlers.ts` + `preload/index.ts` (validateConfig IPC), `useOperations.ts` (preflight), `Settings.tsx` (card), `electron-builder.yml` (asarUnpack).

**Tech Stack:** Electron 39 main (Node 22: global `fetch`/`FormData`/`Blob`), `ffmpeg-static` (spawn/execFile, monorepo precedent in meeting-recorder), sql.js, Vitest (`@vitest-environment node` for main-process tests).

---

## Environment / invariants (read before every task)

- Work from `apps/electron`: `cd /c/Users/rcox/hidock-tools/hidock-next/apps/electron` (Git Bash).
- Single test file: `npx vitest run electron/main/services/__tests__/<file>.test.ts; echo RC=$?` — **always check RCs explicitly; `| tail` masks failures.**
- ⛔ **USB safety:** none of P2 touches USB. If you find yourself in jensen/download files, stop.
- TDD per task. Main-process test files need `// @vitest-environment node` (jsdom is the vitest default here).
- House test pattern: real sql.js in-memory DB + boundary mocks only — copy from `two-stage-worker.test.ts` / `providers-p1.test.ts`.
- EOL: after staging, `git diff --cached --stat` must equal `git diff --cached --ignore-cr-at-eol --stat`; fix NEW files with `sed -i 's/\r$//'`.
- Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Spec is authoritative (§5.1/§5.4/§5.6, §7.1 strings, §7.4 timeout). Plan vs spec conflict → spec wins, report it.
- Branch: create `auto-pipeline-p2` off `main` at start (Task 1 Step 0).

## File structure

| File | Responsibility |
|---|---|
| `electron/main/services/provider-errors.ts` (create) | `ProviderRateLimitError` (provider, retryAfterMs?) + `ProviderAuthError` — typed errors P3 reuses and P4 parking consumes |
| `electron/main/services/asr/audio-normalize.ts` (create) | ffmpeg path resolution (asar rewrite), always-transcode to 16 kHz mono 32 kbps MP3, segment >24 MB, temp-dir hygiene, disk guard |
| `electron/main/services/asr/whisper-asr.ts` (create) | OpenAI `/v1/audio/transcriptions` provider (multipart, `verbose_json`, 10-min timeout, chunk loop) |
| `electron/main/services/config.ts` (modify) | provider union, `openaiApiKey`/`whisperModel`, crypto both-sites, `__enc__` guard |
| `src/types/index.ts` + `src/types/stores.ts` (modify) | the DUPLICATED renderer `AppConfig` — both must mirror config.ts |
| `electron/main/services/asr/asr-provider.ts` (modify) | `'openai-whisper'` factory case |
| `electron/main/services/transcription.ts` (modify) | Stage-1 `transcription_model` per provider; +1 NON_RETRYABLE string |
| `electron/main/ipc/recording-handlers.ts` + `electron/preload/index.ts` (modify) | `transcription:validateConfig` |
| `src/hooks/useOperations.ts` (modify) | preflight replaces both Gemini-key gates |
| `src/pages/Settings.tsx` (modify) | provider toggle + Whisper fields in the Transcription card |
| `electron-builder.yml` (modify) | `asarUnpack` + `'**/ffmpeg-static/**'` |
| Tests | `__tests__/audio-normalize.test.ts`, `__tests__/whisper-asr.test.ts`, `__tests__/config-crypto.test.ts`, extend `providers-p1.test.ts`, `useOperations` + `Settings` test updates |

---

### Task 1: Config — provider union, new fields, crypto both-sites, `__enc__` guard

**Files:**
- Modify: `electron/main/services/config.ts`
- Modify: `src/types/index.ts` (~line 163-169), `src/types/stores.ts` (~line 305-311)
- Create (Test): `electron/main/services/__tests__/config-crypto.test.ts`

- [ ] **Step 0: Branch.** `cd /c/Users/rcox/hidock-tools/hidock-next && git checkout main && git checkout -b auto-pipeline-p2 && cd apps/electron`

- [ ] **Step 1: Failing test.** Create `config-crypto.test.ts` (`@vitest-environment node`). Mock `electron` exposing a controllable `safeStorage` (`isEncryptionAvailable: () => true`, `encryptString: (s) => Buffer.from('ENC:' + s)`, `decryptString: (b) => b.toString().replace(/^ENC:/, '')`) and `app.getPath` → a per-test `mkdtempSync` dir. Tests:
  1. **Cold-start round-trip:** `initializeConfig()` → `saveConfig({ transcription: { ...getConfig().transcription, openaiApiKey: 'sk-secret' } })` → read the config.json file from disk and assert the stored `transcription.openaiApiKey` starts with `'__enc__'` and does NOT contain `'sk-secret'` → re-run `initializeConfig()` (fresh module state — use `vi.resetModules()` + dynamic re-import) → `getConfig().transcription.openaiApiKey === 'sk-secret'`.
  2. **`__enc__` idempotency guard:** call the exported-for-test `encryptSensitive('__enc__abc')` (export it) → returns `'__enc__abc'` unchanged (no double-wrap).
  3. **Defaults:** fresh `initializeConfig()` with no file → `getConfig().transcription.provider === 'gemini'`, `whisperModel === 'whisper-1'`, `openaiApiKey === ''` (deep-merge fills new fields).
- [ ] **Step 2: Run — FAIL** (fields don't exist).
- [ ] **Step 3: Implement in `config.ts`.**
  (a) AppConfig (lines 36-42): replace
```ts
  transcription: {
    provider: 'gemini'
```
  with
```ts
  transcription: {
    provider: 'gemini' | 'openai-whisper'
```
  and after `geminiModel: string` add:
```ts
    openaiApiKey: string   // safeStorage-encrypted at rest (spec §5.4); decrypted in memory
    whisperModel: string   // fixed 'whisper-1' in v1 (spec §5.1; 4o-transcribe deferred §10)
```
  (b) DEFAULT_CONFIG (lines 82-88): after `geminiModel: 'gemini-3-pro-preview', // Best model for audio transcription` add:
```ts
    openaiApiKey: '',
    whisperModel: 'whisper-1',
```
  (c) `encryptSensitive` (lines 5-13): add the idempotency guard as the FIRST line of the try:
```ts
function encryptSensitive(value: string): string {
  try {
    if (value.startsWith('__enc__')) return value // already encrypted — never double-wrap (spec §5.4)
    if (safeStorage.isEncryptionAvailable() && value) {
```
  Export it for the test: `export { encryptSensitive }` (or `export function`).
  (d) Encrypt site in `saveConfig` (lines 163-171) — extend the `toWrite` object:
```ts
  const toWrite = {
    ...config,
    calendar: {
      ...config.calendar,
      icsUrl: encryptSensitive(config.calendar.icsUrl)
    },
    transcription: {
      ...config.transcription,
      openaiApiKey: encryptSensitive(config.transcription.openaiApiKey)
    }
  }
```
  (e) Decrypt site in `initializeConfig` (lines 130-138) — after the icsUrl decrypt add:
```ts
      if (savedConfig.transcription?.openaiApiKey) {
        savedConfig.transcription.openaiApiKey = decryptSensitive(savedConfig.transcription.openaiApiKey)
      }
```
- [ ] **Step 4: Mirror the renderer types.** In BOTH `src/types/index.ts` (:163-169) and `src/types/stores.ts` (:305-311), the identical block gains the same three changes (`provider: 'gemini' | 'openai-whisper'`, `openaiApiKey: string`, `whisperModel: string`). They must stay byte-identical to each other.
- [ ] **Step 5: Tests PASS** + `npx tsc --noEmit -p tsconfig.node.json; echo RC=$?` and `npm run typecheck; echo RC=$?` (renderer types compile).
- [ ] **Step 6: Commit.** `feat(electron): config — openai-whisper provider union, openaiApiKey/whisperModel, safeStorage both-sites + __enc__ guard (auto-pipeline P2)`

---

### Task 2: Typed provider errors + ffmpeg audio-normalize module

**Files:**
- Create: `electron/main/services/provider-errors.ts`, `electron/main/services/asr/audio-normalize.ts`
- Modify: `package.json` (dep), `electron-builder.yml` (asarUnpack)
- Create (Test): `electron/main/services/__tests__/audio-normalize.test.ts`

- [ ] **Step 1: Install the dep.** `npm install ffmpeg-static@^5.2.0` (in apps/electron — no workspace hoisting). Verify `node -e "console.log(require('ffmpeg-static'))"` prints a path.
- [ ] **Step 2: asarUnpack.** In `electron-builder.yml`, the current block is exactly:
```yaml
asarUnpack:
  - '**/*.node'
  - '**/usb/**'
```
  Add `  - '**/ffmpeg-static/**'` as a third entry. (NOTE: the meeting-recorder precedent LACKS this and would break packaged — do not copy its builder config.)
- [ ] **Step 3: `provider-errors.ts`** (complete file):
```ts
/**
 * Typed provider errors (auto-pipeline spec §7.1/§7.2).
 * Thrown by ASR/LLM providers; consumed by the queue worker.
 * P4 turns ProviderRateLimitError into "parking" — until then it falls
 * through to the generic retry path (its message is retryable).
 */
export class ProviderRateLimitError extends Error {
  constructor(
    public readonly provider: string,
    public readonly retryAfterMs?: number
  ) {
    super(`${provider} rate limit (HTTP 429)${retryAfterMs ? ` — retry after ${Math.round(retryAfterMs / 1000)}s` : ''}`)
    this.name = 'ProviderRateLimitError'
  }
}

/** Key rejected (401) — terminal until the user re-enters the key (spec §7.1). */
export class ProviderAuthError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider} API key was rejected — re-enter it in Settings`)
    this.name = 'ProviderAuthError'
  }
}
```
- [ ] **Step 4: Failing tests for `audio-normalize`.** Create `audio-normalize.test.ts` (`@vitest-environment node`), mocking `child_process` (`spawn`/`execFile` via `vi.mock`), `electron` (`app.isPackaged` controllable), `ffmpeg-static` (`vi.mock('ffmpeg-static', () => ({ default: '/fake/app.asar/node_modules/ffmpeg-static/ffmpeg' }))`), and fs free-space (`vi.mock` the `checkDiskSpace` seam — see Step 5 design: use `fs.statfsSync` via injectable). Tests:
  1. `resolveFfmpegPath()` unpackaged returns the raw path; with `app.isPackaged=true` returns the path with `app.asar` → `app.asar.unpacked`.
  2. `resolveFfmpegPath()` throws a clear error when ffmpeg-static resolves null (precedent: meeting-recorder audio-converter.ts:38-47).
  3. `normalizeForWhisper(input)` invokes ffmpeg with `-ar 16000 -ac 1 -b:a 32k` and an output under `hidock-asr` in tmpdir, named by the input basename; returns `{ files: [outPath] }` when the transcode result is ≤ 24 MB (mock `fs.statSync` size).
  4. When the transcoded file is > 24 MB → a second ffmpeg invocation with `-f segment -segment_time 600` and the return lists the segment files (mock `readdirSync`).
  5. Disk guard: when free space < 2× input size → throws `Not enough disk space to process <basename>` and ffmpeg is NEVER spawned.
  6. `cleanAsrTempDir()` removes the `hidock-asr` dir contents.
- [ ] **Step 5: Implement `audio-normalize.ts`.** Shape (complete the bodies — every behavior is pinned by the tests):
```ts
import { execFile } from 'child_process'
import { promisify } from 'util'
import { app } from 'electron'
import { existsSync, mkdirSync, rmSync, statSync, readdirSync, statfsSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
// @ts-ignore - ffmpeg-static has no types (monorepo precedent: meeting-recorder)
import ffmpegStaticPath from 'ffmpeg-static'

const execFileAsync = promisify(execFile)
const ASR_TMP = join(tmpdir(), 'hidock-asr')
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024 // 24 MB guard under OpenAI's 25 MB limit (spec §5.1)
const SEGMENT_SECONDS = 600

/** ffmpeg-static resolves inside app.asar in packaged builds; binaries cannot
 *  execute from the archive — rewrite to app.asar.unpacked (spec §5.1/§9). */
export function resolveFfmpegPath(): string {
  if (!ffmpegStaticPath) {
    throw new Error('ffmpeg binary not found (ffmpeg-static resolved to null). Reinstall: npm install ffmpeg-static')
  }
  return app.isPackaged
    ? String(ffmpegStaticPath).replace('app.asar', 'app.asar.unpacked')
    : String(ffmpegStaticPath)
}

/** Always-transcode (spec §5.1): EVERY Whisper input is normalized to 16 kHz
 *  mono 32 kbps MP3 (1 h ≈ 14 MB) — one code path, deterministic container
 *  (P1 .hda format is unverified; raw bytes never reach OpenAI). If the result
 *  still exceeds 24 MB, segment into 600 s chunks. Throws a non-retryable
 *  disk-space error before spawning when free space < 2× input size. */
export async function normalizeForWhisper(inputPath: string): Promise<{ files: string[] }> { /* ... */ }

/** Wiped at app startup (index.ts) and after each job (worker). */
export function cleanAsrTempDir(): void { /* rmSync(ASR_TMP, { recursive: true, force: true }) */ }
```
  Transcode args: `['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-b:a', '32k', outPath]` with `outPath = join(ASR_TMP, `${basename(inputPath)}.norm.mp3`)`. Segment args: `['-y', '-i', outPath, '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-c', 'copy', join(ASR_TMP, `${basename(inputPath)}.part%03d.mp3`)]`. Disk check via `statfsSync(tmpdir())` (`bavail * bsize`); wrap in try/catch and skip the guard (not the transcode) on platforms where statfs is unavailable.
- [ ] **Step 6: Wire startup wipe.** In `electron/main/index.ts`, alongside the other service initializations (near `startTranscriptionProcessor()`), add `cleanAsrTempDir()` with import. (One line + import; find the exact anchor by reading the init block.)
- [ ] **Step 7: Tests PASS, RCs 0, commit.** `feat(electron): ffmpeg audio-normalize (always-transcode + chunking + asar rewrite + disk guard) + typed provider errors (auto-pipeline P2)`

---

### Task 3: `whisper-asr.ts` provider + factory case + Stage-1 model fix

**Files:**
- Create: `electron/main/services/asr/whisper-asr.ts`
- Modify: `electron/main/services/asr/asr-provider.ts`, `electron/main/services/transcription.ts` (2 small edits)
- Create (Test): `electron/main/services/__tests__/whisper-asr.test.ts`; extend `providers-p1.test.ts`

- [ ] **Step 1: Failing tests** (`whisper-asr.test.ts`, `@vitest-environment node`; mock global `fetch` via `vi.stubGlobal`, mock `./audio-normalize` module):
  1. Factory key check: `getAsrProvider({...provider:'openai-whisper', openaiApiKey: ''})` throws EXACTLY `OpenAI API key not configured — add it in Settings → Transcription` (spec §7.1 verbatim).
  2. Single-chunk happy path: `normalizeForWhisper` mocked → `{files:['/t/a.norm.mp3']}`; fetch → `{ ok: true, json: async () => ({ text: 'HELLO', language: 'english' }) }`; assert: POST to `https://api.openai.com/v1/audio/transcriptions`, `Authorization: Bearer sk-x` header, FormData body whose `model` field is `'whisper-1'` and `response_format` is `'verbose_json'`; result `{ text: 'HELLO', language: 'english' }`.
  3. Multi-chunk: normalize → 3 files; 3 fetch calls; texts joined with `'\n'`; `language` from the FIRST chunk's response.
  4. 429 → throws `ProviderRateLimitError` with `provider='OpenAI'` and `retryAfterMs` parsed from a `Retry-After: 120` header (=120000).
  5. 401 → throws `ProviderAuthError('OpenAI')` (message contains `OpenAI API key was rejected`).
  6. Timeout: fetch that never resolves + `vi.useFakeTimers` → advancing 10 min aborts (assert the AbortSignal fired / rejection message mentions timeout).
  7. `opts.meetingContext` is ignored (no prompt field in the FormData — spec §5.1).
- [ ] **Step 2: Implement `whisper-asr.ts`.** Complete shape:
```ts
import { readFileSync } from 'fs'
import { basename } from 'path'
import type { AppConfig } from '../config'
import type { AsrProvider, AsrResult } from './asr-provider'
import { normalizeForWhisper, cleanAsrTempDir } from './audio-normalize'
import { ProviderRateLimitError, ProviderAuthError } from '../provider-errors'

const WHISPER_TIMEOUT_MS = 10 * 60 * 1000 // spec §7.4

export function createWhisperAsr(config: AppConfig): AsrProvider {
  if (!config.transcription.openaiApiKey) {
    throw new Error('OpenAI API key not configured — add it in Settings → Transcription') // spec §7.1 verbatim
  }
  const apiKey = config.transcription.openaiApiKey
  const model = config.transcription.whisperModel || 'whisper-1'

  return {
    async transcribe(filePath: string, _opts: { meetingContext?: string }): Promise<AsrResult> {
      // meetingContext deliberately ignored (spec §5.1 — Whisper's prompt is a vocab hint, unused in v1)
      const { files } = await normalizeForWhisper(filePath)
      try {
        const texts: string[] = []
        let language: string | undefined
        for (const chunk of files) {
          const result = await transcribeChunk(chunk, apiKey, model)
          texts.push(result.text)
          language = language ?? result.language // language from the FIRST chunk (spec §5.1)
        }
        return { text: texts.join('\n'), language }
      } finally {
        cleanAsrTempDir()
      }
    }
  }
}

async function transcribeChunk(path: string, apiKey: string, model: string): Promise<{ text: string; language?: string }> {
  const form = new FormData()
  form.append('file', new Blob([readFileSync(path)], { type: 'audio/mpeg' }), basename(path))
  form.append('model', model)
  form.append('response_format', 'verbose_json') // whisper-1-only format; supplies language (spec §5.1)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    })
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After')
      throw new ProviderRateLimitError('OpenAI', retryAfter ? Number(retryAfter) * 1000 : undefined)
    }
    if (res.status === 401) throw new ProviderAuthError('OpenAI')
    if (!res.ok) throw new Error(`OpenAI transcription failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as { text: string; language?: string }
    return { text: json.text, language: json.language }
  } finally {
    clearTimeout(timer)
  }
}
```
- [ ] **Step 3: Factory case.** In `asr-provider.ts` the switch is verbatim:
```ts
  switch (config.transcription.provider) {
    case 'gemini':
      return createGeminiAsr(config)
    default:
```
  add between them:
```ts
    case 'openai-whisper':
      return createWhisperAsr(config)
```
  (+ import). Update the factory JSDoc's "P1 supports 'gemini' only; P2 adds 'openai-whisper'" sentence to past tense.
- [ ] **Step 4: Stage-1 model per provider (carry-note from P1 review).** In `transcription.ts` (~:413-427) the upsert currently ends with:
```ts
      transcription_model: config.transcription.geminiModel // P2 will derive this per ASR provider
```
  Replace with:
```ts
      transcription_model:
        config.transcription.provider === 'openai-whisper'
          ? config.transcription.whisperModel
          : config.transcription.geminiModel
```
- [ ] **Step 5: NON_RETRYABLE string.** In `transcription.ts` the array is verbatim (:114-119):
```ts
    const NON_RETRYABLE_ERRORS = [
      'Recording not found',
      'Recording file not found',
      'Gemini API key not configured',
      'no local file'
    ]
```
  Add `'OpenAI API key not configured',` and `'Not enough disk space',` and `'API key was rejected',` (the ProviderAuthError message — P4's taxonomy table also lists it; adding here prevents 3 pointless retries now). Do NOT add rate-limit strings (parking is P4; until then 429 retries via normal backoff, acceptable interim).
- [ ] **Step 6: Extend `providers-p1.test.ts`** with one factory-dispatch test: provider `'openai-whisper'` + key set → returns a provider (mock `./whisper-asr`'s createWhisperAsr OR just assert no-throw and instance shape).
- [ ] **Step 7: All ASR tests + neighbors PASS** (`whisper-asr`, `audio-normalize`, `providers-p1`, `two-stage-worker`, `transcription`); typecheck RC 0. Commit: `feat(electron): openai-whisper ASR provider — multipart verbose_json, chunk loop, typed 429/401, 10-min timeout (auto-pipeline P2)`

---

### Task 4: `transcription:validateConfig` IPC + useOperations preflight

**Files:**
- Modify: `electron/main/ipc/recording-handlers.ts`, `electron/preload/index.ts`, `src/hooks/useOperations.ts`
- Test: extend `electron/main/ipc/__tests__/recording-handlers.test.ts`; update `src/hooks/__tests__/useOperations*` if present (find it)

- [ ] **Step 1: Failing handler test.** In `recording-handlers.test.ts`, the channel-registry assertion (~:190) lists registered channels — add `'transcription:validateConfig'`. Add behavior tests: with config provider `'openai-whisper'` + empty openaiApiKey → `{ ok: false, problems: [{ stage: 'asr', provider: 'openai-whisper', problem: 'missing-key' }] }`; with gemini defaults + gemini key set → `{ ok: true, problems: [] }`. (Mock `getConfig` per that file's existing config-mock idiom.)
- [ ] **Step 2: Implement the handler** in `recording-handlers.ts`, anchored after the `'transcription:cancelAll'` handler (:298-316):
```ts
  // Provider-aware preflight (spec §5.6): which selected providers lack keys.
  // Replaces the renderer's hardcoded Gemini-key gates (useOperations).
  ipcMain.handle('transcription:validateConfig', async (): Promise<{
    ok: boolean
    problems: Array<{ stage: 'asr' | 'summarization'; provider: string; problem: 'missing-key' }>
  }> => {
    const config = getConfig()
    const problems: Array<{ stage: 'asr' | 'summarization'; provider: string; problem: 'missing-key' }> = []
    const asrProvider = config.transcription.provider
    if (asrProvider === 'openai-whisper' && !config.transcription.openaiApiKey.trim()) {
      problems.push({ stage: 'asr', provider: 'openai-whisper', problem: 'missing-key' })
    }
    if (asrProvider === 'gemini' && !config.transcription.geminiApiKey.trim()) {
      problems.push({ stage: 'asr', provider: 'gemini', problem: 'missing-key' })
    }
    // Summarization stage: P2 ships gemini-only (config.summarization lands in P3 —
    // mirror llm-provider.ts's structural read until then).
    const sumProvider =
      (config as { summarization?: { provider?: string } }).summarization?.provider ?? 'gemini'
    if (sumProvider === 'gemini' && !config.transcription.geminiApiKey.trim()) {
      if (!problems.some((p) => p.provider === 'gemini')) {
        problems.push({ stage: 'summarization', provider: 'gemini', problem: 'missing-key' })
      }
    }
    return { ok: problems.length === 0, problems }
  })
```
  (`getConfig` is already imported at :34. P3 extends the sumProvider branch for ollama-cloud — leave the structural-cast comment so P3's "remove the cast" sweep finds it.)
- [ ] **Step 3: Preload bindings.** Type decl inside the recordings type block (before its closing `}` at ~:162):
```ts
    validateTranscriptionConfig: () => Promise<{ ok: boolean; problems: Array<{ stage: string; provider: string; problem: string }> }>
```
  Impl in the recordings impl block (before the closing `},` at ~:580):
```ts
    validateTranscriptionConfig: () => callIPC('transcription:validateConfig'),
```
- [ ] **Step 4: Rework `useOperations.ts`.** Both gates are verbatim in the facts (single :32-48, bulk :76-92, each reading `config.getValue('transcription.geminiApiKey')` and toasting `'Please configure your Gemini API key in Settings before transcribing.'`). Replace EACH gate's body with:
```ts
    // Provider-aware preflight (spec §5.6) — replaces the hardcoded Gemini gate
    // so a Whisper+Ollama user can queue/retry without a Gemini key.
    try {
      const check = await window.electronAPI.recordings.validateTranscriptionConfig()
      if (!check.ok) {
        const p = check.problems[0]
        toast({
          title: 'API key required',
          description: `Configure your ${p.provider} API key in Settings before transcribing.`,
          variant: 'error'
        })
        return false  // (bulk variant: return 0)
      }
    } catch (e) {
      console.error('Failed to validate transcription config:', e)
      toast({ title: 'Configuration error', description: 'Could not verify provider configuration', variant: 'error' })
      return false  // (bulk variant: return 0)
    }
```
- [ ] **Step 5: Update renderer tests.** Find `useOperations` tests (`ls src/hooks/__tests__/`); realign the API-key-gate tests to mock `validateTranscriptionConfig` (cite spec §5.6 in a comment). Run them + `Settings.test.tsx` (should be untouched so far).
- [ ] **Step 6: All green, RCs 0, commit.** `feat(electron): transcription:validateConfig preflight — provider-aware key gates in useOperations (auto-pipeline P2)`

---

### Task 5: Settings Transcription card — provider picker + Whisper fields

**Files:**
- Modify: `src/pages/Settings.tsx`
- Test: `src/pages/__tests__/Settings.test.tsx` (extend)

- [ ] **Step 1: Read the card** (Settings.tsx:457-536) and the verbatim idioms from the facts: Button-group provider toggle (:545-568 chatProvider), Eye/EyeOff key field (:465-489), select field (:504-525), dirty-state memo (:119-125), hydration effect (:153-165), save handler (:233-271), validateConfig rule (:68-78).
- [ ] **Step 2: Failing tests** in `Settings.test.tsx` (follow its existing render/mock idioms): (a) selecting provider "OpenAI Whisper" reveals an OpenAI-key input and hides the Gemini model select; (b) saving with whisper selected calls `updateConfig('transcription', expect.objectContaining({ provider: 'openai-whisper', openaiApiKey: 'sk-test' }))`; (c) gemini remains the default rendering.
- [ ] **Step 3: Implement.** Additions (all inside the Settings component, mirroring existing idioms exactly):
  - State: `const [asrProvider, setAsrProvider] = useState<'gemini' | 'openai-whisper'>('gemini')`, `const [openaiApiKey, setOpenaiApiKey] = useState('')`, `const [showOpenaiKey, setShowOpenaiKey] = useState(false)`. (`whisperModel` needs no state — fixed `'whisper-1'` in v1, rendered as a disabled select with one option.)
  - Hydration effect (:153-165): add `setAsrProvider(config.transcription.provider || 'gemini')` and `setOpenaiApiKey(config.transcription.openaiApiKey || '')`.
  - Dirty memo (:119-125): include `asrProvider !== config.transcription.provider` and `openaiApiKey !== config.transcription.openaiApiKey`.
  - Card JSX: at the top of the Transcription CardContent, a provider Button-group (copy the chatProvider idiom verbatim, labels `Gemini` / `OpenAI Whisper`, aria-pressed wiring). Then wrap the EXISTING Gemini key+model fields in `{asrProvider === 'gemini' && (<>...</>)}` and add the Whisper branch:
```tsx
              {asrProvider === 'openai-whisper' && (
                <>
                  {/* OpenAI API key — Eye/EyeOff idiom copied from the Gemini field */}
                  {/* (Input id="openaiApiKey", placeholder "Enter your OpenAI API key (sk-...)",
                      value={openaiApiKey}, toggle uses showOpenaiKey) */}
                  <div>
                    <label htmlFor="whisperModel" className="text-sm font-medium">Transcription Model</label>
                    <select id="whisperModel" value="whisper-1" disabled aria-label="Whisper Model"
                      className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm opacity-70">
                      <option value="whisper-1">whisper-1 (only supported model in v1)</option>
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">
                      gpt-4o-transcribe is not supported yet (25-minute duration cap).
                    </p>
                  </div>
                </>
              )}
```
  - Save handler: `const updates = { provider: asrProvider, geminiApiKey, geminiModel, openaiApiKey, whisperModel: 'whisper-1' }`; success toast names the active provider.
  - `validateConfig` (:68-78): add an OpenAI-key rule mirroring the Gemini one — min length 10; soft prefix warning `if (apiKey && !apiKey.startsWith('sk-')) return 'OpenAI API keys should start with "sk-". Please verify your key.'` Gate it on `updates.transcription.provider === 'openai-whisper'`.
  - CardDescription (:461): "Configure Gemini API for transcription" → "Configure the transcription (ASR) provider".
- [ ] **Step 4: Tests PASS** (`npx vitest run src/pages/__tests__/Settings.test.tsx; echo RC=$?`), full typecheck RC 0.
- [ ] **Step 5: Commit.** `feat(electron): Settings — ASR provider picker (Gemini | OpenAI Whisper) with encrypted key field (auto-pipeline P2)`

---

### Task 6: Full gates + AC4 evidence

- [ ] **Step 1:** `npm run typecheck > /tmp/p2gate.txt 2>&1; echo RC=$?` then `npm run lint 2>&1 | tail -3; echo RC=${PIPESTATUS[0]}` then `npm run test:run > /tmp/p2tests.txt 2>&1; echo RC=$?` — all RC 0 (one transient WASM flake is known; re-run to confirm).
- [ ] **Step 2: AC4 evidence:** name the tests proving (a) the chunk path (multi-chunk whisper test), (b) the asar path rewrite (audio-normalize test 1), (c) always-transcode (whisper provider calls normalizeForWhisper unconditionally — assert via mock call count in test 2).
- [ ] **Step 3: Report** with realignment citations (useOperations gate replacement → spec §5.6) and any DONE_WITH_CONCERNS.

## Done criteria (spec §12 P2 → AC4)
- [ ] `openai-whisper` selectable end-to-end: config union + factory + worker model fix + Settings card.
- [ ] Always-transcode + >24 MB chunking + asar rewrite + temp hygiene + disk guard, all test-pinned.
- [ ] `openaiApiKey` encrypted at rest (cold-start round-trip test) + `__enc__` double-wrap guard.
- [ ] `transcription:validateConfig` + useOperations preflight — no Gemini key required for a Whisper user to queue/retry.
- [ ] Typed `ProviderRateLimitError`/`ProviderAuthError` thrown by whisper-asr (P4's parking input).
- [ ] All gates green; gemini-default behavior unchanged.

## Explicitly NOT in P2
- Ollama Cloud / `config.summarization` / resummarize / Summarization card (P3).
- 429 parking behavior, key-fix re-pend, failure chip (P4 — typed errors land here, behavior there).
- Baseline/auto-sync changes (P5). Integration e2e + physical test (P6).
- `gpt-4o-transcribe` support (spec §10).
