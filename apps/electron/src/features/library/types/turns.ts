/**
 * Structured speaker turn for the renderer.
 *
 * Integration Corrections name `electron/main/services/asr/asr-provider.ts` as the
 * single source of truth for `Turn`. A type-only re-export was attempted but fails
 * `tsconfig.web.json` (TS6307): importing the canonical type drags the electron-main
 * ASR service graph into the web program, which excludes it. The reverse (node program
 * importing this file) also fails — `src/features/**` is outside its include. No single
 * composite program can see both types, so a cross-boundary `AsrTurn`-vs-`Turn` assertion
 * is impossible. Instead, the renderer keeps a structurally-identical local copy guarded
 * by paired compile-time drift checks that pin BOTH sides to one literal shape:
 *   - `turns.drift.test-d.ts` (this dir, web program) pins the renderer `Turn`
 *   - `electron/main/services/asr/turn.drift.test-d.ts` (node program) pins the canonical `Turn`
 * Any field added/removed/retyped on either side fails `npm run typecheck`.
 */
export interface Turn {
  speaker: string
  startMs: number
  endMs: number
  text: string
  words?: Array<{ text: string; startMs: number; endMs: number }>
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
}
