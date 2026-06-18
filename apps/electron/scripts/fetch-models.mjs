/**
 * fetch-models.mjs — Download bundled ONNX models for the Electron app.
 *
 * Run once before building (or before dev if you want voiceprint capture):
 *   node scripts/fetch-models.mjs
 *
 * Models are NOT committed to git (they are large binaries; see .gitignore).
 * electron-builder picks them up from resources/models/ via extraResources +
 * asarUnpack (see electron-builder.yml).
 *
 * Source: k2-fsa WeSpeaker releases on GitHub
 *   https://github.com/wenet-e2e/wespeaker/releases
 *   (re-hosted under k2-fsa/sherpa-onnx releases for convenience)
 */
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { get } from 'https'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODELS_DIR = join(__dirname, '..', 'resources', 'models')

const MODELS = [
  {
    name: 'wespeaker_en_voxceleb_resnet34_LM.onnx',
    // Official sherpa-onnx model release (k2-fsa/sherpa-onnx GitHub releases)
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recog-models/wespeaker_en_voxceleb_resnet34_LM.onnx',
    // SHA-256 of the released file — update if a newer model tarball is used.
    // Verify with: certutil -hashfile wespeaker_en_voxceleb_resnet34_LM.onnx SHA256
    sha256: null, // TODO: pin once we confirm the exact release SHA
  },
]

mkdirSync(MODELS_DIR, { recursive: true })

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (existsSync(dest)) {
      console.log(`[fetch-models] already exists: ${dest}`)
      resolve()
      return
    }
    console.log(`[fetch-models] downloading ${url}`)
    const file = createWriteStream(dest)
    const req = get(url, (res) => {
      // Follow one redirect (GitHub releases redirect to S3/CDN)
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.destroy()
        download(res.headers.location, dest).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        file.destroy()
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      const total = parseInt(res.headers['content-length'] ?? '0', 10)
      let received = 0
      res.on('data', (chunk) => {
        received += chunk.length
        if (total) {
          const pct = ((received / total) * 100).toFixed(1)
          process.stdout.write(`\r  ${pct}% (${(received / 1e6).toFixed(1)} MB / ${(total / 1e6).toFixed(1)} MB)`)
        }
      })
      res.pipe(file)
      file.on('finish', () => {
        if (total) process.stdout.write('\n')
        file.close()
        console.log(`[fetch-models] saved: ${dest}`)
        resolve()
      })
    })
    req.on('error', (err) => {
      file.destroy()
      reject(err)
    })
  })
}

for (const model of MODELS) {
  const dest = join(MODELS_DIR, model.name)
  await download(model.url, dest)
}

console.log('[fetch-models] done.')
