/**
 * Canonical-side compile-time drift guard for `Turn` (node program / tsconfig.node.json).
 *
 * `Turn` here is the single source of truth. The renderer keeps a structurally
 * identical copy (`src/features/library/types/turns.ts`) because a cross-boundary
 * type re-export fails TS6307 under the repo's composite project setup — see the
 * companion guard `src/features/library/types/turns.drift.test-d.ts` for the full
 * rationale.
 *
 * Both guards pin their respective `Turn` to ONE written literal shape
 * (`CanonicalTurnShape`). If a field is added/removed/retyped on the canonical side,
 * this assertion fails `npm run typecheck`. Keep this literal identical to the
 * renderer guard's copy.
 *
 * Type-only: never executed (vitest matches only `*.test.ts(x)`, not `*.test-d.ts`).
 */
import type { Turn } from './asr-provider'

/** The agreed `Turn` shape — must stay byte-identical to the copy in the renderer guard. */
interface CanonicalTurnShape {
  speaker: string
  startMs: number
  endMs: number
  text: string
  words?: Array<{ text: string; startMs: number; endMs: number }>
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
}

// Bidirectional assignability: canonical `Turn` and the pinned shape must match exactly.
const _shapeFromTurn: CanonicalTurnShape = {} as Turn
const _turnFromShape: Turn = {} as CanonicalTurnShape
void _shapeFromTurn
void _turnFromShape
