// utilityProcess child: isolates the native sherpa addon off the main process so the
// synchronous embedding compute never blocks the UI. Receives { id, modelPath, sampleRate,
// samples (Float32Array, transferred) } and replies { id, ok, embedding? , error? }.
import process from 'node:process'

let sherpa: any = null
const extractors = new Map<string, any>() // modelPath -> extractor

function getExtractor(modelPath: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (!sherpa) sherpa = require('sherpa-onnx-node')
  let ext = extractors.get(modelPath)
  if (!ext) {
    ext = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false })
    extractors.set(modelPath, ext)
  }
  return ext
}

process.parentPort.on('message', (e: { data: { id: string; modelPath: string; sampleRate: number; samples: Float32Array } }) => {
  const { id, modelPath, sampleRate, samples } = e.data
  try {
    const ext = getExtractor(modelPath)
    const stream = ext.createStream()
    stream.acceptWaveform({ sampleRate, samples })
    stream.inputFinished()
    if (!ext.isReady(stream)) { process.parentPort.postMessage({ id, ok: false, error: 'extractor not ready' }); return }
    const emb = new Float32Array(ext.compute(stream, false)) // V8-owned copy
    // Electron's ParentPort.postMessage takes a single argument (no transfer list) — the
    // embedding is structured-cloned back to the parent. It's tiny (256 floats ≈ 1 KB).
    process.parentPort.postMessage({ id, ok: true, dim: ext.dim, embedding: emb })
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: (err as Error).message })
  }
})
