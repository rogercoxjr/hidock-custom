import { registerConfigHandlers } from './config-handlers'
import { registerDatabaseHandlers } from './database-handlers'
import { registerCalendarHandlers } from './calendar-handlers'
import { registerStorageHandlers } from './storage-handlers'
import { registerRecordingHandlers } from './recording-handlers'
import { registerRAGHandlers } from './rag-handlers'
import { registerAppHandlers } from './app-handlers'
import { registerContactsHandlers } from './contacts-handlers'
import { registerProjectsHandlers } from './projects-handlers'
import { registerOutputsHandlers } from './outputs-handlers'
import { registerQualityHandlers } from './quality-handlers'
import { registerMigrationHandlers } from './migration-handlers'
import { registerDeviceCacheHandlers } from './device-cache-handlers'
import { registerDownloadServiceHandlers } from '../services/download-service'
import { registerIntegrityHandlers } from './integrity-handlers'
import { registerKnowledgeHandlers } from './knowledge-handlers'
import { registerAssistantHandlers } from './assistant-handlers'
import { registerActionablesHandlers } from './actionables-handlers'
import { registerMeetingsHandlers } from './meetings-handlers'
import { registerJensenHandlers } from './jensen-handlers'
import { registerSummarizationHandlers } from './summarization-handlers'
import { registerSpeakersHandlers } from './speakers-handlers'
import { registerVoiceprintsHandlers } from './voiceprints-handlers'
import { registerDiarizationHandlers } from './diarization-handlers'

export function registerIpcHandlers(): void {
  // Register all IPC handlers
  registerConfigHandlers()
  registerDatabaseHandlers()
  registerCalendarHandlers()
  registerStorageHandlers()
  registerRecordingHandlers()
  registerRAGHandlers()
  registerAppHandlers()
  registerContactsHandlers()
  registerProjectsHandlers()
  registerOutputsHandlers()
  registerQualityHandlers()
  registerMigrationHandlers()
  registerDeviceCacheHandlers()
  registerDownloadServiceHandlers()
  registerIntegrityHandlers()
  registerKnowledgeHandlers()
  registerAssistantHandlers()
  registerActionablesHandlers()
  registerMeetingsHandlers()
  registerJensenHandlers()
  registerSummarizationHandlers()
  registerSpeakersHandlers()
  registerVoiceprintsHandlers()
  registerDiarizationHandlers()

  console.log('All IPC handlers registered')
}
