import type { AppConfig } from '../config'
import { getConfig } from '../config'
import type { OllamaChatMessage } from '../ollama'
import { createGeminiChat } from './gemini-chat'
import { createOllamaCloudChat } from './ollama-cloud-chat'
import { createOllamaLocalChat } from './ollama-local-chat'

export interface ChatProviderOptions {
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface ChatProvider {
  chat(messages: OllamaChatMessage[], opts?: ChatProviderOptions): Promise<string | null>
  generate(prompt: string, opts?: ChatProviderOptions): Promise<string | null>
}

export function getChatProvider(config?: AppConfig): ChatProvider {
  const cfg = config ?? getConfig()
  const provider = cfg.chat?.provider ?? 'gemini'

  switch (provider) {
    case 'gemini':
      return createGeminiChat(cfg)
    case 'ollama':
      return createOllamaLocalChat(cfg)
    case 'ollama-cloud':
      return createOllamaCloudChat(cfg)
    default:
      throw new Error(`Unknown chat provider: ${provider}`)
  }
}
