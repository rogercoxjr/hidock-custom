import type { AppConfig } from '../config'
import { getOllamaService, type OllamaChatMessage } from '../ollama'
import type { ChatProvider, ChatProviderOptions } from './chat-provider'

export function createOllamaLocalChat(_config: AppConfig): ChatProvider {
  return {
    async chat(messages: OllamaChatMessage[], opts?: ChatProviderOptions): Promise<string | null> {
      const ollama = getOllamaService()
      return ollama.chat(messages, {
        systemPrompt: opts?.systemPrompt,
        temperature: opts?.temperature,
        maxTokens: opts?.maxTokens,
        signal: opts?.signal
      })
    },

    async generate(prompt: string, opts?: ChatProviderOptions): Promise<string | null> {
      const ollama = getOllamaService()
      return ollama.generate(prompt, opts?.systemPrompt)
    }
  }
}
