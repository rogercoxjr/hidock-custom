/**
 * outputs.ts — REST SDK group for the outputs namespace.
 *
 * Per CONTRACTS.md (Outputs table):
 *
 *   RESULT (error synthesized as {message,details?}):
 *     getTemplates, generate, getByActionableId
 *
 *   DROPPED (not implemented — browser-native or download):
 *     copyToClipboard, saveToFile
 *
 * NOTE: copyToClipboard and saveToFile are DROPPED per CONTRACTS.md §Outputs.
 *   copyToClipboard → navigator.clipboard.writeText (Task 10).
 *   saveToFile → browser download (anchor + Blob, Task 10).
 *   They remain on the interface for typecheck but throw to signal removal.
 */

import type { Http } from '../http'
import type { Result, OutputTemplate, GenerateOutputRequest, GenerateOutputResponse } from '../types'

export interface OutputsDeps {
  http: Http
}

/** Synthesise an error object for call sites that read `result.error.message`. */
function errObj(r: { error?: string; data?: unknown }): { message: string; details?: unknown } {
  return {
    message: r.error ?? 'Unknown error',
    details: (r.data as any)?.details,
  }
}

export function makeOutputsGroup({ http }: OutputsDeps) {
  return {
    // -------------------------------------------------------------------------
    // RESULT (error as {message, details?})
    // -------------------------------------------------------------------------

    async getTemplates(): Promise<Result<OutputTemplate[]>> {
      const r = await http.get('/api/outputs/templates')
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as OutputTemplate[] }
    },

    async generate(request: GenerateOutputRequest): Promise<Result<GenerateOutputResponse>> {
      const r = await http.post('/api/outputs/generate', request)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as GenerateOutputResponse }
    },

    async getByActionableId(actionableId: string): Promise<Result<GenerateOutputResponse | null>> {
      const r = await http.get(`/api/actionables/${actionableId}/output`)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as GenerateOutputResponse | null }
    },

    // -------------------------------------------------------------------------
    // DROPPED — browser-native replacements (Task 10)
    // -------------------------------------------------------------------------

    async copyToClipboard(_content: string): Promise<Result<void>> {
      // DROPPED: use navigator.clipboard.writeText (Task 10)
      return { success: false, error: { message: 'copyToClipboard is not available in web mode — use navigator.clipboard.writeText' } as any }
    },

    async saveToFile(_content: string, _suggestedName?: string): Promise<Result<string>> {
      // DROPPED: use browser download (anchor + Blob, Task 10)
      return { success: false, error: { message: 'saveToFile is not available in web mode — use browser download' } as any }
    },
  }
}

export type OutputsGroup = ReturnType<typeof makeOutputsGroup>
