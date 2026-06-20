import { describe, it, expect } from 'vitest'
import { applyConflictPolicy, type PolicyInput } from '../conflict-policy'
import type { IdentityResult } from '../identity-matcher'
import type { MergeCluster } from '../merge-detector'
import type { MixedFlag } from '../mixed-detector'

function makeIdentityResult(decision: IdentityResult['decision'], contactId = 'c1', score = 0.9): IdentityResult {
  return {
    candidates: [{ contactId, score, viaCentroid: true }],
    best: { contactId, score, viaCentroid: true },
    margin: 0.2,
    decision,
  }
}

describe('applyConflictPolicy', () => {
  it('emits a normal identity suggestion for an unassigned label', () => {
    const input: PolicyInput = {
      recordingId: 'r1',
      diarizationRunId: 'dr1',
      identities: [{ fileLabel: 'A', result: makeIdentityResult('strong', 'Robyn') }],
      merges: [],
      mixed: [],
      existingAssignments: new Map(),
      dismissedKeys: new Set(),
      selfContactId: null,
    }
    const { suggestions } = applyConflictPolicy(input)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].kind).toBe('identity')
    expect(suggestions[0].targetLabel).toBe('A')
    expect(suggestions[0].contactId).toBe('Robyn')
    expect(suggestions[0].rationale).toBe('strong match')
  })

  it('Rule 1: skips identity suggestion for manually assigned labels', () => {
    const input: PolicyInput = {
      recordingId: 'r1',
      diarizationRunId: 'dr1',
      identities: [{ fileLabel: 'A', result: makeIdentityResult('strong', 'Robyn') }],
      merges: [],
      mixed: [],
      existingAssignments: new Map([['A', { contactId: 'Robyn', source: 'user' }]]),
      dismissedKeys: new Set(),
      selfContactId: null,
    }
    const { suggestions } = applyConflictPolicy(input)
    expect(suggestions).toHaveLength(0)
  })

  it('Rule 2: emits "looks more like X" for confirmed label with new strong top', () => {
    const input: PolicyInput = {
      recordingId: 'r1',
      diarizationRunId: 'dr1',
      identities: [{ fileLabel: 'A', result: makeIdentityResult('strong', 'Tiffany', 0.7) }],
      merges: [],
      mixed: [],
      existingAssignments: new Map([['A', { contactId: 'Robyn', source: 'confirmed' }]]),
      dismissedKeys: new Set(),
      selfContactId: null,
    }
    const { suggestions } = applyConflictPolicy(input)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].kind).toBe('identity')
    expect(suggestions[0].contactId).toBe('Tiffany')
    expect(suggestions[0].rationale).toContain('looks more like')
  })

  it('Rule 2: skips re-suggestion when confirmed label matches the same top', () => {
    const input: PolicyInput = {
      recordingId: 'r1',
      diarizationRunId: 'dr1',
      identities: [{ fileLabel: 'A', result: makeIdentityResult('strong', 'Robyn') }],
      merges: [],
      mixed: [],
      existingAssignments: new Map([['A', { contactId: 'Robyn', source: 'confirmed' }]]),
      dismissedKeys: new Set(),
      selfContactId: null,
    }
    const { suggestions } = applyConflictPolicy(input)
    expect(suggestions).toHaveLength(0)
  })

  it('Rule 3: tags cross-contact merge with requiresWarning', () => {
    const cluster: MergeCluster = {
      labels: ['A', 'B'],
      minPairCosine: 0.9,
      representative: 'A',
    }
    const input: PolicyInput = {
      recordingId: 'r1',
      diarizationRunId: 'dr1',
      identities: [],
      merges: [cluster],
      mixed: [],
      existingAssignments: new Map([
        ['A', { contactId: 'Robyn', source: 'confirmed' }],
        ['B', { contactId: 'Tiffany', source: 'confirmed' }],
      ]),
      dismissedKeys: new Set(),
      selfContactId: null,
    }
    const { suggestions } = applyConflictPolicy(input)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].requiresWarning).toBe(true)
    expect(suggestions[0].rationale).toContain('merges')
  })

  it('Rule 3: no warning for merge within the same contact', () => {
    const cluster: MergeCluster = {
      labels: ['A', 'B'],
      minPairCosine: 0.9,
      representative: 'A',
    }
    const input: PolicyInput = {
      recordingId: 'r1',
      diarizationRunId: 'dr1',
      identities: [],
      merges: [cluster],
      mixed: [],
      existingAssignments: new Map([
        ['A', { contactId: 'Robyn', source: 'confirmed' }],
        ['B', { contactId: 'Robyn', source: 'confirmed' }],
      ]),
      dismissedKeys: new Set(),
      selfContactId: null,
    }
    const { suggestions } = applyConflictPolicy(input)
    expect(suggestions[0].requiresWarning).toBe(false)
  })

  it('Rule 5: multiple self labels become pairwise merge suggestions', () => {
    const input: PolicyInput = {
      recordingId: 'r1',
      diarizationRunId: 'dr1',
      identities: [
        { fileLabel: 'A', result: makeIdentityResult('strong', 'me'), cleanSpeechMs: 30_000 },
        { fileLabel: 'B', result: makeIdentityResult('strong', 'me'), cleanSpeechMs: 50_000 },
        { fileLabel: 'C', result: makeIdentityResult('strong', 'me'), cleanSpeechMs: 20_000 },
      ],
      merges: [],
      mixed: [],
      existingAssignments: new Map(),
      dismissedKeys: new Set(),
      selfContactId: 'me',
    }
    const { suggestions } = applyConflictPolicy(input)
    expect(suggestions).toHaveLength(2)
    expect(suggestions.every((s) => s.kind === 'merge' && s.contactId === 'me' && s.targetLabel === 'B')).toBe(true)
    expect(suggestions.map((s) => s.targetLabel2).sort()).toEqual(['A', 'C'])
  })

  it('Rule 5: single self label still emits an identity suggestion', () => {
    const input: PolicyInput = {
      recordingId: 'r1',
      diarizationRunId: 'dr1',
      identities: [{ fileLabel: 'A', result: makeIdentityResult('strong', 'me') }],
      merges: [],
      mixed: [],
      existingAssignments: new Map(),
      dismissedKeys: new Set(),
      selfContactId: 'me',
    }
    const { suggestions } = applyConflictPolicy(input)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].kind).toBe('identity')
    expect(suggestions[0].contactId).toBe('me')
  })

  it('drops suggestions whose key is in dismissedKeys', () => {
    const input: PolicyInput = {
      recordingId: 'r1',
      diarizationRunId: 'dr1',
      identities: [{ fileLabel: 'A', result: makeIdentityResult('strong', 'Robyn') }],
      merges: [],
      mixed: [],
      existingAssignments: new Map(),
      dismissedKeys: new Set([JSON.stringify(['identity', 'A', '', 'Robyn', ''])]),
      selfContactId: null,
    }
    const { suggestions } = applyConflictPolicy(input)
    expect(suggestions).toHaveLength(0)
  })

  it('emits mixed flags as informational', () => {
    const flag: MixedFlag = {
      fileLabel: 'B',
      reason: 'variance',
      dispersion: 0.45,
    }
    const input: PolicyInput = {
      recordingId: 'r1',
      diarizationRunId: 'dr1',
      identities: [],
      merges: [],
      mixed: [flag],
      existingAssignments: new Map(),
      dismissedKeys: new Set(),
      selfContactId: null,
    }
    const { suggestions } = applyConflictPolicy(input)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].kind).toBe('mixed')
    expect(suggestions[0].targetLabel).toBe('B')
  })
})
