/**
 * Merge detector — over-split label clustering with cross-contact guard.
 *
 * Pure code: union-find over same-recording label embeddings.
 */
import { cosine } from './vector-math'
import type { IdentityResult, MatchThresholds } from './identity-matcher'

export interface LabelVec {
  fileLabel: string
  emb: Float32Array
  cleanSpeechMs?: number
}

export interface MergeCluster {
  labels: string[]
  minPairCosine: number
  representative: string
}

class UnionFind {
  private parent: Map<string, string>

  constructor(labels: string[]) {
    this.parent = new Map(labels.map((l) => [l, l]))
  }

  find(x: string): string {
    let root = x
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!
    }
    // Path compression.
    let cur = x
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    this.parent.set(rb, ra)
  }
}

function getStrongContact(result: IdentityResult | undefined): string | null {
  if (!result) return null
  if (result.decision !== 'strong' || !result.best) return null
  return result.best.contactId
}

/** Detect over-split labels that likely belong to the same speaker. */
export function detectMergeClusters(
  labels: LabelVec[],
  thresholds: MatchThresholds,
  identityByLabel: Map<string, IdentityResult>
): MergeCluster[] {
  if (labels.length < 2) return []

  const mergeThreshold = thresholds.mergeThreshold ?? 0.62
  const maxMergeSuggestions = thresholds.maxMergeSuggestions ?? 5

  // Build all edges above threshold, dropping cross-contact strong edges.
  const edges: Array<{ a: string; b: string; cos: number }> = []
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]
      const b = labels[j]
      const cos = cosine(a.emb, b.emb)
      if (cos < mergeThreshold) continue

      const strongA = getStrongContact(identityByLabel.get(a.fileLabel))
      const strongB = getStrongContact(identityByLabel.get(b.fileLabel))
      if (strongA && strongB && strongA !== strongB) continue

      edges.push({ a: a.fileLabel, b: b.fileLabel, cos })
    }
  }

  // Union-find on surviving edges.
  const uf = new UnionFind(labels.map((l) => l.fileLabel))
  for (const e of edges) uf.union(e.a, e.b)

  // Group by root.
  const groups = new Map<string, string[]>()
  for (const l of labels) {
    const root = uf.find(l.fileLabel)
    const arr = groups.get(root) ?? []
    arr.push(l.fileLabel)
    groups.set(root, arr)
  }

  // Compute clusters with minimum pairwise cosine inside each cluster.
  const clusters: MergeCluster[] = []
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const memberSet = new Set(members)
    let minCos = 1
    for (const e of edges) {
      if (memberSet.has(e.a) && memberSet.has(e.b)) {
        minCos = Math.min(minCos, e.cos)
      }
    }
    // Representative = label with the most clean speech (fallback: first in cluster).
    const representative = members.reduce((best, label) => {
      const bestMs = labels.find((l) => l.fileLabel === best)?.cleanSpeechMs ?? 0
      const labelMs = labels.find((l) => l.fileLabel === label)?.cleanSpeechMs ?? 0
      return labelMs > bestMs ? label : best
    }, members[0])
    clusters.push({
      labels: members,
      minPairCosine: minCos,
      representative,
    })
  }

  // Sort by minPairCosine descending, cap.
  clusters.sort((a, b) => b.minPairCosine - a.minPairCosine)
  return clusters.slice(0, maxMergeSuggestions)
}
