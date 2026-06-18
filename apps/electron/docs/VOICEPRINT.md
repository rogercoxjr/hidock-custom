# Voiceprint Capture — Activation Guide

Speaker diarization works fully **without** voiceprints (speaker→Contact mapping is
manual). Voiceprint **capture** is an opt-in, on-device step that stores a speaker
embedding on every manual mapping so a future **Phase-2 auto-ID matcher** launches
pre-trained. It is **inactive by default**: `sherpa-onnx-node` is an
`optionalDependency` and the WeSpeaker model is not committed to git, so in a fresh
checkout `isVoiceprintAvailable()` returns `false` and capture is a silent no-op
(by design — see `voiceprint-service.ts`).

This guide activates it. **Windows x64 only** (the prebuilt `sherpa-onnx-node` addon
ships win-x64; the build targets x64).

## What's already wired (no action needed)

- `optionalDependencies: { "sherpa-onnx-node": "1.13.3" }` in `package.json`.
- `electron-builder.yml` `asarUnpack` includes `**/*.node`, `**/sherpa-onnx-node/**`,
  and the model `.onnx`; `extraResources` copies the model to `<resources>/models/`.
- `voiceprint-service.ts` `getExtractor()` resolves the model at
  `process.resourcesPath/models/<id>.onnx` (packaged) or
  `resources/models/<id>.onnx` (dev) — matching where `fetch-models.mjs` writes.
- `build:win`/`build:mac`/`build:linux`/`build:unpack` now run `models:fetch`
  **before** `electron-builder`, so packaging can't ship without the model.

## Activation steps (on a Windows x64 machine)

1. **Install the native addon** (it's optional, so it installs by default unless you
   omitted optionals):
   ```powershell
   cd apps\electron
   npm install          # pulls sherpa-onnx-node@1.13.3; postinstall rebuilds native deps
   ```
   Confirm it landed: `node -e "require('sherpa-onnx-node'); console.log('ok')"` prints `ok`.

2. **Download the WeSpeaker model** (~26 MB; not committed):
   ```powershell
   npm run models:fetch
   ```
   On first download it prints the file's SHA-256.

3. **Pin the SHA-256** for integrity: copy the printed hash into the model's `sha256`
   field in `scripts/fetch-models.mjs` (replace `sha256: null`). Re-run
   `npm run models:fetch` — it should now print `verified … (sha256 ok)`.

4. **Verify in dev**: `npm run dev`. On startup the main-process log should **no longer**
   show `[Voiceprint] sherpa-onnx-node unavailable …`. Map a speaker to a Contact on a
   recording with ≥10 s of clean (non-overlapped) speech for that label; a row should
   appear in the `voiceprints` table (`model_id = wespeaker_en_voxceleb_resnet34_LM`).

5. **Verify in a packaged build**:
   ```powershell
   npm run build:win
   ```
   In the installed app, confirm `<install>\resources\models\wespeaker_en_voxceleb_resnet34_LM.onnx`
   exists and that `app.asar.unpacked` contains the `sherpa-onnx-node` `.node` addon.

## Notes

- **Node ABI**: the prebuilt addon must match the Electron runtime's Node ABI. If
  `require('sherpa-onnx-node')` throws an ABI/`.node` error, run
  `npx electron-builder install-app-deps` (the `postinstall` hook) to rebuild against
  Electron's ABI.
- **Graceful degradation is preserved**: if the addon or model is ever absent at
  runtime, capture no-ops and the speaker→Contact mapping still succeeds.
- **The matcher is Phase 2.** v1 only *captures* embeddings; nothing reads them yet.
