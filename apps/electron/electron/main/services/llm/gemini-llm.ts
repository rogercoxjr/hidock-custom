import { GoogleGenerativeAI } from '@google/generative-ai'
import type { AppConfig } from '../config'
import type { LlmProvider } from './llm-provider'

export function createGeminiLlm(config: AppConfig): LlmProvider {
  if (!config.transcription.geminiApiKey) {
    throw new Error('Gemini API key not configured')
  }
  const genAI = new GoogleGenerativeAI(config.transcription.geminiApiKey)
  const model = genAI.getGenerativeModel({
    model: config.transcription.geminiModel || 'gemini-2.0-flash-exp'
  })

  return {
    async generate(prompt: string): Promise<string> {
      // Gemini needs no special JSON mode here — today's prompts already
      // instruct JSON output and the worker extracts via fence/regex.
      const result = await model.generateContent(prompt)
      return result.response.text()
    }
  }
}
