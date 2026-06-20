/**
 * Vector math helpers for voiceprint matching.
 *
 * Pure numeric code — no Electron, no DB, no I/O.
 */

/** Convert a little-endian float32 BLOB back to Float32Array. */
export function blobToFloat32(blob: Uint8Array): Float32Array {
  if (blob.length % 4 !== 0) {
    throw new Error(`blobToFloat32: blob length ${blob.length} is not a multiple of 4`)
  }
  const out = new Float32Array(blob.length / 4)
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getFloat32(i * 4, true)
  }
  return out
}

/** Return a fresh L2-normalized copy. Zero vectors are returned unchanged. */
export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  if (sum === 0) return Float32Array.from(v)
  const inv = 1 / Math.sqrt(sum)
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv
  return out
}

/** Cosine similarity of two vectors. Vectors are re-normalized defensively. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch ${a.length} vs ${b.length}`)
  }
  const an = l2Normalize(a)
  const bn = l2Normalize(b)
  let dot = 0
  for (let i = 0; i < an.length; i++) dot += an[i] * bn[i]
  // Clamp to the valid range to avoid tiny floating-point overshoot.
  return Math.max(-1, Math.min(1, dot))
}

/** Mean vector, then L2-normalized. Empty input throws. */
export function centroid(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) throw new Error('centroid: empty vector list')
  const dim = vectors[0].length
  const mean = new Float32Array(dim)
  for (const v of vectors) {
    if (v.length !== dim) throw new Error('centroid: inconsistent vector dimensions')
    for (let i = 0; i < dim; i++) mean[i] += v[i]
  }
  const n = vectors.length
  for (let i = 0; i < dim; i++) mean[i] /= n
  return l2Normalize(mean)
}

/** Mean pairwise cosine of a set. One vector returns 1.0. */
export function meanPairwiseCosine(vectors: Float32Array[]): number {
  if (vectors.length === 0) throw new Error('meanPairwiseCosine: empty vector list')
  if (vectors.length === 1) return 1.0
  let sum = 0
  let count = 0
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sum += cosine(vectors[i], vectors[j])
      count++
    }
  }
  return count === 0 ? 1.0 : sum / count
}

/** 1 - meanPairwiseCosine. Higher means more dispersed. */
export function dispersion(vectors: Float32Array[]): number {
  return 1 - meanPairwiseCosine(vectors)
}
