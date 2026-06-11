import type { AppConfig } from '../config'
import { createGeminiAsr } from './gemini-asr'

/** Result of an ASR run (spec §5.1). language is nullable — only engines that
 *  detect it (whisper-1 verbose_json, P2) supply it; gemini-asr does not. */
export interface AsrResult {
  text: string
  language?: string
}

export interface AsrProvider {
  transcribe(filePath: string, opts: { meetingContext?: string }): Promise<AsrResult>
}

/** Factory keyed on config.transcription.provider. P1 supports 'gemini' only;
 *  P2 adds 'openai-whisper'. Throws at construction when the selected
 *  provider's key is missing — this IS the Stage-1 key check (spec §5.3). */
export function getAsrProvider(config: AppConfig): AsrProvider {
  switch (config.transcription.provider) {
    case 'gemini':
      return createGeminiAsr(config)
    default:
      throw new Error(`Unknown ASR provider: ${String(config.transcription.provider)}`)
  }
}
