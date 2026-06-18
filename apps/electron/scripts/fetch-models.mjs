/**
 * fetch-models.mjs — Download bundled ONNX models for the Electron app.
 *
 * Run once before packaging (or before dev if you want voiceprint capture):
 *   node scripts/fetch-models.mjs
 *
 * The build:win / build:mac / build:linux / build:unpack scripts run this
 * automatically BEFORE electron-builder, because electron-builder.yml's
 * extraResources references resources/models/<model>.onnx — a missing file
 * fails the package step.
 *
 * Models are NOT committed to git (large binaries; see .gitignore). They are
 * picked up from resources/models/ via extraResources + asarUnpack
 * (electron-builder.yml), landing at <resources>/models/<model>.onnx in the
 * packaged app — matching voiceprint-service.ts getExtractor().
 *
 * Integrity: if a model's `sha256` is pinned, the downloaded/existing file is
 * verified and a mismatch fails the build. If it is null (not yet pinned), the
 * computed SHA-256 is printed so you can paste it into the `sha256` field.
 *
 * Source: official sherpa-onnx speaker-recognition model release
 *   https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recog-models
 */
import { createWriteStream, existsSync, mkdirSync, createReadStream, statSync, rmSync } from 'fs'
import { get } from 'https'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODELS_DIR = join(__dirname, '..', 'resources', 'models')

const MODELS = [
  {
    name: 'wespeaker_en_voxceleb_resnet34_LM.onnx',
    // Official sherpa-onnx model release. NOTE: the release tag is literally
    // "speaker-recongition-models" — that misspelling ("recongition") is upstream's
    // actual tag, not a typo here. Verified 2026-06-18 (HTTP 200).
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx',
    // SHA-256 of the released file. Pinned 2026-06-18 from the verified download
    // (26,530,550 bytes). On mismatch the script deletes the file and fails.
    sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
  },
]

mkdirSync(MODELS_DIR, { recursive: true })

/** Stream a file through SHA-256 and resolve the lowercase hex digest. */
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

/**
 * Download `url` to `dest`, following up to `redirectsLeft` redirects. The dest
 * file is created ONLY on a 200 response — never before following a redirect
 * (the old code pre-created an empty file, so the redirect's existsSync check
 * short-circuited and left a 0-byte model). On any failure the partial file is
 * removed so a retry re-downloads cleanly.
 */
function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      if (REDIRECT_CODES.has(res.statusCode)) {
        res.resume() // drain so the socket frees
        if (redirectsLeft <= 0 || !res.headers.location) {
          reject(new Error(`too many redirects (or no Location) for ${url}`))
          return
        }
        download(res.headers.location, dest, redirectsLeft - 1).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      const file = createWriteStream(dest) // create ONLY on a real 200 body
      const total = parseInt(res.headers['content-length'] ?? '0', 10)
      let received = 0
      res.on('data', (chunk) => {
        received += chunk.length
        if (total) {
          const pct = ((received / total) * 100).toFixed(1)
          process.stdout.write(`\r  ${pct}% (${(received / 1e6).toFixed(1)} MB / ${(total / 1e6).toFixed(1)} MB)`)
        }
      })
      res.on('error', (err) => {
        file.destroy()
        rmSync(dest, { force: true })
        reject(err)
      })
      res.pipe(file)
      file.on('error', (err) => {
        rmSync(dest, { force: true })
        reject(err)
      })
      file.on('finish', () => {
        if (total) process.stdout.write('\n')
        file.close(() => resolve())
      })
    })
    req.on('error', (err) => {
      rmSync(dest, { force: true })
      reject(err)
    })
  })
}

/** Verify `path` against `expected` (pinned), or print the computed hash to pin. */
async function verifyOrReport(path, expected, name) {
  const actual = await sha256File(path)
  if (expected) {
    if (actual !== expected) {
      rmSync(path, { force: true })
      throw new Error(
        `[fetch-models] SHA-256 mismatch for ${name}:\n  expected ${expected}\n  actual   ${actual}\n` +
          '  The downloaded file was deleted. Re-run, or update the pinned sha256 if the release changed.'
      )
    }
    console.log(`[fetch-models] verified ${name} (sha256 ok)`)
  } else {
    console.log(
      `[fetch-models] ${name} sha256 = ${actual}\n` +
        '  ^ PIN THIS: paste it into the model\'s `sha256` field in scripts/fetch-models.mjs to enable integrity checks.'
    )
  }
}

for (const model of MODELS) {
  const dest = join(MODELS_DIR, model.name)
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`[fetch-models] already present: ${dest}`)
  } else {
    console.log(`[fetch-models] downloading ${model.url}`)
    await download(model.url, dest)
    console.log(`[fetch-models] saved: ${dest}`)
  }
  await verifyOrReport(dest, model.sha256, model.name)
}

console.log('[fetch-models] done.')
