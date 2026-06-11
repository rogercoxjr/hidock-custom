import { GoogleGenerativeAI } from '@google/generative-ai'
import { readFile } from 'fs'
import { promisify } from 'util'
import { extname } from 'path'
import type { AppConfig } from '../config'
import type { AsrProvider, AsrResult } from './asr-provider'

const readFileAsync = promisify(readFile)

export function createGeminiAsr(config: AppConfig): AsrProvider {
  if (!config.transcription.geminiApiKey) {
    // Canonical string — present in NON_RETRYABLE_ERRORS and §7.3 LIKE-matched.
    throw new Error('Gemini API key not configured')
  }
  const genAI = new GoogleGenerativeAI(config.transcription.geminiApiKey)
  const model = genAI.getGenerativeModel({
    model: config.transcription.geminiModel || 'gemini-2.0-flash-exp'
  })

  return {
    async transcribe(filePath: string, opts: { meetingContext?: string }): Promise<AsrResult> {
      const audioBuffer = await readFileAsync(filePath)
      const base64Audio = audioBuffer.toString('base64')

      const ext = extname(filePath).toLowerCase()
      const mimeTypes: Record<string, string> = {
        '.wav': 'audio/wav',
        '.mp3': 'audio/mp3',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
        '.webm': 'audio/webm',
        '.hda': 'audio/mp3' // HiDock H1E outputs MPEG MP3 format
      }
      const mimeType = mimeTypes[ext] || 'audio/wav'

      const transcriptionPrompt = `Transcribe this audio recording.
The audio may be in Spanish or English - transcribe in the original language.
Provide a clean, accurate transcription of all speech.
If there are multiple speakers, try to indicate speaker changes with "Speaker 1:", "Speaker 2:", etc.
${opts.meetingContext ?? ''}
Return ONLY the transcription, no additional commentary.`

      const result = await model.generateContent([
        {
          inlineData: {
            mimeType,
            data: base64Audio
          }
        },
        { text: transcriptionPrompt }
      ])

      // gemini-asr supplies no language — today's language comes from the
      // Stage-2 analysis JSON (spec §5.3 "language ownership").
      return { text: result.response.text() }
    }
  }
}
