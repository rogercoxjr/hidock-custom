import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { DEFAULT_SPEAKER_OPTIONS_POLICY } from './asr/speaker-options-policy'
import type { MatchThresholds } from './voiceprint/identity-matcher'

// CS-007: Encrypt sensitive config values (ICS URL, openaiApiKey) at rest using Electron safeStorage
export function encryptSensitive(value: string): string {
  try {
    if (value.startsWith('__enc__')) return value // already encrypted — never double-wrap (spec §5.4)
    if (safeStorage.isEncryptionAvailable() && value) {
      return '__enc__' + safeStorage.encryptString(value).toString('base64')
    }
  } catch { /* fall through to plaintext */ }
  return value
}

function decryptSensitive(value: string): string {
  try {
    if (value.startsWith('__enc__') && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(value.slice(7), 'base64'))
    }
  } catch { /* fall through to return as-is */ }
  return value
}

export interface AppConfig {
  version: string
  storage: {
    dataPath: string
    maxRecordingsGB: number
  }
  calendar: {
    icsUrl: string
    syncEnabled: boolean
    syncIntervalMinutes: number
    lastSyncAt: string | null
  }
  transcription: {
    provider: 'gemini' | 'openai-whisper' | 'assemblyai'
    geminiApiKey: string
    geminiModel: string
    openaiApiKey: string   // safeStorage-encrypted at rest (spec §5.4); decrypted in memory
    whisperModel: string   // fixed 'whisper-1' in v1 (spec §5.1; 4o-transcribe deferred §10)
    assemblyaiApiKey: string   // NEW — safeStorage-encrypted at rest (spec §6.2); decrypted in memory
    assemblyaiModels: string[] // NEW — priority-ordered speech_models (spec §5/§6.2)
    autoTranscribe: boolean
    language: string
    diarization: {
      speakerOptionsEnabled: boolean
      minSpeakers: number
      maxSpeakers: number
      minDurationMsForHint: number
      policyVersion: number
    }
  }
  embeddings: {
    provider: 'ollama' | 'openai'
    ollamaBaseUrl: string
    ollamaModel: string
    openaiModel: string
    chunkSize: number
    chunkOverlap: number
  }
  chat: {
    provider: 'gemini' | 'ollama' | 'ollama-cloud'
    geminiModel: string
    ollamaModel: string
    maxContextChunks: number
  }
  summarization: {
    provider: 'gemini' | 'ollama-cloud'  // default 'gemini' = today's fused behavior (spec §5.4)
    ollamaCloudApiKey: string             // safeStorage-encrypted at rest
    ollamaCloudModel: string              // e.g. 'gpt-oss:120b', 'deepseek-v3.1:671b'
    selectorModel?: string               // cheaper model for template-selector call (optional; '' = use provider default)
  }
  device: {
    autoConnect: boolean
    autoDownload: boolean
  }
  ui: {
    theme: 'light' | 'dark' | 'system'
    defaultView: 'week' | 'month'
    startOfWeek: number
    calendarView: 'day' | 'workweek' | 'week' | 'month'
    hideEmptyMeetings: boolean
    showListView: boolean
  }
  privacy: {
    enableVoiceprintCapture: boolean       // master gate for the whole voice-library feature (spec §14)
    excludeVoiceprintsFromBackup: boolean  // keep biometric prints out of sync/backups by default
  }
  voiceMatching: VoiceMatchingConfig
  // Smart Labels (v1 manual taxonomy) — user-owned category list. Assignment lives in
  // knowledge_captures.category; this is the source of truth for the chip taxonomy/colors.
  labels: {
    items: LabelDefinition[]
  }
}

/** A user-owned category label. `id` is an immutable slug; `name` is editable display. */
export interface LabelDefinition {
  id: string        // immutable slug, e.g. 'meeting' — equals the stored knowledge_captures.category
  name: string      // editable display, e.g. 'Meeting'
  color: string     // Harbor palette token name (see src/features/library/utils/labelPalette.ts)
  builtin?: boolean  // true for the 6 seeds; blocks hard-delete
}

/**
 * The six built-in labels seeded for every user (and back-filled into existing
 * configs via deepMerge). `id`s match the legacy hardcoded CATEGORIES so existing
 * knowledge_captures.category values keep resolving. `color` is a Harbor palette token.
 */
export const BUILTIN_LABELS: LabelDefinition[] = [
  { id: 'meeting', name: 'Meeting', color: 'blue', builtin: true },
  { id: 'interview', name: 'Interview', color: 'teal', builtin: true },
  { id: '1:1', name: '1:1', color: 'green', builtin: true },
  { id: 'brainstorm', name: 'Brainstorm', color: 'amber', builtin: true },
  { id: 'note', name: 'Note', color: 'violet', builtin: true },
  { id: 'other', name: 'Other', color: 'slate', builtin: true }
]

export interface VoiceMatchingConfig extends MatchThresholds {
  modelId: string      // must equal the active VOICEPRINT_MODEL_ID to use these thresholds
  calibrated: boolean  // false until a calibration harness validates the constants
}

