/**
 * types.ts — ElectronAPI interface + all inline aliases lifted from electron/preload/index.ts.
 *
 * Every method signature is byte-identical to the preload; only import paths are adjusted
 * to renderer-relative paths so the renderer's 41 files continue to typecheck against this.
 *
 * DO NOT change any method signature — the renderer's call sites are the spec.
 */

// Re-export all API types from the main-process types module (accessible to the renderer via
// tsconfig.web.json's include pattern `electron/main/types/*.ts`).
import type {
  Result,
  RAGChatRequest,
  RAGChatResponse,
  RAGStatus,
  GetContactsRequest,
  GetContactsResponse,
  UpdateContactRequest,
  GetProjectsRequest,
  GetProjectsResponse,
  CreateProjectRequest,
  UpdateProjectRequest,
  TagMeetingRequest,
  OutputTemplate,
  GenerateOutputRequest,
  GenerateOutputResponse,
} from '../../../electron/main/types/api'

import type { Contact, ContactWithMeetings, Project, ProjectWithMeetings, VoiceprintSummary } from '../../../electron/main/types/database'
import type { Person } from '../../types/knowledge'
import type { MigrationAPI } from '../../../electron/preload/migration-types'
import type {
  KnowledgeCapture,
  Actionable,
  Conversation,
  Message,
} from '../../types/knowledge'
import type { DeviceFileSource, SyncFinalizeResponse, SyncProgress } from './types-device-sync'

// Re-export imported types so consumers of this module get a single import point.
export type {
  Result,
  RAGChatRequest,
  RAGChatResponse,
  RAGStatus,
  GetContactsRequest,
  GetContactsResponse,
  UpdateContactRequest,
  GetProjectsRequest,
  GetProjectsResponse,
  CreateProjectRequest,
  UpdateProjectRequest,
  TagMeetingRequest,
  OutputTemplate,
  GenerateOutputRequest,
  GenerateOutputResponse,
  Contact,
  ContactWithMeetings,
  Project,
  ProjectWithMeetings,
  VoiceprintSummary,
  Person,
  MigrationAPI,
  KnowledgeCapture,
  Actionable,
  Conversation,
  Message,
}

// ---------------------------------------------------------------------------
// Inline type aliases (inlined in preload to avoid tsconfig.web.json scope issues)
// ---------------------------------------------------------------------------

/** Suggestion chip returned by speakers:getSuggestions. */
export interface SuggestionView {
  id: string
  kind: 'identity' | 'merge' | 'mixed'
  targetLabel: string
  targetLabel2?: string | null
  contactId?: string | null
  contactName?: string | null
  contactName2?: string | null
  score: number | null
  rank: number | null
  rationale: string | null
  requiresWarning: boolean
}

/** Mirror of the main-process DiarizationRun row (Voice Library Phase 2C). */
export interface DiarizationRun {
  id: string
  recording_id: string
  transcript_id?: string
  provider: string
  model?: string
  options_min?: number
  options_max?: number
  options_sent_json?: string
  label_count: number
  is_solo: number
  solo_reason?: string
  failure_reason?: string
  duration_ms?: number
  policy_version?: number
  created_at: string
}

