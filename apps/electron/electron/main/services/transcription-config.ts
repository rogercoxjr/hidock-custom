import { getConfig } from './config'

/**
 * Provider-aware transcription config preflight (spec §5.6). This is the
 * CANONICAL key gate — both the `transcription:validateConfig` IPC handler and
 * `recordings:addToQueue` call it so the rules live in one place. (Previously
 * addToQueue carried its own untrimmed, Gemini-only `geminiApiKey` check, which
 * would silently false-succeed for a Whisper+Ollama user before P3.)
 *
 * Returns which selected providers lack keys. Only 'missing-key' is emitted
 * here in v1 — 'rejected-key' is detected at call time (§7.1 ProviderAuthError)
 * and via the Settings Test button; the type carries it so consumers handle both.
 *
 * P3 extended the sumProvider branch for ollama-cloud — config.summarization
 * is now part of AppConfig (structural cast removed in P3).
 *
 * Lives in its own electron-free module (extracted from recording-handlers.ts
 * in plan 0f) so the hosted Fastify server can import it without pulling the
 * ipc-handler file's `electron` import into a plain-Node graph.
 */
export function validateTranscriptionConfig(): {
  ok: boolean
  problems: Array<{ stage: 'asr' | 'summarization'; provider: string; problem: 'missing-key' | 'rejected-key' }>
} {
  const config = getConfig()
  const problems: Array<{ stage: 'asr' | 'summarization'; provider: string; problem: 'missing-key' | 'rejected-key' }> = []
  const asrProvider = config.transcription.provider
  if (asrProvider === 'openai-whisper' && !config.transcription.openaiApiKey.trim()) {
    problems.push({ stage: 'asr', provider: 'openai-whisper', problem: 'missing-key' })
  }
  if (asrProvider === 'gemini' && !config.transcription.geminiApiKey.trim()) {
    problems.push({ stage: 'asr', provider: 'gemini', problem: 'missing-key' })
  }
  if (asrProvider === 'assemblyai' && !config.transcription.assemblyaiApiKey?.trim()) {
    // Loud preflight (spec §6.2/§8/AC9): blocks queueing; NEVER substitutes gemini/whisper.
    problems.push({ stage: 'asr', provider: 'assemblyai', problem: 'missing-key' })
  }
  // Summarization stage: reads config.summarization.provider (added in P3).
  const sumProvider = config.summarization?.provider ?? 'gemini'
  if (sumProvider === 'gemini' && !config.transcription.geminiApiKey.trim()) {
    if (!problems.some((p) => p.provider === 'gemini')) {
      problems.push({ stage: 'summarization', provider: 'gemini', problem: 'missing-key' })
    }
  }
  if (sumProvider === 'ollama-cloud' && !config.summarization?.ollamaCloudApiKey?.trim()) {
    problems.push({ stage: 'summarization', provider: 'ollama-cloud', problem: 'missing-key' })
  }
  return { ok: problems.length === 0, problems }
}
