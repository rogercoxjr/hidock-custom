/** Structured speaker turn (mirrors electron/main/services/asr/asr-provider.ts Turn). */
export interface Turn {
  speaker: string
  startMs: number
  endMs: number
  text: string
  words?: Array<{ text: string; startMs: number; endMs: number }>
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
}
