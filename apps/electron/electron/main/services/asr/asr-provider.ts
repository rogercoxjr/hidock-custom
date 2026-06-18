import type { AppConfig } from '../config'
import { createGeminiAsr } from './gemini-asr'
import { createWhisperAsr } from './whisper-asr'
import { createAssemblyAiAsr } from './assemblyai-asr'

/** One diarized speaker turn (spec §6.1). startMs/endMs are MILLISECONDS
 *  (AssemblyAI utterances are seconds — the provider converts ×1000). */
export interface Turn {
  speaker: string
  startMs: number
  endMs: number
  text: string
  words?: Array<{ text: string; startMs: number; endMs: number }>
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
}

/** Result of an ASR run (spec §5.1/§6.1). `language` is nullable — only engines
 *  that detect it (whisper-1 verbose_json) supply it. `turns` is OPTIONAL — only
 *  diarizing engines (AssemblyAI) supply it; gemini/whisper leave it undefined. */
export interface AsrResult {
  text: string
  language?: string
  turns?: Turn[]
}

export interface AsrProvider {
  transcribe(filePath: string, opts: { meetingContext?: string }): Promise<AsrResult>
}

/** Factory keyed on config.transcription.provider. Selects EXACTLY the configured
 *  provider and throws on unknown — there is NO silent fallback to another
 *  provider (spec §6.2/AC9). The missing-key guard lives in each factory. */
export function getAsrProvider(config: AppConfig): AsrProvider {
  switch (config.transcription.provider) {
    case 'assemblyai':
      return createAssemblyAiAsr(config)
    case 'gemini':
      return createGeminiAsr(config)
    case 'openai-whisper':
      return createWhisperAsr(config)
    default:
      throw new Error(`Unknown ASR provider: ${String(config.transcription.provider)}`)
  }
}
