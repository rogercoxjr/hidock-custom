import { readFileSync } from 'fs'
import { basename } from 'path'
import type { AppConfig } from '../config'
import type { AsrProvider, AsrResult } from './asr-provider'
import { normalizeForWhisper, cleanAsrTempDir } from './audio-normalize'
import { ProviderRateLimitError, ProviderAuthError } from '../provider-errors'

const WHISPER_TIMEOUT_MS = 10 * 60 * 1000 // spec §7.4

export function createWhisperAsr(config: AppConfig): AsrProvider {
  if (!config.transcription.openaiApiKey) {
    throw new Error('OpenAI API key not configured — add it in Settings → Transcription') // spec §7.1 verbatim
  }
  const apiKey = config.transcription.openaiApiKey
  const model = config.transcription.whisperModel || 'whisper-1'

  return {
    async transcribe(filePath: string, _opts: { meetingContext?: string }): Promise<AsrResult> {
      // meetingContext deliberately ignored (spec §5.1 — Whisper's prompt is a vocab hint, unused in v1)
      const { files } = await normalizeForWhisper(filePath)
      try {
        const texts: string[] = []
        let language: string | undefined
        for (const chunk of files) {
          const result = await transcribeChunk(chunk, apiKey, model)
          texts.push(result.text)
          language = language ?? result.language // language from the FIRST chunk (spec §5.1)
        }
        return { text: texts.join('\n'), language }
      } finally {
        cleanAsrTempDir()
      }
    }
  }
}

async function transcribeChunk(path: string, apiKey: string, model: string): Promise<{ text: string; language?: string }> {
  const form = new FormData()
  form.append('file', new Blob([readFileSync(path)], { type: 'audio/mpeg' }), basename(path))
  form.append('model', model)
  form.append('response_format', 'verbose_json') // whisper-1-only format; supplies language (spec §5.1)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    })
    if (res.status === 429) {
      // OpenAI signals exhausted credit as HTTP 429 + insufficient_quota in the
      // body — that is terminal (no quota window resets it), NOT parkable (§7.1).
      const body = await res.text()
      if (body.includes('insufficient_quota')) {
        throw new Error('OpenAI quota exhausted — check billing, then Retry all') // §7.1 verbatim
      }
      const retryAfter = res.headers.get('Retry-After')
      throw new ProviderRateLimitError('OpenAI', retryAfter ? Number(retryAfter) * 1000 : undefined)
    }
    if (res.status === 401) throw new ProviderAuthError('OpenAI')
    if (!res.ok) throw new Error(`OpenAI transcription failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as { text: string; language?: string }
    return { text: json.text, language: json.language }
  } finally {
    clearTimeout(timer)
  }
}