/** Mirror of SummarizationTemplate from main-process service (inlined to avoid tsconfig.web.json scope). */
export interface SummarizationTemplate {
  id: string
  name: string
  description: string
  instructions: string
  exampleTriggers: string[]
  isDefault: boolean
  isBuiltin: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** Mirror of TemplateInput from main-process service (inlined to avoid tsconfig.web.json scope). */
export interface TemplateInput {
  name: string
  description?: string
  instructions: string
  exampleTriggers?: string[]
  isDefault?: boolean
  enabled?: boolean
}

/** Phase 3: reader chip + banner payload (inlined to avoid tsconfig.web.json scope). */
export interface LatestRunView {
  /** Denormalized template name from the transcript row, or null. */
  name: string | null
  /** Selector confidence (0–1), or null when no run exists. */
  confidence: number | null
  /** Selection kind: 'applied' | 'suggest_new' | 'none' | …, or null when no run. */
  kind: string | null
  /** Parsed suggest-new payload when kind === 'suggest_new', else null. */
  suggestedTemplate: Record<string, unknown> | null
  /** True when the template's instructions changed since this summary was generated. */
  instructionsChanged: boolean
}

/** Phase 4: read-only selector dry-run result (inlined to avoid tsconfig.web.json scope). */
export interface PreviewSelectionResult {
  kind: 'selected' | 'suggest_new' | 'use_default' | 'manual'
  templateId?: string
  confidence: number
  reason: string
  suggestedTemplate?: {
    name: string
    description: string
    instructions: string
    exampleTriggers: string[]
  }
  elapsedMs: number
}

/** Phase 4: editable fields for acceptSuggestedTemplate (inlined to avoid tsconfig.web.json scope). */
export interface SuggestedTemplateEdits {
  name?: string
  description?: string
  instructions?: string
  exampleTriggers?: string[]
}

// ---------------------------------------------------------------------------
// ElectronAPI — the full interface, byte-identical to electron/preload/index.ts.
// ---------------------------------------------------------------------------

export interface ElectronAPI {
  // App
  app: {
    restart: () => Promise<void>
    info: () => Promise<{
      version: string
      name: string
      isPackaged: boolean
      platform: string
    }>
  }

  // Config
  config: {
    get: () => Promise<any>
    set: (config: any) => Promise<any>
    updateSection: (section: string, values: any) => Promise<any>
    getValue: (key: string) => Promise<any>
  }

  // Summarization provider API (main-process fetch — renderer can't call cross-origin)
  summarization: {
    listModels: (apiKey?: string) => Promise<{ success: boolean; models?: string[]; error?: string }>
    testConnection: (apiKey?: string, model?: string) => Promise<{ success: boolean; error?: string }>
  }

  // Database - Meetings
  meetings: {
    getAll: (startDate?: string, endDate?: string) => Promise<any[]>
    getById: (id: string) => Promise<any>
    getByIds: (ids: string[]) => Promise<Record<string, any>>
    getDetails: (id: string) => Promise<any>
    update: (request: { id: string; subject?: string; start_time?: string; end_time?: string; location?: string | null; description?: string | null }) => Promise<Result<any>>
  }

  // Contacts
  contacts: {
    getAll: (request?: GetContactsRequest) => Promise<Result<GetContactsResponse>>
    getById: (id: string) => Promise<Result<ContactWithMeetings>>
    create: (request: { name: string; email?: string | null; type?: string; role?: string | null; company?: string | null }) => Promise<Result<Person>>
    update: (request: UpdateContactRequest) => Promise<Result<Contact>>
    delete: (id: string) => Promise<Result<void>>
    getForMeeting: (meetingId: string) => Promise<Result<Contact[]>>
    setSelf: (request: { contactId: string | null }) => Promise<Result<Person | null>>
    getSelf: () => Promise<Result<Person | null>>
  }

  // Voiceprints (speaker identity library)
  voiceprints: {
    listForContact: (contactId: string) => Promise<Result<VoiceprintSummary[]>>
    disable: (id: string) => Promise<Result<void>>
    enable: (id: string) => Promise<Result<void>>
    delete: (id: string) => Promise<Result<void>>
    clearAllForContact: (contactId: string) => Promise<Result<{ deleted: number }>>
    clearAll: () => Promise<Result<{ deleted: number }>>
    findBySource: (recordingId: string, fileLabel: string, contactId?: string) => Promise<Result<VoiceprintSummary[]>>
  }

  // Speakers (diarization — D3)
  speakers: {
    assign: (request: { recordingId: string; fileLabel: string; contactId: string; source?: 'user' | 'confirmed' | 'suggestion_confirmed' }) => Promise<Result<{ recordingId: string; fileLabel: string; contactId: string }>>
    merge: (request: { recordingId: string; fromLabel: string; toLabel: string }) => Promise<Result<{ recordingId: string; fromLabel: string; toLabel: string }>>
    unassign: (request: { recordingId: string; fileLabel: string }) => Promise<Result<void>>
    getForRecording: (recordingId: string) => Promise<Result<Record<string, { contactId: string; contactName: string }>>>
    getSuggestions: (recordingId: string) => Promise<Result<SuggestionView[]>>
    reassignTurns: (request: { recordingId: string; sourceLabel: string; anchorIndex: number; anchorStartMs: number; scope: 'one' | 'before' | 'after'; target: { kind: 'existingLabel'; label: string } | { kind: 'contact'; contactId: string } | { kind: 'newSpeaker' } }) => Promise<Result<{ recordingId: string; targetLabel: string; rewrittenCount: number }>>
    dismissSuggestion: (id: string) => Promise<Result<{ id: string }>>
    acceptSuggestion: (id: string) => Promise<Result<{ id: string }>>
    setSelf: (request: { recordingId: string; fileLabel: string }) => Promise<Result<{ selfAssigned: boolean; needsSelfContact?: boolean; contactId?: string }>>
  }

