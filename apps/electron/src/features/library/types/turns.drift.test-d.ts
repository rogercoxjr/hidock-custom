/**
 * Renderer-side compile-time drift guard for `Turn` (web program / tsconfig.web.json).
 *
 * WHY NOT a cross-boundary re-export of the canonical type:
 * `electron/main/services/asr/asr-provider.ts` is the single source of truth, but
 * `export type { Turn } from '.../asr-provider'` fails typecheck with TS6307 — the
 * renderer project is `composite: true` and importing that file drags the whole
 * electron-main ASR service graph (config, gemini/whisper/assemblyai-asr) into the
 * web program, which excludes them. The node program likewise can't import the
 * renderer `Turn` (src/features/** is outside its include). So no single composite
 * program can see both types at once.
 *
 * INSTEAD: both sides are pinned to ONE written literal shape (`CanonicalTurnShape`),
 * here for the renderer `Turn` and in `electron/main/services/asr/turn.drift.test-d.ts`
 * for the canonical `Turn`. If a field is added/removed/retyped on EITHER side, that
 * side's assertion fails `npm run typecheck`. Keep both literals identical.
 *
 * Type-only: never executed (vitest matches only `*.test.ts(x)`, not `*.test-d.ts`).
 */
import type { Turn } from './turns'

/** The agreed `Turn` shape — must stay byte-identical to the copy in the node guard. */
interface CanonicalTurnShape {
  speaker: string
  startMs: number
  endMs: number
  text: string
  words?: Array<{ text: string; startMs: number; endMs: number }>
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
}

// Bidirectional assignability: renderer `Turn` and the pinned shape must match exactly.
const _shapeFromTurn: CanonicalTurnShape = {} as Turn
const _turnFromShape: Turn = {} as CanonicalTurnShape
void _shapeFromTurn
void _turnFromShape
