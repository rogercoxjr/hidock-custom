/**
 * transcription NON_RETRYABLE_ERRORS — speaker-diarization D1, Task 4.
 *
 * A missing AssemblyAI key throws the canonical
 * 'AssemblyAI API key not configured — add it in Settings → Transcription'
 * from createAssemblyAiAsr. That message must be matched as a terminal,
 * non-retryable failure (spec §8/AC7/AC9) so the queue does not retry it and
 * it lands in the failure chip. This test pins the canonical substring used by
 * the NON_RETRYABLE_ERRORS list in transcription.ts.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('fs', () => ({ readFileSync: vi.fn(() => Buffer.from('AUDIO')) }))

import { createAssemblyAiAsr } from '../asr/assemblyai-asr'

// The literal substring the queue's NON_RETRYABLE_ERRORS list must contain.
const ASSEMBLYAI_KEY_MARKER = 'AssemblyAI API key not configured'

describe('AssemblyAI missing-key is a terminal (non-retryable) failure', () => {
  it('createAssemblyAiAsr throws a message containing the non-retryable marker', () => {
    const cfg = { transcription: { provider: 'assemblyai', assemblyaiApiKey: '' } } as never
    let message = ''
    try {
      createAssemblyAiAsr(cfg)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain(ASSEMBLYAI_KEY_MARKER)
  })
})
