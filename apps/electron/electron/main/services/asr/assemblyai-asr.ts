import { readFileSync } from 'fs'
import type { AppConfig } from '../config'
import type { AsrProvider, AsrResult, SpeakerOptions, Turn } from './asr-provider'
import { ProviderRateLimitError, ProviderAuthError } from '../provider-errors'

const BASE = 'https://api.assemblyai.com/v2'
const HTTP_TIMEOUT_MS = 10 * 60 * 1000 // per-HTTP-call AbortController cap (AP-§7.4)
const POLL_INTERVAL_MS = 3000          // bounded poll interval
const POLL_WALL_CLOCK_MS = 30 * 60 * 1000 // hard cap so a hung job cannot run forever (§8)
const KEYTERM_MAX = 1000               // keyterms_prompt phrase cap (spec §2)
const KEYTERM_MAX_WORDS = 6            // keyterms_prompt per-phrase word cap (plan Integration Corrections)

/** AssemblyAI returns utterance/word start/end in MILLISECONDS already (confirmed
 *  against the live API: a ~5s clip's only utterance ended at 1486). Pass the value
 *  through unchanged — do NOT multiply by 1000. null/undefined → 0. */
function msField(ms: number | undefined | null): number {
  return Math.round(ms ?? 0)
}

/** Build keyterms_prompt from the worker's meetingContext: split on
 *  newlines/semicolons, trim, drop empties, drop phrases over 6 words, cap to
 *  1000 (spec §2 + plan Integration Corrections). FREE; this is NOT word_boost
 *  (word_boost silently downgrades the job — spec §2). keyterms_prompt is
 *  mutually exclusive with `prompt`; we send ONLY keyterms_prompt, never `prompt`. */
function buildKeyterms(meetingContext?: string): string[] {
  if (!meetingContext) return []
  return meetingContext
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => s.split(/\s+/).length <= KEYTERM_MAX_WORDS) // ≤6 words per phrase; drop longer
    .slice(0, KEYTERM_MAX)
}

interface AaiWord { text: string; start: number; end: number }
interface AaiUtterance {
  speaker: string
  start: number
  end: number
  text: string
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
  words?: AaiWord[]
}
interface AaiTranscript {
  id: string
  status: 'queued' | 'processing' | 'completed' | 'error'
  text?: string
  language_code?: string
  error?: string
  speech_model_used?: string
  utterances?: AaiUtterance[]
}

async function aaiFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Throw the right typed error for a non-OK AssemblyAI response (§8/AC7). */
async function throwForStatus(res: Response, what: string): Promise<never> {
  if (res.status === 401) throw new ProviderAuthError('AssemblyAI')
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After')
    throw new ProviderRateLimitError('AssemblyAI', retryAfter ? Number(retryAfter) * 1000 : undefined)
  }
  const body = (await res.text()).slice(0, 200)
  throw new Error(`AssemblyAI ${what} failed (HTTP ${res.status}): ${body}`)
}

export function createAssemblyAiAsr(config: AppConfig): AsrProvider {
  const apiKey = config.transcription.assemblyaiApiKey
  if (!apiKey) {
    // Loud, canonical — present in NON_RETRYABLE_ERRORS; NEVER a silent fallback (spec §8/§6.2/AC9).
    throw new Error('AssemblyAI API key not configured — add it in Settings → Transcription')
  }
  // PLURAL array; never the singular speech_model (streaming-only / invalid here — spec §5).
  const speechModels =
    config.transcription.assemblyaiModels && config.transcription.assemblyaiModels.length > 0
      ? config.transcription.assemblyaiModels
      : ['universal-3-pro', 'universal-2']
  const languageCode = config.transcription.language || 'en'

  return {
    async transcribe(filePath: string, opts: { meetingContext?: string; speakerOptions?: SpeakerOptions }): Promise<AsrResult> {
      // 1. Upload the bytes (Authorization is the raw key — no "Bearer ").
      const audio = readFileSync(filePath)
      const uploadRes = await aaiFetch(`${BASE}/upload`, {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/octet-stream' },
        body: audio
      })
      if (!uploadRes.ok) await throwForStatus(uploadRes, 'upload')
      const { upload_url } = (await uploadRes.json()) as { upload_url: string }

      // 2. Submit. speech_models PLURAL; keyterms_prompt (NOT word_boost).
      // NO model_region — the live API rejects it (400 "Invalid endpoint schema",
      // confirmed by probe 2026-06-18); the account's default region applies.
      // NO sentiment_analysis — it bills +$0.02/hr but its result comes back in a
      // separate `sentiment_analysis_results` array (NOT on each utterance), which we
      // never consumed; dropped per 2026-06-18 decision. If sentiment is revisited,
      // read sentiment_analysis_results — do NOT expect it on utterances.
      //
      // Phase 5: conservative static over-split range. Sent only when the policy
      // yields one; never send the mutually-exclusive `speakers_expected` exact hint.
      const submitBody: Record<string, unknown> = {
        audio_url: upload_url,
        speech_models: speechModels,
        speaker_labels: true,
        keyterms_prompt: buildKeyterms(opts.meetingContext),
        language_code: languageCode
      }
      if (opts.speakerOptions) {
        submitBody.speaker_options = {
          min_speakers_expected: opts.speakerOptions.min_speakers_expected,
          max_speakers_expected: opts.speakerOptions.max_speakers_expected
        }
      }
      const submitRes = await aaiFetch(`${BASE}/transcript`, {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(submitBody)
      })
      if (!submitRes.ok) await throwForStatus(submitRes, 'submit')
      const submitted = (await submitRes.json()) as AaiTranscript

      // 3. Poll until completed/error, with a hard wall-clock cap (§8).
      const deadline = Date.now() + POLL_WALL_CLOCK_MS
      let txn: AaiTranscript = submitted
      while (txn.status !== 'completed' && txn.status !== 'error') {
        if (Date.now() > deadline) {
          throw new Error('AssemblyAI poll timed out — retry')
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        const pollRes = await aaiFetch(`${BASE}/transcript/${submitted.id}`, {
          method: 'GET',
          headers: { Authorization: apiKey }
        })
        if (!pollRes.ok) await throwForStatus(pollRes, 'poll')
        txn = (await pollRes.json()) as AaiTranscript
      }
      if (txn.status === 'error') {
        throw new Error(`AssemblyAI transcription failed: ${txn.error ?? 'unknown error'}`)
      }

      // 4. Map utterances → Turn[]. AssemblyAI start/end are already MILLISECONDS — pass through (spec §5/AC1).
      const turns: Turn[] = (txn.utterances ?? []).map((u) => {
        const turn: Turn = {
          speaker: u.speaker,
          startMs: msField(u.start),
          endMs: msField(u.end),
          text: u.text
        }
        if (u.sentiment) turn.sentiment = u.sentiment
        if (u.words && u.words.length > 0) {
          turn.words = u.words.map((w) => ({ text: w.text, startMs: msField(w.start), endMs: msField(w.end) }))
        }
        return turn
      })

      return { text: txn.text ?? '', language: txn.language_code, turns }
    }
  }
}
