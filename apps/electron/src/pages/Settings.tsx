import { useEffect, useState, useCallback, useMemo } from 'react'
import { Save, FolderOpen, RefreshCw, AlertCircle, Eye, EyeOff, Shield, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { useAppStore, useCalendarSyncing } from '@/store/useAppStore'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { formatBytes } from '@/lib/utils'
import { HealthCheck } from '@/components/HealthCheck'
import { toast } from '@/components/ui/toaster'
import type { StorageInfo, AppConfig } from '@/types'

// RAG configuration constants — MAX_CONTEXT_CHUNKS must match config.ts default (10)
const RAG_DEFAULTS = {
  MAX_CONTEXT_CHUNKS: 10,
  MIN_CONTEXT_CHUNKS: 1,
  MAX_CONTEXT_CHUNKS_LIMIT: 20
} as const

// Transcription language options — value is the ISO code sent to the ASR provider
// ('auto' = let the provider auto-detect). Default is 'en' (config.ts).
const TRANSCRIPTION_LANGUAGES = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' }
] as const

export function Settings() {
  // SM-09 fix: Use granular selectors
  const syncCalendar = useAppStore((s) => s.syncCalendar)
  const calendarSyncing = useCalendarSyncing()
  const { config, loadConfig, updateConfig, configLoading } = useConfigStore()
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null) // B-SET-002: Storage error state
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Voice Library privacy toggles (Phase 2)
  const [enableVoiceprintCapture, setEnableVoiceprintCapture] = useState(true)
  const [excludeVoiceprintsFromBackup, setExcludeVoiceprintsFromBackup] = useState(true)
  const [clearAllDialogOpen, setClearAllDialogOpen] = useState(false)
  const [clearingVoiceprints, setClearingVoiceprints] = useState(false)

  // Local form state
  const [icsUrl, setIcsUrl] = useState('')
  const [syncEnabled, setSyncEnabled] = useState(true)
  const [syncInterval, setSyncInterval] = useState(15)
  const [geminiApiKey, setGeminiApiKey] = useState('')
  const [geminiModel, setGeminiModel] = useState('gemini-3-pro-preview')
  const [language, setLanguage] = useState('en')
  const [asrProvider, setAsrProvider] = useState<'gemini' | 'openai-whisper' | 'assemblyai'>('gemini')
  const [openaiApiKey, setOpenaiApiKey] = useState('')
  const [showOpenaiKey, setShowOpenaiKey] = useState(false)
  const [assemblyaiApiKey, setAssemblyaiApiKey] = useState('')
  const [showAssemblyaiKey, setShowAssemblyaiKey] = useState(false)
  const [chatProvider, setChatProvider] = useState<'gemini' | 'ollama' | 'ollama-cloud'>('gemini')
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434')
  const [showApiKey, setShowApiKey] = useState(false)
  const [storageLoading, setStorageLoading] = useState(false)
  // C-CHAT: RAG context window — default matches config.ts (10)
  const [ragContextSize, setRagContextSize] = useState<number>(RAG_DEFAULTS.MAX_CONTEXT_CHUNKS)
  // Summarization settings (spec §5.6 Summarization card)
  const [sumProvider, setSumProvider] = useState<'gemini' | 'ollama-cloud'>('gemini')
  const [ollamaCloudApiKey, setOllamaCloudApiKey] = useState('')
  const [showOllamaKey, setShowOllamaKey] = useState(false)
  const [ollamaCloudModel, setOllamaCloudModel] = useState('')
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)

  // Available Gemini models for transcription (audio-capable)
  // From: https://ai.google.dev/gemini-api/docs/models
  const GEMINI_MODELS = [
    // Gemini 3 Series
    { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview (Best quality)' },
    { value: 'gemini-3-pro-image-preview', label: 'Gemini 3 Pro Image Preview' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview (Fast)' },
    // Gemini 2.5 Pro Series
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Stable)' },
    { value: 'gemini-2.5-pro-preview-tts', label: 'Gemini 2.5 Pro TTS Preview' },
    // Gemini 2.5 Flash Series
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Stable)' },
    { value: 'gemini-2.5-flash-preview-09-2025', label: 'Gemini 2.5 Flash Preview' },
    { value: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image' },
    { value: 'gemini-2.5-flash-native-audio-preview-12-2025', label: 'Gemini 2.5 Flash Native Audio (Dec 2025)' },
    { value: 'gemini-2.5-flash-native-audio-preview-09-2025', label: 'Gemini 2.5 Flash Native Audio (Sep 2025)' },
    { value: 'gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash TTS Preview' },
    // Gemini 2.5 Flash-Lite Series
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (Stable)' },
    { value: 'gemini-2.5-flash-lite-preview-09-2025', label: 'Gemini 2.5 Flash Lite Preview' },
  ]

  // Validation function for config values
  const validateConfig = useCallback((updates: Partial<AppConfig>): string | null => {
    // Transcription settings validation
    if (updates.transcription) {
      // Gemini key validation — only enforced when Gemini is the active provider.
      // Symmetric with the Whisper gating below: a stale/invalid key for the
      // INACTIVE provider must not block saving (spec §5.6 — the Whisper+Ollama
      // user must be able to queue/retry without a valid Gemini key).
      if (updates.transcription.provider !== 'openai-whisper' && updates.transcription.geminiApiKey !== undefined) {
        const apiKey = updates.transcription.geminiApiKey.trim()
        if (apiKey && apiKey.length < 10) {
          return 'API key must be at least 10 characters'
        }
        if (apiKey && !apiKey.startsWith('AIza')) {
          return 'Gemini API keys should start with "AIza". Please verify your key.'
        }
      }
      // OpenAI key validation — only enforced when the whisper provider is selected (spec §5.4)
      if (updates.transcription.provider === 'openai-whisper' && updates.transcription.openaiApiKey !== undefined) {
        const apiKey = updates.transcription.openaiApiKey.trim()
        if (apiKey && apiKey.length < 10) {
          return 'API key must be at least 10 characters'
        }
        if (apiKey && !apiKey.startsWith('sk-')) {
          return 'OpenAI API keys should start with "sk-". Please verify your key.'
        }
      }
    }

    // Calendar settings validation
    if (updates.calendar) {
      if (updates.calendar.icsUrl !== undefined) {
        const url = updates.calendar.icsUrl.trim()
        if (url && !url.startsWith('http')) {
          return 'Calendar URL must start with http:// or https://'
        }
      }
      if (updates.calendar.syncIntervalMinutes !== undefined) {
        const interval = updates.calendar.syncIntervalMinutes
        if (interval < 5 || interval > 120) {
          return 'Sync interval must be between 5 and 120 minutes'
        }
      }
    }

    // Embeddings settings validation
    if (updates.embeddings) {
      if (updates.embeddings.ollamaBaseUrl !== undefined) {
        const url = updates.embeddings.ollamaBaseUrl.trim()
        if (url && !url.startsWith('http')) {
          return 'Ollama URL must start with http:// or https://'
        }
      }
    }

    return null // Valid
  }, [])

  // C-SET: Track form dirty state per section
  const isCalendarDirty = useMemo(() => {
    if (!config) return false
    return (
      icsUrl !== config.calendar.icsUrl ||
      syncEnabled !== config.calendar.syncEnabled ||
      syncInterval !== config.calendar.syncIntervalMinutes
    )
  }, [config, icsUrl, syncEnabled, syncInterval])

  const isTranscriptionDirty = useMemo(() => {
    if (!config) return false
    return (
      asrProvider !== (config.transcription.provider || 'gemini') ||
      geminiApiKey !== config.transcription.geminiApiKey ||
      geminiModel !== (config.transcription.geminiModel || 'gemini-3-pro-preview') ||
      language !== (config.transcription.language || 'en') ||
      openaiApiKey !== (config.transcription.openaiApiKey || '') ||
      assemblyaiApiKey !== (config.transcription.assemblyaiApiKey || '')
    )
  }, [config, asrProvider, geminiApiKey, geminiModel, language, openaiApiKey, assemblyaiApiKey])

  const isChatDirty = useMemo(() => {
    if (!config) return false
    return (
      chatProvider !== config.chat.provider ||
      ollamaUrl !== config.embeddings.ollamaBaseUrl ||
      ragContextSize !== config.chat.maxContextChunks
    )
  }, [config, chatProvider, ollamaUrl, ragContextSize])

  const isSummarizationDirty = useMemo(() => {
    if (!config) return false
    const cfg = config.summarization
    // Defensive branch for legacy config files written before the summarization section landed.
    if (!cfg) return sumProvider !== 'gemini' || ollamaCloudApiKey !== '' || ollamaCloudModel !== ''
    return (
      sumProvider !== (cfg.provider || 'gemini') ||
      ollamaCloudApiKey !== (cfg.ollamaCloudApiKey || '') ||
      ollamaCloudModel !== (cfg.ollamaCloudModel || '')
    )
  }, [config, sumProvider, ollamaCloudApiKey, ollamaCloudModel])

  // Stable loadConfig with useCallback for dependency array
  const loadConfigStable = useCallback(async () => {
    try {
      setLoadError(null)
      await loadConfig()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load settings'
      setLoadError(message)
      toast.error('Failed to Load Settings', message)
    }
  }, [loadConfig])

  useEffect(() => {
    loadConfigStable()
    loadStorageInfo()
  }, [loadConfigStable])

  useEffect(() => {
    if (config) {
      setIcsUrl(config.calendar.icsUrl)
      setSyncEnabled(config.calendar.syncEnabled)
      setSyncInterval(config.calendar.syncIntervalMinutes)
      setGeminiApiKey(config.transcription.geminiApiKey)
      setGeminiModel(config.transcription.geminiModel || 'gemini-3-pro-preview')
      setLanguage(config.transcription.language || 'en')
      setAsrProvider(config.transcription.provider || 'gemini')
      setOpenaiApiKey(config.transcription.openaiApiKey || '')
      setAssemblyaiApiKey(config.transcription.assemblyaiApiKey || '')
      setChatProvider(config.chat.provider)
      setOllamaUrl(config.embeddings.ollamaBaseUrl)
      // C-CHAT: Load RAG context window size
      setRagContextSize(config.chat.maxContextChunks)
      // Summarization (P3) — config.summarization is typed; the guard covers legacy config files.
      const sumCfg = config.summarization
      if (sumCfg) {
        setSumProvider(sumCfg.provider || 'gemini')
        setOllamaCloudApiKey(sumCfg.ollamaCloudApiKey || '')
        setOllamaCloudModel(sumCfg.ollamaCloudModel || '')
      }
      const privacyCfg = config.privacy
      if (privacyCfg) {
        setEnableVoiceprintCapture(privacyCfg.enableVoiceprintCapture ?? true)
        setExcludeVoiceprintsFromBackup(privacyCfg.excludeVoiceprintsFromBackup ?? true)
      }
    }
  }, [config])

  const loadStorageInfo = async () => {
    try {
      setStorageError(null) // B-SET-002: Clear previous error
      setStorageLoading(true)
      const result = await window.electronAPI.storage.getInfo()
      if (result.success && result.data) {
        setStorageInfo(result.data)
      } else {
        // B-SET-002: Surface storage errors to user
        const errorMsg = result.error || 'Failed to load storage info'
        setStorageError(typeof errorMsg === 'string' ? errorMsg : String(errorMsg))
        console.error('Failed to load storage info:', result.error)
      }
    } catch (error) {
      // B-SET-002: Surface storage errors to user
      const errorMsg = error instanceof Error ? error.message : 'Failed to load storage info'
      setStorageError(errorMsg)
      console.error('Failed to load storage info:', error)
    } finally {
      setStorageLoading(false)
    }
  }

  const handleSaveCalendar = async () => {
    if (saving) {
      toast.warning('Please wait', 'Previous save in progress')
      return
    }

    // Store previous values for rollback
    const previousIcsUrl = config?.calendar.icsUrl || ''
    const previousSyncEnabled = config?.calendar.syncEnabled ?? true
    const previousSyncInterval = config?.calendar.syncIntervalMinutes || 15

    const updates = {
      icsUrl,
      syncEnabled,
      syncIntervalMinutes: syncInterval
    }

    // Validate before save - validateConfig accepts any shape
    const validationError = validateConfig({ calendar: updates } as Partial<AppConfig>)
    if (validationError) {
      toast.error('Validation Error', validationError)
      return
    }

    setSaving(true)
    try {
      await updateConfig('calendar', updates)

      toast.success('Settings Saved', 'Calendar settings have been updated')
    } catch (error) {
      // Rollback on error
      setIcsUrl(previousIcsUrl)
      setSyncEnabled(previousSyncEnabled)
      setSyncInterval(previousSyncInterval)

      const message = error instanceof Error ? error.message : 'Failed to save calendar settings'
      toast.error('Save Failed', message)
      console.error('Failed to save calendar settings:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveTranscription = async () => {
    if (saving) {
      toast.warning('Please wait', 'Previous save in progress')
      return
    }

    // Store previous values for rollback
    const previousAsrProvider = config?.transcription.provider || 'gemini'
    const previousApiKey = config?.transcription.geminiApiKey || ''
    const previousModel = config?.transcription.geminiModel || 'gemini-3-pro-preview'
    const previousLanguage = config?.transcription.language || 'en'
    const previousOpenaiApiKey = config?.transcription.openaiApiKey || ''
    const previousAssemblyaiApiKey = config?.transcription.assemblyaiApiKey || ''

    const updates = {
      provider: asrProvider,
      geminiApiKey,
      geminiModel,
      language,
      openaiApiKey,
      assemblyaiApiKey,
      whisperModel: 'whisper-1' as const
    }

    // Validate before save
    const validationError = validateConfig({ transcription: updates } as Partial<AppConfig>)
    if (validationError) {
      toast.error('Validation Error', validationError)
      return
    }

    setSaving(true)
    try {
      await updateConfig('transcription', updates)

      const activeProviderLabel =
        asrProvider === 'openai-whisper' ? 'OpenAI Whisper' :
        asrProvider === 'assemblyai' ? 'AssemblyAI' : 'Gemini'
      toast.success('Settings Saved', `Transcription provider set to ${activeProviderLabel}`)
    } catch (error) {
      // Rollback on error
      setAsrProvider(previousAsrProvider)
      setGeminiApiKey(previousApiKey)
      setGeminiModel(previousModel)
      setLanguage(previousLanguage)
      setOpenaiApiKey(previousOpenaiApiKey)
      setAssemblyaiApiKey(previousAssemblyaiApiKey)

      const message = error instanceof Error ? error.message : 'Failed to save transcription settings'
      toast.error('Save Failed', message)
      console.error('Failed to save transcription settings:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveChat = async () => {
    if (saving) {
      toast.warning('Please wait', 'Previous save in progress')
      return
    }

    // Store previous values for rollback
    const previousChatProvider = config?.chat.provider || 'gemini'
    const previousOllamaUrl = config?.embeddings.ollamaBaseUrl || 'http://localhost:11434'
    const previousContextSize = config?.chat.maxContextChunks || RAG_DEFAULTS.MAX_CONTEXT_CHUNKS

    const chatUpdates = {
      provider: chatProvider,
      maxContextChunks: ragContextSize
    }

    const embeddingsUpdates = {
      ollamaBaseUrl: ollamaUrl
    }

    // Validate before save
    const validationError = validateConfig({
      chat: chatUpdates,
      embeddings: embeddingsUpdates
    } as Partial<AppConfig>)
    if (validationError) {
      toast.error('Validation Error', validationError)
      return
    }

    setSaving(true)
    try {
      // Save both sections atomically using Promise.all to prevent partial state
      await Promise.all([
        updateConfig('chat', chatUpdates),
        updateConfig('embeddings', embeddingsUpdates)
      ])

      toast.success('Settings Saved', `Chat provider set to ${chatProvider}`)
    } catch (error) {
      // Rollback on error - both sections revert
      setChatProvider(previousChatProvider)
      setOllamaUrl(previousOllamaUrl)
      setRagContextSize(previousContextSize)
      // Reload config from backend to ensure consistency after partial failure
      try { await loadConfig() } catch { /* best effort reload */ }

      const message = error instanceof Error ? error.message : 'Failed to save chat settings'
      toast.error('Save Failed', message)
      console.error('Failed to save chat settings:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveSummarization = async () => {
    if (saving) {
      toast.warning('Please wait', 'Previous save in progress')
      return
    }

    // Validation: when ollama-cloud is selected, require a key (≥10 chars) and a model
    if (sumProvider === 'ollama-cloud') {
      if (!ollamaCloudApiKey.trim() || ollamaCloudApiKey.trim().length < 10) {
        toast.error('Validation Error', 'Ollama Cloud API key must be at least 10 characters')
        return
      }
      if (!ollamaCloudModel.trim()) {
        toast.error('Validation Error', 'Ollama Cloud model is required')
        return
      }
    }

    const previousSumProvider = config?.summarization?.provider ?? 'gemini'
    const previousOllamaCloudApiKey = config?.summarization?.ollamaCloudApiKey ?? ''
    const previousOllamaCloudModel = config?.summarization?.ollamaCloudModel ?? ''

    setSaving(true)
    try {
      await updateConfig('summarization', {
        provider: sumProvider,
        ollamaCloudApiKey,
        ollamaCloudModel
      })
      const label = sumProvider === 'ollama-cloud' ? 'Ollama Cloud' : 'Gemini'
      toast.success('Settings Saved', `Summarization provider set to ${label}`)
    } catch (error) {
      setSumProvider(previousSumProvider)
      setOllamaCloudApiKey(previousOllamaCloudApiKey)
      setOllamaCloudModel(previousOllamaCloudModel)

      const message = error instanceof Error ? error.message : 'Failed to save summarization settings'
      toast.error('Save Failed', message)
      console.error('Failed to save summarization settings:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleFetchModels = async () => {
    setFetchingModels(true)
    try {
      // Pass the form key so first-run fetch works before Save (no saved-vs-unsaved coupling)
      const result = await window.electronAPI.summarization.listModels(ollamaCloudApiKey)
      if (result.success && result.models) {
        setOllamaModels(result.models)
        if (result.models.length === 0) {
          toast.warning('No Models Found', 'No models are available for this API key')
        }
      } else {
        toast.error('Fetch Models Failed', result.error || 'Could not retrieve model list')
      }
    } catch (error) {
      toast.error('Fetch Models Failed', error instanceof Error ? error.message : 'Unknown error')
    } finally {
      setFetchingModels(false)
    }
  }

  const handleTestConnection = async () => {
    try {
      // Pass the form key + model so Test reflects what the user typed, not stale saved values
      const result = await window.electronAPI.summarization.testConnection(ollamaCloudApiKey, ollamaCloudModel)
      if (result.success) {
        toast.success('Connection OK', 'Ollama Cloud connection and model are working')
      } else {
        toast.error('Connection Failed', result.error || 'Test connection failed')
      }
    } catch (error) {
      toast.error('Connection Failed', error instanceof Error ? error.message : 'Unknown error')
    }
  }

  const handleOpenFolder = async (folder: 'recordings' | 'transcripts' | 'data') => {
    await window.electronAPI.storage.openFolder(folder)
  }

  // Voice Library privacy toggles (Phase 2) — save-on-toggle
  const handleToggleVoiceprintCapture = async (checked: boolean) => {
    const previous = enableVoiceprintCapture
    setEnableVoiceprintCapture(checked)
    try {
      await updateConfig('privacy', {
        ...(config?.privacy ?? {}),
        enableVoiceprintCapture: checked
      })
      toast.success('Privacy Setting Saved', checked ? 'Voiceprint capture enabled' : 'Voiceprint capture disabled')
    } catch (err) {
      setEnableVoiceprintCapture(previous)
      toast.error('Failed to save privacy setting', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const handleToggleExcludeFromBackup = async (checked: boolean) => {
    const previous = excludeVoiceprintsFromBackup
    setExcludeVoiceprintsFromBackup(checked)
    try {
      await updateConfig('privacy', {
        ...(config?.privacy ?? {}),
        excludeVoiceprintsFromBackup: checked
      })
      toast.success('Privacy Setting Saved', checked ? 'Voiceprints excluded from backups' : 'Voiceprints will be included in backups')
    } catch (err) {
      setExcludeVoiceprintsFromBackup(previous)
      toast.error('Failed to save privacy setting', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const handleClearAllVoiceprints = async () => {
    setClearingVoiceprints(true)
    try {
      const result = await window.electronAPI.voiceprints.clearAll()
      if (result.success && result.data) {
        const deleted = result.data.deleted
        if (deleted > 0) {
          toast.success('Voiceprints Cleared', `Removed ${deleted} voiceprint${deleted === 1 ? '' : 's'}.`)
        } else {
          toast.info('No Voiceprints', 'There were no voiceprints to remove.')
        }
      } else {
        toast.error('Failed to clear voiceprints', (result as any).error?.message || 'Unknown error')
      }
    } catch (err) {
      console.error('Failed to clear voiceprints:', err)
      toast.error('Failed to clear voiceprints', err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setClearingVoiceprints(false)
      setClearAllDialogOpen(false)
    }
  }

  // Loading state
  if (configLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground mb-4" />
        <p className="text-muted-foreground">Loading settings...</p>
      </div>
    )
  }

  // Error state with retry
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Failed to Load Settings</h2>
        <p className="text-muted-foreground mb-4 text-center max-w-md">{loadError}</p>
        <Button onClick={loadConfigStable}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <header className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold">Settings</h1>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* Calendar Settings */}
          <Card>
            <CardHeader>
              <CardTitle>Calendar</CardTitle>
              <CardDescription>Configure calendar sync from Outlook</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label htmlFor="icsUrl" className="text-sm font-medium">ICS Calendar URL</label>
                <Input
                  id="icsUrl"
                  type="url"
                  placeholder="https://outlook.office365.com/owa/calendar/.../calendar.ics"
                  value={icsUrl}
                  onChange={(e) => setIcsUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveCalendar()}
                  disabled={saving}
                  aria-label="ICS Calendar URL"
                  aria-describedby="icsUrl-description"
                  className="mt-1"
                />
                <p id="icsUrl-description" className="text-xs text-muted-foreground mt-1">
                  Publish your Outlook calendar and paste the ICS link here
                </p>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="syncEnabled"
                    checked={syncEnabled}
                    onChange={(e) => setSyncEnabled(e.target.checked)}
                    disabled={saving}
                    aria-label="Enable auto-sync"
                    className="rounded"
                  />
                  <label htmlFor="syncEnabled" className="text-sm">
                    Auto-sync enabled
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <label htmlFor="syncInterval" className="text-sm">Every</label>
                  <Input
                    id="syncInterval"
                    type="number"
                    min={5}
                    max={120}
                    value={syncInterval}
                    onChange={(e) => {
                      const val = parseInt(e.target.value)
                      if (isNaN(val)) return
                      // Clamp to valid range
                      setSyncInterval(Math.min(120, Math.max(5, val)))
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveCalendar()}
                    disabled={saving}
                    aria-label="Sync interval in minutes"
                    className="w-20"
                  />
                  <span className="text-sm">minutes</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={handleSaveCalendar}
                  disabled={saving || !isCalendarDirty}
                  aria-label="Save calendar settings"
                >
                  <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                  {isCalendarDirty ? 'Save' : 'Saved'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => syncCalendar()}
                  disabled={calendarSyncing || saving}
                  aria-label="Sync calendar now"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${calendarSyncing ? 'animate-spin' : ''}`} aria-hidden="true" />
                  Sync Now
                </Button>
                {config?.calendar.lastSyncAt && (
                  <span className="text-xs text-muted-foreground ml-2">
                    Last synced: {new Date(config.calendar.lastSyncAt).toLocaleString()}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Transcription Settings */}
          <Card>
            <CardHeader>
              <CardTitle>Transcription</CardTitle>
              <CardDescription>Configure the transcription (ASR) provider</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* ASR provider picker — Button-group idiom (matches Chat provider toggle) */}
              <div>
                <label id="asrProvider-label" className="text-sm font-medium">ASR Provider</label>
                <div className="flex gap-2 mt-2" role="group" aria-labelledby="asrProvider-label">
                  <Button
                    variant={asrProvider === 'gemini' ? 'default' : 'outline'}
                    onClick={() => setAsrProvider('gemini')}
                    onKeyDown={(e) => e.key === 'Enter' && setAsrProvider('gemini')}
                    disabled={saving}
                    aria-label="Use Gemini ASR provider"
                    aria-pressed={asrProvider === 'gemini'}
                  >
                    Gemini
                  </Button>
                  <Button
                    variant={asrProvider === 'openai-whisper' ? 'default' : 'outline'}
                    onClick={() => setAsrProvider('openai-whisper')}
                    onKeyDown={(e) => e.key === 'Enter' && setAsrProvider('openai-whisper')}
                    disabled={saving}
                    aria-label="Use OpenAI Whisper ASR provider"
                    aria-pressed={asrProvider === 'openai-whisper'}
                  >
                    OpenAI Whisper
                  </Button>
                  <Button
                    variant={asrProvider === 'assemblyai' ? 'default' : 'outline'}
                    onClick={() => setAsrProvider('assemblyai')}
                    onKeyDown={(e) => e.key === 'Enter' && setAsrProvider('assemblyai')}
                    disabled={saving}
                    aria-label="Use AssemblyAI ASR provider"
                    aria-pressed={asrProvider === 'assemblyai'}
                  >
                    AssemblyAI
                  </Button>
                </div>
              </div>

              {asrProvider === 'assemblyai' && (
                <p className="text-xs text-muted-foreground rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-2">
                  Speaker detection uses AssemblyAI (cloud, global routing); recordings are uploaded for processing.{' '}
                  <a
                    href="https://www.assemblyai.com/legal/terms-of-service"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Terms of Service
                  </a>
                </p>
              )}

              {asrProvider === 'gemini' && (
                <>
              <div>
                <label htmlFor="geminiApiKey" className="text-sm font-medium">Gemini API Key</label>
                <div className="relative mt-1">
                  <Input
                    id="geminiApiKey"
                    type={showApiKey ? 'text' : 'password'}
                    placeholder="Enter your Gemini API key"
                    value={geminiApiKey}
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveTranscription()}
                    disabled={saving}
                    aria-label="Gemini API Key"
                    aria-describedby="geminiApiKey-description"
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                    onClick={() => setShowApiKey(!showApiKey)}
                    aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                    tabIndex={-1}
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <p id="geminiApiKey-description" className="text-xs text-muted-foreground mt-1">
                  Get your API key from{' '}
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Google AI Studio
                  </a>
                </p>
              </div>

              <div>
                <label htmlFor="geminiModel" className="text-sm font-medium">Transcription Model</label>
                <select
                  id="geminiModel"
                  value={geminiModel}
                  onChange={(e) => setGeminiModel(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveTranscription()}
                  disabled={saving}
                  aria-label="Transcription Model"
                  aria-describedby="geminiModel-description"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                >
                  {GEMINI_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <p id="geminiModel-description" className="text-xs text-muted-foreground mt-1">
                  Gemini 3 Pro provides the best transcription accuracy
                </p>
              </div>
                </>
              )}

              {asrProvider === 'openai-whisper' && (
                <>
                  {/* OpenAI API key — Eye/EyeOff idiom copied from the Gemini field */}
                  <div>
                    <label htmlFor="openaiApiKey" className="text-sm font-medium">OpenAI API Key</label>
                    <div className="relative mt-1">
                      <Input
                        id="openaiApiKey"
                        type={showOpenaiKey ? 'text' : 'password'}
                        placeholder="Enter your OpenAI API key (sk-...)"
                        value={openaiApiKey}
                        onChange={(e) => setOpenaiApiKey(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveTranscription()}
                        disabled={saving}
                        aria-label="OpenAI API Key"
                        aria-describedby="openaiApiKey-description"
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                        onClick={() => setShowOpenaiKey(!showOpenaiKey)}
                        aria-label={showOpenaiKey ? 'Hide OpenAI API key' : 'Show OpenAI API key'}
                        tabIndex={-1}
                      >
                        {showOpenaiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p id="openaiApiKey-description" className="text-xs text-muted-foreground mt-1">
                      Get your API key from{' '}
                      <a
                        href="https://platform.openai.com/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        OpenAI Platform
                      </a>
                    </p>
                  </div>
                  <div>
                    <label htmlFor="whisperModel" className="text-sm font-medium">Transcription Model</label>
                    <select id="whisperModel" value="whisper-1" disabled aria-label="Whisper Model"
                      className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm opacity-70">
                      <option value="whisper-1">whisper-1 (only supported model in v1)</option>
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">
                      gpt-4o-transcribe is not supported yet (25-minute duration cap).
                    </p>
                  </div>
                </>
              )}

              {asrProvider === 'assemblyai' && (
                <div>
                  <label htmlFor="assemblyaiApiKey" className="text-sm font-medium">AssemblyAI API Key</label>
                  <div className="relative mt-1">
                    <Input
                      id="assemblyaiApiKey"
                      type={showAssemblyaiKey ? 'text' : 'password'}
                      placeholder="Enter your AssemblyAI API key"
                      value={assemblyaiApiKey}
                      onChange={(e) => setAssemblyaiApiKey(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveTranscription()}
                      disabled={saving}
                      aria-label="AssemblyAI API Key"
                      aria-describedby="assemblyaiApiKey-description"
                      className="pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                      onClick={() => setShowAssemblyaiKey(!showAssemblyaiKey)}
                      aria-label={showAssemblyaiKey ? 'Hide AssemblyAI API key' : 'Show AssemblyAI API key'}
                      tabIndex={-1}
                    >
                      {showAssemblyaiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p id="assemblyaiApiKey-description" className="text-xs text-muted-foreground mt-1">
                    Get your API key from{' '}
                    <a
                      href="https://www.assemblyai.com/dashboard"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      AssemblyAI Dashboard
                    </a>
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="transcriptionLanguage" className="text-sm font-medium">Language</label>
                <select
                  id="transcriptionLanguage"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveTranscription()}
                  disabled={saving}
                  aria-label="Transcription Language"
                  aria-describedby="transcriptionLanguage-description"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                >
                  {TRANSCRIPTION_LANGUAGES.map((lang) => (
                    <option key={lang.value} value={lang.value}>
                      {lang.label}
                    </option>
                  ))}
                </select>
                <p id="transcriptionLanguage-description" className="text-xs text-muted-foreground mt-1">
                  Force the spoken language, or choose Auto-detect to let the provider decide
                </p>
              </div>

              <Button
                onClick={handleSaveTranscription}
                disabled={saving || !isTranscriptionDirty}
                aria-label="Save transcription settings"
              >
                <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                {isTranscriptionDirty ? 'Save' : 'Saved'}
              </Button>
            </CardContent>
          </Card>

          {/* Summarization Settings (spec §5.6) */}
          <Card>
            <CardHeader>
              <CardTitle>Summarization</CardTitle>
              <CardDescription>Configure the LLM used to summarize transcripts</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Provider toggle — Button-group idiom */}
              <div>
                <label id="sumProvider-label" className="text-sm font-medium">Summarization Provider</label>
                <div className="flex gap-2 mt-2" role="group" aria-labelledby="sumProvider-label">
                  <Button
                    variant={sumProvider === 'gemini' ? 'default' : 'outline'}
                    onClick={() => setSumProvider('gemini')}
                    onKeyDown={(e) => e.key === 'Enter' && setSumProvider('gemini')}
                    disabled={saving}
                    aria-label="Use Gemini summarization provider"
                    aria-pressed={sumProvider === 'gemini'}
                  >
                    Gemini
                  </Button>
                  <Button
                    variant={sumProvider === 'ollama-cloud' ? 'default' : 'outline'}
                    onClick={() => setSumProvider('ollama-cloud')}
                    onKeyDown={(e) => e.key === 'Enter' && setSumProvider('ollama-cloud')}
                    disabled={saving}
                    aria-label="Use Ollama Cloud summarization provider"
                    aria-pressed={sumProvider === 'ollama-cloud'}
                  >
                    Ollama Cloud
                  </Button>
                </div>
              </div>

              {sumProvider === 'ollama-cloud' && (
                <>
                  {/* Ollama Cloud API key — Eye/EyeOff idiom */}
                  <div>
                    <label htmlFor="ollamaCloudApiKey" className="text-sm font-medium">Ollama Cloud API Key</label>
                    <div className="relative mt-1">
                      <Input
                        id="ollamaCloudApiKey"
                        type={showOllamaKey ? 'text' : 'password'}
                        placeholder="Enter your Ollama Cloud API key"
                        value={ollamaCloudApiKey}
                        onChange={(e) => setOllamaCloudApiKey(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveSummarization()}
                        disabled={saving}
                        aria-label="Ollama Cloud API Key"
                        aria-describedby="ollamaCloudApiKey-description"
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                        onClick={() => setShowOllamaKey(!showOllamaKey)}
                        aria-label={showOllamaKey ? 'Hide Ollama Cloud API key' : 'Show Ollama Cloud API key'}
                        tabIndex={-1}
                      >
                        {showOllamaKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p id="ollamaCloudApiKey-description" className="text-xs text-muted-foreground mt-1">
                      Get your API key from{' '}
                      <a
                        href="https://ollama.com/settings/keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        ollama.com/settings/keys
                      </a>
                    </p>
                  </div>

                  {/* Model picker — text input + "Fetch models" button; select renders when models are available */}
                  <div>
                    <label htmlFor="ollamaCloudModel" className="text-sm font-medium">Ollama Cloud Model</label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        id="ollamaCloudModel"
                        type="text"
                        placeholder="e.g. gpt-oss:120b, deepseek-v3.1:671b"
                        value={ollamaCloudModel}
                        onChange={(e) => setOllamaCloudModel(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveSummarization()}
                        disabled={saving}
                        aria-label="Ollama Cloud Model"
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleFetchModels}
                        disabled={saving || fetchingModels || !ollamaCloudApiKey.trim()}
                        aria-label="Fetch available Ollama Cloud models"
                      >
                        {fetchingModels ? <RefreshCw className="h-4 w-4 animate-spin" /> : 'Fetch models'}
                      </Button>
                    </div>
                    {ollamaModels.length > 0 && (
                      <select
                        className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={ollamaCloudModel}
                        onChange={(e) => setOllamaCloudModel(e.target.value)}
                        aria-label="Select Ollama Cloud model from list"
                      >
                        <option value="">— select a model —</option>
                        {ollamaModels.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      Manual text input works as a fallback even without fetching the list
                    </p>
                  </div>

                  {/* Test connection button */}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleTestConnection}
                    disabled={saving || !ollamaCloudApiKey.trim() || !ollamaCloudModel.trim()}
                    aria-label="Test Ollama Cloud connection"
                  >
                    Test
                  </Button>
                </>
              )}

              <Button
                onClick={handleSaveSummarization}
                disabled={saving || !isSummarizationDirty}
                aria-label="Save summarization settings"
              >
                <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                {isSummarizationDirty ? 'Save' : 'Saved'}
              </Button>
            </CardContent>
          </Card>

          {/* Chat Settings */}
          <Card>
            <CardHeader>
              <CardTitle>Chat / RAG</CardTitle>
              <CardDescription>Configure chat provider for querying meetings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label id="chatProvider-label" className="text-sm font-medium">Chat Provider</label>
                <div className="flex gap-2 mt-2" role="group" aria-labelledby="chatProvider-label">
                  <Button
                    variant={chatProvider === 'gemini' ? 'default' : 'outline'}
                    onClick={() => setChatProvider('gemini')}
                    onKeyDown={(e) => e.key === 'Enter' && setChatProvider('gemini')}
                    disabled={saving}
                    aria-label="Use Gemini chat provider"
                    aria-pressed={chatProvider === 'gemini'}
                  >
                    Gemini
                  </Button>
                  <Button
                    variant={chatProvider === 'ollama' ? 'default' : 'outline'}
                    onClick={() => setChatProvider('ollama')}
                    onKeyDown={(e) => e.key === 'Enter' && setChatProvider('ollama')}
                    disabled={saving}
                    aria-label="Use Ollama local chat provider"
                    aria-pressed={chatProvider === 'ollama'}
                  >
                    Ollama (Local)
                  </Button>
                  <Button
                    variant={chatProvider === 'ollama-cloud' ? 'default' : 'outline'}
                    onClick={() => setChatProvider('ollama-cloud')}
                    onKeyDown={(e) => e.key === 'Enter' && setChatProvider('ollama-cloud')}
                    disabled={saving}
                    aria-label="Use Ollama Cloud chat provider"
                    aria-pressed={chatProvider === 'ollama-cloud'}
                  >
                    Ollama Cloud
                  </Button>
                </div>
              </div>

              {chatProvider === 'ollama-cloud' && (
                <p className="text-xs text-muted-foreground rounded-md border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 p-2">
                  Uses the Ollama Cloud API key and model configured in the Summarization section below.
                </p>
              )}

              {chatProvider === 'ollama' && (
                <div>
                  <label htmlFor="ollamaUrl" className="text-sm font-medium">Ollama URL</label>
                  <Input
                    id="ollamaUrl"
                    type="url"
                    placeholder="http://localhost:11434"
                    value={ollamaUrl}
                    onChange={(e) => setOllamaUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveChat()}
                    disabled={saving}
                    aria-label="Ollama base URL"
                    aria-describedby="ollamaUrl-description"
                    className="mt-1"
                  />
                  <p id="ollamaUrl-description" className="text-xs text-muted-foreground mt-1">
                    URL of your local Ollama server
                  </p>
                </div>
              )}

              {/* C-CHAT: RAG Context Window Size */}
              <div>
                <label htmlFor="ragContextSize" className="text-sm font-medium">
                  RAG Context Window
                </label>
                <Input
                  id="ragContextSize"
                  type="number"
                  min={1}
                  max={20}
                  value={ragContextSize}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val)) {
                      setRagContextSize(Math.min(20, Math.max(1, val)))
                    }
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveChat()}
                  disabled={saving}
                  aria-label="RAG context window size"
                  aria-describedby="ragContextSize-description"
                  className="mt-1"
                />
                <p id="ragContextSize-description" className="text-xs text-muted-foreground mt-1">
                  Number of knowledge chunks to retrieve for context (1-20). Default: 10
                </p>
              </div>

              <Button
                onClick={handleSaveChat}
                disabled={saving || !isChatDirty}
                aria-label="Save chat settings"
              >
                <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                {isChatDirty ? 'Save' : 'Saved'}
              </Button>
            </CardContent>
          </Card>

          {/* Privacy / Voice Library */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Privacy
              </CardTitle>
              <CardDescription>Voiceprint capture and backup settings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="enableVoiceprintCapture"
                  checked={enableVoiceprintCapture}
                  onChange={(e) => handleToggleVoiceprintCapture(e.target.checked)}
                  disabled={saving || clearingVoiceprints}
                  className="mt-1 rounded"
                />
                <div className="flex-1">
                  <label htmlFor="enableVoiceprintCapture" className="text-sm font-medium">
                    Capture voiceprints
                  </label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Remember voices from speaker assignments to recognize people later. Voiceprints are local-only biometric data.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="excludeVoiceprintsFromBackup"
                  checked={excludeVoiceprintsFromBackup}
                  onChange={(e) => handleToggleExcludeFromBackup(e.target.checked)}
                  disabled={saving || clearingVoiceprints}
                  className="mt-1 rounded"
                />
                <div className="flex-1">
                  <label htmlFor="excludeVoiceprintsFromBackup" className="text-sm font-medium">
                    Exclude voiceprints from backups & sync
                  </label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Honored when backup/sync ships. Default on so biometric data stays off sync channels.
                  </p>
                </div>
              </div>

              <div className="pt-2 border-t">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setClearAllDialogOpen(true)}
                  disabled={clearingVoiceprints}
                  className="gap-2"
                >
                  <Trash2 className="h-4 w-4" />
                  Clear all voiceprints
                </Button>
              </div>
            </CardContent>
          </Card>

          <AlertDialog open={clearAllDialogOpen} onOpenChange={setClearAllDialogOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear all voiceprints?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes every stored voiceprint. It cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={clearingVoiceprints}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={handleClearAllVoiceprints}
                  disabled={clearingVoiceprints}
                >
                  {clearingVoiceprints ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Clearing...
                    </>
                  ) : (
                    'Clear all'
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Storage */}
          <Card>
            <CardHeader>
              <CardTitle>Storage</CardTitle>
              <CardDescription>Local data storage information</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Storage loading indicator */}
              {storageLoading && !storageInfo && (
                <div className="flex items-center gap-2 py-4 justify-center">
                  <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Loading storage info...</span>
                </div>
              )}
              {/* B-SET-002: Storage error with retry button */}
              {storageError && (
                <div className="flex items-center gap-3 p-3 rounded-md bg-destructive/10 text-destructive border border-destructive/20">
                  <AlertCircle className="h-5 w-5 flex-shrink-0" />
                  <div className="flex-1 text-sm">{storageError}</div>
                  <Button variant="outline" size="sm" onClick={loadStorageInfo}>
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Retry
                  </Button>
                </div>
              )}
              {storageInfo && (
                <>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Total Size</p>
                      <p className="font-medium">{formatBytes(storageInfo.totalSizeBytes)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Recordings</p>
                      <p className="font-medium">{storageInfo.recordingsCount} files</p>
                    </div>
                  </div>

                  <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                      <div className="flex-1 min-w-0">
                        <p className="text-muted-foreground text-xs">Recordings</p>
                        <p className="font-mono text-xs truncate" title={storageInfo.recordingsPath}>
                          {storageInfo.recordingsPath}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleOpenFolder('recordings')}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                      <div className="flex-1 min-w-0">
                        <p className="text-muted-foreground text-xs">Transcripts</p>
                        <p className="font-mono text-xs truncate" title={storageInfo.transcriptsPath}>
                          {storageInfo.transcriptsPath}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleOpenFolder('transcripts')}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                      <div className="flex-1 min-w-0">
                        <p className="text-muted-foreground text-xs">Data</p>
                        <p className="font-mono text-xs truncate" title={storageInfo.dataPath}>
                          {storageInfo.dataPath}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleOpenFolder('data')}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Health Check & Advanced Operations */}
          <HealthCheck />
        </div>
      </div>
    </div>
  )
}

export default Settings