  // Diarization-run instrumentation (Voice Library Phase 2C)
  diarization: {
    getLatestRun: (recordingId: string) => Promise<Result<DiarizationRun | null>>
    getRunsForRecording: (recordingId: string) => Promise<Result<DiarizationRun[]>>
  }

  // Summarization Templates — CRUD (Phase 2) + latestRun reader chip (Phase 3)
  // + resummarizeWithTemplate single-shot override + previewSelection + acceptSuggestedTemplate (Phase 4).
  summarizationTemplates: {
    list: () => Promise<Result<SummarizationTemplate[]>>
    create: (template: TemplateInput) => Promise<Result<SummarizationTemplate>>
    update: (id: string, patch: Partial<TemplateInput>) => Promise<Result<SummarizationTemplate>>
    setEnabled: (id: string, enabled: boolean) => Promise<Result<true>>
    delete: (id: string) => Promise<Result<true>>
    /** Phase 3: provenance for the reader chip + banner. */
    latestRun: (recordingId: string) => Promise<Result<LatestRunView>>
    resummarizeWithTemplate: (recordingId: string, templateId: string | null) => Promise<{ success: boolean; error?: string }>
    previewSelection: (recordingId: string) => Promise<Result<PreviewSelectionResult>>
    acceptSuggestedTemplate: (recordingId: string, edits?: SuggestedTemplateEdits) => Promise<Result<SummarizationTemplate>>
  }

  // Projects
  projects: {
    getAll: (request?: GetProjectsRequest & { status?: string }) => Promise<Result<GetProjectsResponse>>
    getById: (id: string) => Promise<Result<ProjectWithMeetings>>
    create: (request: CreateProjectRequest) => Promise<Result<Project>>
    update: (request: UpdateProjectRequest) => Promise<Result<Project>>
    delete: (id: string) => Promise<Result<void>>
    tagMeeting: (request: TagMeetingRequest) => Promise<Result<void>>
    untagMeeting: (request: TagMeetingRequest) => Promise<Result<void>>
    getForMeeting: (meetingId: string) => Promise<Result<Project[]>>
  }

  // Database - Recordings
  recordings: {
    getAll: () => Promise<any[]>
    getById: (id: string) => Promise<any>
    getForMeeting: (meetingId: string) => Promise<any[]>
    updateStatus: (id: string, status: string) => Promise<any>
    updateRecordingStatus: (id: string, status: string) => Promise<{ success: boolean; data?: any; error?: string }>
    updateTranscriptionStatus: (id: string, status: string) => Promise<{ success: boolean; data?: any; error?: string }>
    linkToMeeting: (recordingId: string, meetingId: string, confidence: number, method: string) => Promise<any>
    delete: (id: string) => Promise<boolean>
    deleteBatch: (ids: string[]) => Promise<{
      success: boolean
      deleted: number
      failed: number
      errors: Array<{ id: string; error: string }>
    }>
    getCandidates: (recordingId: string) => Promise<{ success: boolean; data: any[]; error?: string }>
    getMeetingsNearDate: (date: string) => Promise<{ success: boolean; data: any[]; error?: string }>
    selectMeeting: (recordingId: string, meetingId: string | null) => Promise<{ success: boolean; error?: string }>
    addExternal: () => Promise<{ success: boolean; recording?: any; error?: string }>
    addExternalByPath: (filePath: string) => Promise<{ success: boolean; recording?: any; error?: string }>
    transcribe: (recordingId: string) => Promise<string | false>
    addToQueue: (recordingId: string) => Promise<string | false>
    processQueue: () => Promise<boolean>
    getTranscriptionStatus: () => Promise<{ isProcessing: boolean; pendingCount: number; processingCount: number }>
    getTranscriptionQueue: () => Promise<any[]>
    cancelTranscription: (recordingId: string) => Promise<{ success: boolean }>
    cancelAllTranscriptions: () => Promise<{ success: boolean; count: number }>
    updateQueueItem: (id: string, status: string, errorMessage?: string) => Promise<boolean>
    validateTranscriptionConfig: () => Promise<{ ok: boolean; problems: Array<{ stage: string; provider: string; problem: string }> }>
    resummarize: (recordingId: string) => Promise<{ success: boolean; error?: string }>
    isSummaryStale: (recordingId: string) => Promise<boolean>
    /** P4: Re-pend all provider-terminal failures (spec §7.3). */
    retryAllFailed: () => Promise<{ success: boolean; count: number }>
    /** Task 5b: Paginated variant for the virtualized Library — returns {items,total}. */
    getPage: (opts: { limit?: number; offset?: number; status?: string }) => Promise<{ items: any[]; total: number }>
  }

