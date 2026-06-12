import { ipcMain } from 'electron'
import { getConfig, saveConfig, updateConfig, AppConfig } from '../services/config'
import { success, error as errorResult } from '../types/api'
import { emitActivityLog } from '../services/activity-log'

export function registerConfigHandlers(): void {
  // Get full config
  ipcMain.handle('config:get', async () => {
    try {
      return success(getConfig())
    } catch (err) {
      console.error('[config:get] Error:', err)
      return errorResult(
        'SERVICE_UNAVAILABLE',
        err instanceof Error ? err.message : 'Failed to load configuration',
        err
      )
    }
  })

  // Save full config
  ipcMain.handle('config:set', async (_, newConfig: Partial<AppConfig>) => {
    try {
      await saveConfig(newConfig)
      emitActivityLog('info', 'Settings saved')
      return success(getConfig())
    } catch (err) {
      console.error('[config:set] Error:', err)
      emitActivityLog('error', 'Failed to save settings', err instanceof Error ? err.message : undefined)
      return errorResult(
        'VALIDATION_ERROR',
        err instanceof Error ? err.message : 'Failed to save configuration',
        err
      )
    }
  })

  // Update a specific section
  ipcMain.handle(
    'config:update-section',
    async <K extends keyof AppConfig>(_, section: K, values: Partial<AppConfig[K]>) => {
      try {
        const before = getConfig()
        const oldKeys = {
          openai: before.transcription.openaiApiKey,
          gemini: before.transcription.geminiApiKey,
          ollama: before.summarization.ollamaCloudApiKey
        }
        await updateConfig(section, values)
        // Key-fix re-pend (spec §7.3): a saved provider key re-pends that provider's
        // terminal failures. Marker map per spec: openaiApiKey→'OpenAI',
        // ollamaCloudApiKey→'Ollama Cloud', geminiApiKey→'Gemini API key'.
        try {
          const after = getConfig()
          const markers: string[] = []
          if (after.transcription.openaiApiKey !== oldKeys.openai && after.transcription.openaiApiKey.trim()) markers.push('OpenAI')
          if (after.transcription.geminiApiKey !== oldKeys.gemini && after.transcription.geminiApiKey.trim()) markers.push('Gemini API key')
          if (after.summarization.ollamaCloudApiKey !== oldKeys.ollama && after.summarization.ollamaCloudApiKey.trim()) markers.push('Ollama Cloud')
          if (markers.length > 0) {
            const { rependFailedItems } = await import('../services/database')
            const count = rependFailedItems(markers)
            if (count > 0) {
              emitActivityLog('info', `Re-queued ${count} failed transcription${count === 1 ? '' : 's'} after key update`)
              const { processQueueManually } = await import('../services/transcription')
              void processQueueManually()
            }
          }
        } catch (rependErr) {
          console.error('[config:update-section] re-pend after key save failed:', rependErr)
        }
        emitActivityLog('info', `Settings updated: ${String(section)}`)
        return success(getConfig())
      } catch (err) {
        console.error(`[config:update-section] Error updating ${String(section)}:`, err)
        emitActivityLog('error', `Failed to update ${String(section)} settings`, err instanceof Error ? err.message : undefined)
        return errorResult(
          'VALIDATION_ERROR',
          err instanceof Error ? err.message : `Failed to update ${String(section)} settings`,
          err
        )
      }
    }
  )

  // Get specific value
  ipcMain.handle('config:get-value', async <K extends keyof AppConfig>(_, key: K) => {
    try {
      const config = getConfig()
      return success(config[key])
    } catch (err) {
      console.error(`[config:get-value] Error getting ${String(key)}:`, err)
      return errorResult(
        'SERVICE_UNAVAILABLE',
        err instanceof Error ? err.message : `Failed to get ${String(key)} value`,
        err
      )
    }
  })
}
