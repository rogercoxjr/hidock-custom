import { GoogleGenerativeAI } from '@google/generative-ai'
import type { AppConfig } from '../config'
import type { OllamaChatMessage } from '../ollama'
import type { ChatProvider, ChatProviderOptions } from './chat-provider'

export function createGeminiChat(config: AppConfig): ChatProvider {
  if (!config.transcription.geminiApiKey) {
    throw new Error('Gemini API key not configured')
  }

  const genAI = new GoogleGenerativeAI(config.transcription.geminiApiKey)
  const modelName = config.chat.geminiModel || 'gemini-2.0-flash'

  function getModel(opts?: ChatProviderOptions) {
    return genAI.getGenerativeModel({
      model: modelName,
      ...(opts?.systemPrompt ? { systemInstruction: opts.systemPrompt } : {})
    })
  }

  return {
    async chat(messages: OllamaChatMessage[], opts?: ChatProviderOptions): Promise<string | null> {
      const model = getModel(opts)
      const contents = messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
      }))

      const result = await model.generateContent({ contents })
      return result.response.text() ?? null
    },

    async generate(prompt: string, opts?: ChatProviderOptions): Promise<string | null> {
      const model = getModel(opts)
      const result = await model.generateContent(prompt)
      return result.response.text() ?? null
    }
  }
}