const DEFAULT_CONFIG: AppConfig = {
  version: '1.0.0',
  storage: {
    dataPath: join(app.getPath('home'), 'HiDock'),
    maxRecordingsGB: 50
  },
  calendar: {
    icsUrl: '',
    syncEnabled: true,
    syncIntervalMinutes: 15,
    lastSyncAt: null
  },
  transcription: {
    provider: 'assemblyai', // spec §6.2 — diarization is the default ASR; missing key fails LOUD (no silent fallback)
    geminiApiKey: '',
    geminiModel: 'gemini-3-pro-preview', // Best model for audio transcription
    openaiApiKey: '',
    whisperModel: 'whisper-1',
    assemblyaiApiKey: '',
    assemblyaiModels: ['universal-3-pro', 'universal-2'], // PLURAL array; never singular speech_model (spec §5)
    autoTranscribe: true,
    language: 'en',
    diarization: DEFAULT_SPEAKER_OPTIONS_POLICY
  },
  embeddings: {
    provider: 'openai',
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
    openaiModel: 'text-embedding-3-small',
    chunkSize: 500,
    chunkOverlap: 50
  },
  chat: {
    provider: 'gemini',
    geminiModel: 'gemini-2.0-flash',
    ollamaModel: 'llama3.2',
    maxContextChunks: 10
  },
  summarization: {
    provider: 'gemini',
    ollamaCloudApiKey: '',
    ollamaCloudModel: '',
    selectorModel: ''
  },
  device: {
    autoConnect: true,
    autoDownload: true
  },
  ui: {
    theme: 'system',
    defaultView: 'week',
    startOfWeek: 1, // Monday
    calendarView: 'week',
    hideEmptyMeetings: true,
    showListView: false
  },
  privacy: {
    enableVoiceprintCapture: true,
    excludeVoiceprintsFromBackup: true
  },
  voiceMatching: {
    matchSuggest: 0.42,
    matchAuto: 0.55,
    matchMargin: 0.06,
    mergeThreshold: 0.62,
    mixedDispersion: 0.35,
    centroidOutlier: 0.25,
    bankConsistency: 0.35,
    maxMergeSuggestions: 5,
    calibrated: false,
    modelId: '3dspeaker_eres2net_en_voxceleb'
  },
  labels: {
    // Spread copies so the shared BUILTIN_LABELS array is never mutated by config edits.
    items: BUILTIN_LABELS.map((l) => ({ ...l }))
  }
}

let config: AppConfig = { ...DEFAULT_CONFIG }

export function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function getDataPath(): string {
  return config.storage.dataPath
}

export async function initializeConfig(): Promise<void> {
  const configPath = getConfigPath()

  try {
    if (existsSync(configPath)) {
      const fileContent = readFileSync(configPath, 'utf-8')
      const savedConfig = JSON.parse(fileContent)
      // CS-007: Decrypt sensitive fields before loading into memory
      if (savedConfig.calendar?.icsUrl) {
        savedConfig.calendar.icsUrl = decryptSensitive(savedConfig.calendar.icsUrl)
      }
      if (savedConfig.transcription?.openaiApiKey) {
        savedConfig.transcription.openaiApiKey = decryptSensitive(savedConfig.transcription.openaiApiKey)
      }
      if (savedConfig.transcription?.assemblyaiApiKey) {
        savedConfig.transcription.assemblyaiApiKey = decryptSensitive(savedConfig.transcription.assemblyaiApiKey)
      }
      if (savedConfig.summarization?.ollamaCloudApiKey) {
        savedConfig.summarization.ollamaCloudApiKey = decryptSensitive(savedConfig.summarization.ollamaCloudApiKey)
      }
      // Merge with defaults to handle new fields
      config = deepMerge(DEFAULT_CONFIG, savedConfig)
    } else {
      // Create config file with defaults
      await saveConfig(DEFAULT_CONFIG)
    }
  } catch (error) {
    console.error('Error loading config:', error)
    config = { ...DEFAULT_CONFIG }
  }
}

export function getConfig(): AppConfig {
  return { ...config }
}

export async function saveConfig(newConfig: Partial<AppConfig>): Promise<void> {
  config = deepMerge(config, newConfig)

  const configPath = getConfigPath()
  const configDir = join(configPath, '..')

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }

  // CS-007: Encrypt sensitive fields before writing to disk
  const toWrite = {
    ...config,
    calendar: {
      ...config.calendar,
      icsUrl: encryptSensitive(config.calendar.icsUrl)
    },
    transcription: {
      ...config.transcription,
      openaiApiKey: encryptSensitive(config.transcription.openaiApiKey),
      assemblyaiApiKey: encryptSensitive(config.transcription.assemblyaiApiKey)
    },
    summarization: {
      ...config.summarization,
      ollamaCloudApiKey: encryptSensitive(config.summarization.ollamaCloudApiKey)
    }
  }
  writeFileSync(configPath, JSON.stringify(toWrite, null, 2))
}

export async function updateConfig<K extends keyof AppConfig>(
  section: K,
  values: Partial<AppConfig[K]>
): Promise<void> {
  const updatedSection = { ...(config[section] as any), ...values }
  await saveConfig({ [section]: updatedSection } as Partial<AppConfig>)
}

// Deep merge utility
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target }

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key]
      const targetValue = result[key]

      if (
        sourceValue !== null &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(targetValue, sourceValue as Partial<typeof targetValue>)
      } else if (sourceValue !== undefined) {
        result[key] = sourceValue as T[Extract<keyof T, string>]
      }
    }
  }

  return result
}