  // Database - Transcripts
  transcripts: {
    getByRecordingId: (recordingId: string) => Promise<any>
    getByRecordingIds: (recordingIds: string[]) => Promise<Record<string, any>>
    search: (query: string) => Promise<any[]>
    updateTurns: (request: { recordingId: string; turns: unknown[] }) => Promise<Result<{ recordingId: string }>>
    export: (recordingId: string, format: 'csv' | 'srt' | 'json') => Promise<Result<string | null>>
  }

  // Database - Queue
  queue: {
    getItems: (status?: string) => Promise<any[]>
  }

  // Knowledge Captures
  knowledge: {
    getAll: (options?: { limit?: number; offset?: number; status?: string; quality?: string; category?: string }) => Promise<KnowledgeCapture[]>
    getById: (id: string) => Promise<KnowledgeCapture | null>
    getByIds: (ids: string[]) => Promise<KnowledgeCapture[]>
    update: (id: string, updates: Partial<KnowledgeCapture>) => Promise<{ success: boolean; error?: string }>
  }

  // Actionables
  actionables: {
    getAll: (options?: { status?: string }) => Promise<Actionable[]>
    getByMeeting: (meetingId: string) => Promise<Actionable[]>
    updateStatus: (id: string, status: string) => Promise<{ success: boolean; error?: string }>
    generateOutput: (actionableId: string) => Promise<{ success: boolean; error?: string; data?: any }>
  }

  // Assistant
  assistant: {
    getConversations: () => Promise<Conversation[]>
    createConversation: (title?: string) => Promise<Conversation>
    deleteConversation: (id: string) => Promise<{ success: boolean; error?: string }>
    getMessages: (conversationId: string) => Promise<Message[]>
    addMessage: (conversationId: string, role: 'user' | 'assistant', content: string, sources?: string) => Promise<Message>
    updateConversationTitle: (conversationId: string, title: string) => Promise<{ success: boolean; error?: string }>
    addContext: (conversationId: string, knowledgeCaptureId: string) => Promise<{ success: boolean; error?: string }>
    removeContext: (conversationId: string, knowledgeCaptureId: string) => Promise<{ success: boolean; error?: string }>
    getContext: (conversationId: string) => Promise<string[]>
  }

  // Chat
  chat: {
    getHistory: (limit?: number) => Promise<any[]>
    addMessage: (role: 'user' | 'assistant', content: string, sources?: string) => Promise<any>
    clearHistory: () => Promise<boolean>
  }

  // Calendar
  calendar: {
    sync: () => Promise<any>
    clearAndSync: () => Promise<any>
    getLastSync: () => Promise<string | null>
    setUrl: (url: string) => Promise<any>
    toggleAutoSync: (enabled: boolean) => Promise<any>
    setInterval: (minutes: number) => Promise<any>
    getSettings: () => Promise<any>
  }

  // Storage
  storage: {
    getInfo: () => Promise<any>
    openFolder: (folder: 'recordings' | 'transcripts' | 'data') => Promise<boolean>
    openFile: (filePath: string) => Promise<{ success: boolean; error?: string }>
    revealInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>
    readRecording: (filePath: string) => Promise<{ success: boolean; data?: string; error?: string }>
    deleteRecording: (filePath: string) => Promise<boolean>
    saveRecording: (filename: string, data: number[], recordingDateIso?: string) => Promise<string>
  }

