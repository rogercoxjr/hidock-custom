import { describe, it, expect } from 'vitest'
import {
  blobToFloat32,
  l2Normalize,
  cosine,
  centroid,
  meanPairwiseCosine,
  dispersion,
} from '../vector-math'

function vec(...values: number[]): Float32Array {
  return Float32Array.from(values)
}

function blobFrom(values: number[]): Uint8Array {
  const buf = new ArrayBuffer(values.length * 4)
  const view = new DataView(buf)
  for (let i = 0; i < values.length; i++) {
    view.setFloat32(i * 4, values[i], true)
  }
  return new Uint8Array(buf)
}

describe('blobToFloat32', () => {
  it('round-trips a little-endian float32 blob', () => {
    const v = [0.1, -0.2, 0.3, 0.9]
    const out = Array.from(blobToFloat32(blobFrom(v)))
    expect(out).toHaveLength(v.length)
    for (let i = 0; i < v.length; i++) {
      expect(out[i]).toBeCloseTo(v[i], 6)
    }
  })

  it('throws on non-multiple-of-4 blobs', () => {
    expect(() => blobToFloat32(new Uint8Array(7))).toThrow(/multiple of 4/)
  })
})

describe('l2Normalize', () => {
  it('normalizes a non-zero vector to unit length', () => {
    const v = vec(3, 4)
    const n = l2Normalize(v)
    expect(n[0]).toBeCloseTo(0.6, 6)
    expect(n[1]).toBeCloseTo(0.8, 6)
  })

  it('returns the zero vector unchanged', () => {
    const v = vec(0, 0, 0)
    const n = l2Normalize(v)
    expect(Array.from(n)).toEqual([0, 0, 0])
  })
})

describe('cosine', () => {
  it('is 1 for identical vectors', () => {
    const v = vec(1, 2, 3)
    expect(cosine(v, Float32Array.from(v))).toBeCloseTo(1, 6)
  })

  it('is 0 for orthogonal vectors', () => {
    const a = vec(1, 0, 0)
    const b = vec(0, 1, 0)
    expect(cosine(a, b)).toBeCloseTo(0, 6)
  })

  it('is -1 for opposite vectors', () => {
    const a = vec(1, 0, 0)
    const b = vec(-1, 0, 0)
    expect(cosine(a, b)).toBeCloseTo(-1, 6)
  })

  it('throws on dimension mismatch', () => {
    expect(() => cosine(vec(1, 2), vec(1, 2, 3))).toThrow(/dimension mismatch/)
  })
})

describe('centroid', () => {
  it('returns the normalized mean', () => {
    const a = vec(1, 0, 0)
    const b = vec(0, 1, 0)
    const c = centroid([a, b])
    expect(c[0]).toBeCloseTo(1 / Math.sqrt(2), 6)
    expect(c[1]).toBeCloseTo(1 / Math.sqrt(2), 6)
    expect(c[2]).toBeCloseTo(0, 6)
  })

  it('throws on empty list', () => {
    expect(() => centroid([])).toThrow(/empty vector list/)
  })
})

describe('meanPairwiseCosine', () => {
  it('returns 1.0 for a single vector', () => {
    expect(meanPairwiseCosine([vec(1, 2, 3)])).toBe(1.0)
  })

  it('averages pairwise cosine for multiple vectors', () => {
    const a = vec(1, 0, 0)
    const b = vec(0, 1, 0)
    const c = vec(0, 0, 1)
    // All three are mutually orthogonal → average 0
    expect(meanPairwiseCosine([a, b, c])).toBeCloseTo(0, 6)
  })
})

describe('dispersion', () => {
  it('is 0 for identical vectors', () => {
    const v = vec(1, 0, 0)
    expect(dispersion([v, v, v])).toBeCloseTo(0, 6)
  })

  it('is 1 for orthogonal vectors', () => {
    const a = vec(1, 0, 0)
    const b = vec(0, 1, 0)
    expect(dispersion([a, b])).toBeCloseTo(1, 6)
  })
})
