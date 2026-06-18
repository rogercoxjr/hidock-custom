import type { AppConfig } from '../config'
import type { AsrProvider } from './asr-provider'

/** AssemblyAI ASR provider — speaker diarization D1-T3 implementation.
 *  Stub: full implementation arrives in Task D1-T3. */
export function createAssemblyAiAsr(_config: AppConfig): AsrProvider {
  throw new Error('AssemblyAI ASR provider not yet implemented')
}