  // Synced files - tracking which device files have been downloaded
  syncedFiles: {
    isFileSynced: (originalFilename: string) => Promise<boolean>
    getSyncedFile: (originalFilename: string) => Promise<{
      id: string
      original_filename: string
      local_filename: string
      file_path: string
      file_size?: number
      synced_at: string
    } | undefined>
    getAll: () => Promise<Array<{
      id: string
      original_filename: string
      local_filename: string
      file_path: string
      file_size?: number
      synced_at: string
    }>>
    add: (originalFilename: string, localFilename: string, filePath: string, fileSize?: number) => Promise<string>
    remove: (originalFilename: string) => Promise<boolean>
    getFilenames: () => Promise<string[]>
  }

  // Outputs - document generation
  outputs: {
    getTemplates: () => Promise<Result<OutputTemplate[]>>
    generate: (request: GenerateOutputRequest) => Promise<Result<GenerateOutputResponse>>
    getByActionableId: (actionableId: string) => Promise<Result<GenerateOutputResponse | null>>
    copyToClipboard: (content: string) => Promise<Result<void>>
    saveToFile: (content: string, suggestedName?: string) => Promise<Result<string>>
  }

  // RAG Chatbot (extended with Result pattern)
  rag: {
    status: () => Promise<Result<RAGStatus>>
    chat: (request: RAGChatRequest) => Promise<Result<RAGChatResponse>>
    chatLegacy: (sessionId: string, message: string, meetingFilter?: string) => Promise<{
      answer: string
      sources: Array<{
        content: string
        meetingId?: string
        subject?: string
        timestamp?: string
        score: number
      }>
      error?: string
    }>
    summarizeMeeting: (meetingId: string) => Promise<Result<string>>
    findActionItems: (meetingId?: string) => Promise<Result<string>>
    cancel: (sessionId: string) => Promise<Result<boolean>>
    removeLastMessages: (sessionId: string, count: number) => Promise<Result<number>>
    clearSession: (sessionId: string) => Promise<Result<void>>
    stats: () => Promise<{
      documentCount: number
      meetingCount: number
      sessionCount: number
    }>
    indexTranscript: (transcript: string, metadata: {
      meetingId?: string
      recordingId?: string
      timestamp?: string
      subject?: string
    }) => Promise<{ indexed: number }>
    search: (query: string, limit?: number) => Promise<Array<{
      content: string
      meetingId?: string
      subject?: string
      score: number
    }>>
    getChunks: () => Promise<Array<{
      id: string
      content: string
      meetingId?: string
      recordingId?: string
      chunkIndex: number
      subject?: string
      timestamp?: string
      embeddingDimensions: number
    }>>
    globalSearch: (query: string, limit?: number) => Promise<Result<{
      knowledge: any[]
      people: any[]
      projects: any[]
    }>>
  }

  // Download Service - Centralized background download manager
  downloadService: {
    getState: () => Promise<{
      queue: Array<{
        id: string
        filename: string
        fileSize: number
        progress: number
        status: 'pending' | 'downloading' | 'completed' | 'failed' | 'cancelled'
        error?: string
      }>
      session: {
        id: string
        totalFiles: number
        completedFiles: number
        failedFiles: number
        status: 'active' | 'completed' | 'cancelled' | 'failed'
      } | null
      isProcessing: boolean
      isPaused: boolean
    }>
    isFileSynced: (filename: string) => Promise<{ synced: boolean; reason: string }>
    getFilesToSync: (files: Array<{ filename: string; size: number; duration: number; dateCreated: string | Date }>, opts?: { auto?: boolean; deviceSerial?: string }) => Promise<Array<{ filename: string; size: number; duration: number; dateCreated: string | Date; skipReason?: string }>>
    ensureBaseline: (deviceSerial: string, filenames: string[]) => Promise<{ created: boolean }>
    queueDownloads: (files: Array<{ filename: string; size: number; dateCreated?: string }>) => Promise<string[]>
    /** Task 9: builds a streamable device-file source (SEAM 1) for the device sync client. */
    deviceFileSource: (filename: string, size: number) => DeviceFileSource
    startSession: (files: Array<{ filename: string; size: number; dateCreated?: string }>) => Promise<{
      id: string
      totalFiles: number
      completedFiles: number
      failedFiles: number
      status: 'active' | 'completed' | 'cancelled' | 'failed'
    }>
    processDownload: (filename: string, data: number[] | Uint8Array) => Promise<{ success: boolean; filePath?: string; error?: string }>
    updateProgress: (filename: string, bytesReceived: number) => Promise<void>
    markFailed: (filename: string, error: string) => Promise<void>
    clearCompleted: () => Promise<void>
    cancel: (filename: string) => Promise<{ success: boolean; error?: string }>
    cancelAll: () => Promise<void>
    retryFailed: (deviceConnected?: boolean) => Promise<{ count: number; error?: string }>
    getStats: () => Promise<{ totalSynced: number; pendingInQueue: number; failedInQueue: number }>
    checkStalled: () => Promise<number>
    cancelActive: (reason?: string) => Promise<number>
    cancelPendingDownloads: () => Promise<number>
    notifyCompletion: (stats: { completed: number; failed: number; aborted: boolean }) => Promise<void>
    onStateUpdate: (callback: (state: any) => void) => () => void
  }

  // Device Sync Client (Task 12 facade) — streams a DeviceFileSource to the hosted-hub server.
  deviceSync: {
    syncFile: (src: DeviceFileSource, onProgress?: (p: SyncProgress) => void) => Promise<SyncFinalizeResponse>
  }

  // Device Cache - Caches device file listings for offline access
  deviceCache: {
    getAll: () => Promise<any[]>
    saveAll: (files: any[]) => Promise<void>
    clear: () => Promise<void>
  }

  // Quality Assessment API
  quality: {
    get: (recordingId: string) => Promise<any>
    set: (recordingId: string, quality: 'high' | 'medium' | 'low', reason?: string, assessedBy?: string) => Promise<any>
    autoAssess: (recordingId: string) => Promise<any>
    getByQuality: (quality: 'high' | 'medium' | 'low') => Promise<any>
    batchAutoAssess: (recordingIds: string[]) => Promise<any>
    assessUnassessed: () => Promise<any>
  }

  // Storage Policy API
  storagePolicy: {
    getByTier: (tier: 'hot' | 'warm' | 'cold' | 'archive') => Promise<any>
    getCleanupSuggestions: (minAgeOverride?: Partial<Record<'hot' | 'warm' | 'cold' | 'archive', number>>) => Promise<any>
    getCleanupSuggestionsForTier: (tier: 'hot' | 'warm' | 'cold' | 'archive', minAgeDays?: number) => Promise<any>
    executeCleanup: (recordingIds: string[], archive?: boolean) => Promise<any>
    getStats: () => Promise<any>
    initializeUntiered: () => Promise<any>
    assignTier: (recordingId: string, quality: 'high' | 'medium' | 'low') => Promise<any>
  }

  // Data Integrity Service - Health checks and repairs
  integrity: {
    runScan: () => Promise<{
      scanStarted: string
      scanCompleted: string
      totalIssues: number
      issuesByType: Record<string, number>
      issuesBySeverity: Record<string, number>
      issues: Array<{
        id: string
        type: string
        severity: 'low' | 'medium' | 'high'
        description: string
        filePath?: string
        filename?: string
        recordingId?: string
        suggestedAction: string
        autoRepairable: boolean
        details?: Record<string, unknown>
      }>
      autoRepairableCount: number
    }>
    getReport: () => Promise<any>
    repairIssue: (issueId: string) => Promise<{
      issueId: string
      success: boolean
      action: string
      error?: string
    }>
    repairAll: () => Promise<Array<{
      issueId: string
      success: boolean
      action: string
      error?: string
    }>>
    runStartupChecks: () => Promise<{ issuesFound: number; issuesFixed: number }>
    cleanupWronglyNamed: () => Promise<{
      deletedFiles: string[]
      keptFiles: string[]
      clearedDbRecords: number
    }>
    purgeMissingFiles: () => Promise<{
      totalRecords: number
      deleted: number
      kept: number
      deletedFiles: string[]
    }>
    onProgress: (callback: (progress: { message: string; progress: number }) => void) => () => void
  }

  // Migration - Database schema migration to V11 (Knowledge Captures)
  migration: MigrationAPI

  // Jensen Device API — IPC bridge to main-process JensenDevice singleton
  jensen: {
    // Core
    connect: () => Promise<boolean>
    tryConnect: () => Promise<boolean>
    disconnect: () => Promise<void>
    reset: () => Promise<boolean>
    isConnected: () => Promise<boolean>
    getModel: () => Promise<string | null>
    isP1Device: () => Promise<boolean>
    // Device info & settings
    getDeviceInfo: () => Promise<any>
    getCardInfo: () => Promise<any>
    getFileCount: () => Promise<{ count: number } | null>
    getSettings: () => Promise<any>
    setTime: () => Promise<any>
    setAutoRecord: (enabled: boolean) => Promise<any>
    // File operations
    listFiles: () => Promise<any[] | null>
    downloadFile: (filename: string, fileSize: number) => Promise<boolean | null>
    cancelDownload: () => Promise<void>
    deleteFile: (filename: string) => Promise<any>
    formatCard: () => Promise<any>
    // Realtime
    getRealtimeSettings: () => Promise<any>
    startRealtime: () => Promise<any>
    pauseRealtime: () => Promise<any>
    stopRealtime: () => Promise<any>
    getRealtimeData: (offset: number) => Promise<any>
    // Battery & Bluetooth
    getBatteryStatus: () => Promise<any>
    startBluetoothScan: (duration?: number) => Promise<any>
    stopBluetoothScan: () => Promise<any>
    getBluetoothStatus: () => Promise<any>
    // Push event subscriptions
    onStateChanged: (callback: (state: { connected: boolean; model: string | null; serialNumber: string | null; versionCode: string | null; versionNumber: number | null }) => void) => () => void
    onConnect: (callback: () => void) => () => void
    onDisconnect: (callback: () => void) => () => void
    onDownloadProgress: (callback: (data: { filename: string; bytesReceived: number; totalBytes: number }) => void) => () => void
    onDownloadChunk: (callback: (data: { filename: string; data: Uint8Array }) => void) => () => void
    onScanProgress: (callback: (data: { current: number; total: number }) => void) => () => void
  }

  // Domain Events - Event-driven architecture
  onDomainEvent: (callback: (event: any) => void) => () => void

  // Recording Watcher Events
  onRecordingAdded: (callback: (data: { recording: any }) => void) => () => void

  // Transcription Events
  onTranscriptionStarted: (callback: (data: { queueItemId?: string; recordingId: string }) => void) => () => void
  onTranscriptionProgress: (callback: (data: { queueItemId: string; progress: number; stage: string }) => void) => () => void
  onTranscriptionCompleted: (callback: (data: { queueItemId?: string; recordingId: string }) => void) => () => void
  onTranscriptionFailed: (callback: (data: { queueItemId?: string; recordingId: string; error: string }) => void) => () => void
  onTranscriptionCancelled: (callback: (data: { recordingId: string }) => void) => () => void
  onTranscriptionAllCancelled: (callback: (data: { count: number }) => void) => () => void

  // Security Warning Events
  onSecurityWarning: (callback: (data: { type: string; message: string }) => void) => () => void

  // Activity Log bridge — main process services (transcription, calendar, download) emit entries here
  onActivityLogEntry: (callback: (entry: { type: string; message: string; details?: string; timestamp: string }) => void) => () => void

  // Voiceprint capture feedback — emitted after speakers:assign completes a deferred capture
  onVoiceprintCaptured: (callback: (data: {
    recordingId: string
    fileLabel: string
    contactId: string
    captured: boolean
    reason?: string
    cleanSpeechMs?: number
    voiceprintId?: string
    purgedPriorContactId?: string
    purgedCount?: number
  }) => void) => () => void

  // Fired when the hosted-mode WebSocket reopens after a drop — consumers refetch data
  // that may have changed while disconnected. No-op in desktop mode (persistent IPC bridge).
  onConnectionRestored: (callback: () => void) => () => void
}
