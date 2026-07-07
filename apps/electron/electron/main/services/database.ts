import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getDatabasePath } from './file-storage'
import type { Turn } from './asr/asr-provider'

let db: Database.Database | null = null
let dbPath: string = ''

const SCHEMA_VERSION = 34

const SCHEMA = `
-- Calendar events from ICS
CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    location TEXT,
    organizer_name TEXT,
    organizer_email TEXT,
    attendees TEXT,
    description TEXT,
    is_recurring INTEGER DEFAULT 0,
    recurrence_rule TEXT,
    meeting_url TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Recordings from HiDock device
CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_filename TEXT,
    file_path TEXT,
    file_size INTEGER,
    duration_seconds REAL,
    date_recorded TEXT NOT NULL,
    meeting_id TEXT,
    correlation_confidence REAL,
    correlation_method TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    -- Recording lifecycle columns (v6)
    location TEXT DEFAULT 'device-only',
    transcription_status TEXT DEFAULT 'none',
    on_device INTEGER DEFAULT 1,
    device_last_seen TEXT,
    on_local INTEGER DEFAULT 0,
    source TEXT DEFAULT 'hidock',
    is_imported INTEGER DEFAULT 0,
    storage_tier TEXT DEFAULT NULL CHECK(storage_tier IN (NULL, 'hot', 'warm', 'cold', 'archive')),
    -- Migration tracking columns (v11)
    migrated_to_capture_id TEXT,
    migration_status TEXT CHECK(migration_status IN ('pending', 'migrated', 'skipped', 'error')) DEFAULT 'pending',
    migrated_at TEXT,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

-- =============================================================================
-- Core Knowledge Entity (v11)
-- =============================================================================

CREATE TABLE IF NOT EXISTS knowledge_captures (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT,
    -- v31: CHECK dropped so user-defined Smart Labels are storable. The set of valid
    -- categories is now AppConfig.labels.items, validated in the app layer (sole writer).
    category TEXT DEFAULT 'meeting',
    status TEXT CHECK(status IN ('processing', 'ready', 'enriched')) DEFAULT 'ready',

    -- Quality assessment
    quality_rating TEXT CHECK(quality_rating IN ('valuable', 'archived', 'low-value', 'garbage', 'unrated')) DEFAULT 'unrated',
    quality_confidence REAL,
    quality_assessed_at TEXT,

    -- Storage tier and retention
    storage_tier TEXT CHECK(storage_tier IN ('hot', 'cold', 'expiring', 'deleted')) DEFAULT 'hot',
    retention_days INTEGER,
    expires_at TEXT,

    -- Meeting correlation
    meeting_id TEXT,
    correlation_confidence REAL,
    correlation_method TEXT,

    -- Source tracking (migration from recordings)
    source_recording_id TEXT,

    -- Timestamps
    captured_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,

    FOREIGN KEY (meeting_id) REFERENCES meetings(id),
    FOREIGN KEY (source_recording_id) REFERENCES recordings(id)
);

-- =============================================================================
-- Audio Sources - Multi-source tracking (v11)
-- =============================================================================

CREATE TABLE IF NOT EXISTS audio_sources (
    id TEXT PRIMARY KEY,
    knowledge_capture_id TEXT NOT NULL,

    -- Source type and paths
    source_type TEXT CHECK(source_type IN ('device', 'local', 'imported', 'cloud')) NOT NULL,
    device_path TEXT,
    local_path TEXT,
    cloud_url TEXT,

    -- File metadata
    file_name TEXT NOT NULL,
    file_size INTEGER,
    duration_seconds REAL,
    format TEXT,

    -- Sync tracking
    synced_from_device_at TEXT,
    uploaded_to_cloud_at TEXT,

    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (knowledge_capture_id) REFERENCES knowledge_captures(id) ON DELETE CASCADE
);

-- =============================================================================
-- First-Class Action Items (v11)
-- =============================================================================

CREATE TABLE IF NOT EXISTS action_items (
    id TEXT PRIMARY KEY,
    knowledge_capture_id TEXT NOT NULL,

    -- Action item content
    content TEXT NOT NULL,
    assignee TEXT,
    due_date TEXT,

    -- Priority and status
    priority TEXT CHECK(priority IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',
    status TEXT CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled')) DEFAULT 'pending',

    -- Extraction metadata
    extracted_from TEXT,
    confidence REAL,

    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (knowledge_capture_id) REFERENCES knowledge_captures(id) ON DELETE CASCADE
);

-- =============================================================================
-- First-Class Decisions (v11)
-- =============================================================================

CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    knowledge_capture_id TEXT NOT NULL,

    -- Decision content
    content TEXT NOT NULL,
    context TEXT,
    participants TEXT,  -- JSON array of participant names/emails

    -- Extraction metadata
    extracted_from TEXT,
    confidence REAL,
    decided_at TEXT,

    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (knowledge_capture_id) REFERENCES knowledge_captures(id) ON DELETE CASCADE
);

-- =============================================================================
-- First-Class Follow-ups (v11)
-- =============================================================================

CREATE TABLE IF NOT EXISTS follow_ups (
    id TEXT PRIMARY KEY,
    knowledge_capture_id TEXT NOT NULL,

    -- Follow-up content
    content TEXT NOT NULL,
    owner TEXT,
    target_date TEXT,

    -- Status and scheduling
    status TEXT CHECK(status IN ('pending', 'scheduled', 'completed', 'cancelled')) DEFAULT 'pending',
    scheduled_meeting_id TEXT,

    -- Extraction metadata
    extracted_from TEXT,
    confidence REAL,

    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (knowledge_capture_id) REFERENCES knowledge_captures(id) ON DELETE CASCADE,
    FOREIGN KEY (scheduled_meeting_id) REFERENCES meetings(id)
);

-- =============================================================================
-- Generated Outputs (v11)
-- =============================================================================

CREATE TABLE IF NOT EXISTS outputs (
    id TEXT PRIMARY KEY,
    knowledge_capture_id TEXT NOT NULL,

    -- Template information
    template_id TEXT,
    template_name TEXT NOT NULL,

    -- Generated content
    content TEXT NOT NULL,

    -- Generation metadata
    generated_at TEXT NOT NULL,
    regenerated_count INTEGER DEFAULT 0,

    -- Export tracking
    exported_at TEXT,
    export_format TEXT,

    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (knowledge_capture_id) REFERENCES knowledge_captures(id) ON DELETE CASCADE
);

-- Transcripts
CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL UNIQUE,
    full_text TEXT NOT NULL,
    language TEXT DEFAULT 'es',
    summary TEXT,
    action_items TEXT,
    topics TEXT,
    key_points TEXT,
    sentiment TEXT,
    speakers TEXT,
    turns TEXT,
    diarization_run_id TEXT,
    word_count INTEGER,
    transcription_provider TEXT,
    transcription_model TEXT,
    title_suggestion TEXT,
    question_suggestions TEXT,
    summarization_provider TEXT,
    summarization_model TEXT,
    summarization_template_id TEXT,
    summarization_template_name TEXT,
    summarization_template_hash TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recording_id) REFERENCES recordings(id)
);

-- Per-recording speaker roster + contact mapping (spec 2026-06-17 §6.3, v26 — CHECK widened v27)
CREATE TABLE IF NOT EXISTS recording_speakers (
    recording_id TEXT NOT NULL,
    file_label TEXT NOT NULL,
    contact_id TEXT,
    confidence REAL,
    source TEXT NOT NULL CHECK(source IN ('user', 'auto', 'confirmed', 'self_auto', 'suggestion_confirmed')) DEFAULT 'user',
    created_at TEXT NOT NULL,
    PRIMARY KEY (recording_id, file_label)
);

-- Speaker voiceprint embeddings + provenance (spec §6.3/§6.7, v26 — provenance columns v27)
CREATE TABLE IF NOT EXISTS voiceprints (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    dim INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    created_at TEXT NOT NULL,
    source_recording_id TEXT,
    source_label TEXT,
    clean_speech_ms INTEGER,
    quality_score REAL,
    model_version INTEGER DEFAULT 1,
    created_from TEXT CHECK(created_from IN ('manual','confirmed','self','import')) DEFAULT 'manual',
    disabled_at TEXT,
    superseded_by TEXT
);

-- Per-recording per-label averaged speaker embeddings for suggestions (spec 2026-06-19 §8, v27)
CREATE TABLE IF NOT EXISTS recording_label_embeddings (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    transcript_id TEXT,
    diarization_run_id TEXT,
    file_label TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_version INTEGER DEFAULT 1,
    dim INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    clean_speech_ms INTEGER,
    turn_count INTEGER,
    quality_score REAL,
    status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

-- Per-recording per-label per-window embeddings for mixed-detection persistence (spec 2026-06-21, v32)
CREATE TABLE IF NOT EXISTS recording_window_embeddings (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    transcript_id TEXT,
    diarization_run_id TEXT,
    file_label TEXT NOT NULL,
    window_index INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_version INTEGER NOT NULL DEFAULT 1,
    dim INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rwe_recording_label ON recording_window_embeddings(recording_id, file_label);

-- Pending speaker-identity / merge suggestions (spec 2026-06-19 §8, v27, diarization_run_id v28, contact_id_2 v29)
CREATE TABLE IF NOT EXISTS speaker_suggestions (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    transcript_id TEXT,
    diarization_run_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('identity','merge','mixed','backstop')),
    target_label TEXT,
    target_label_2 TEXT,
    contact_id TEXT,
    contact_id_2 TEXT,
    score REAL,
    rank INTEGER,
    rationale TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','dismissed','expired')) DEFAULT 'pending',
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

-- Diarization-run instrumentation (spec 2026-06-19 §3.5, v30)
CREATE TABLE IF NOT EXISTS diarization_runs (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    transcript_id TEXT,
    provider TEXT NOT NULL,
    model TEXT,
    options_min INTEGER,
    options_max INTEGER,
    options_sent_json TEXT,
    label_count INTEGER NOT NULL,
    is_solo INTEGER NOT NULL DEFAULT 0,
    solo_reason TEXT,
    failure_reason TEXT,
    duration_ms INTEGER,
    policy_version INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diar_runs_recording ON diarization_runs(recording_id, created_at);

-- Embeddings for RAG
CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    transcript_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transcript_id) REFERENCES transcripts(id)
);

-- App configuration and state
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Processing queue
CREATE TABLE IF NOT EXISTS transcription_queue (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    progress INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT,
    parked_until TEXT,
    first_parked_at TEXT,
    FOREIGN KEY (recording_id) REFERENCES recordings(id)
);

-- Transcription service mutex lock (v19)
CREATE TABLE IF NOT EXISTS transcription_service_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    process_id TEXT,
    acquired_at TEXT,
    updated_at TEXT
);

-- Auto-pipeline first-sync baseline (spec 2026-06-11 §5.5) — filename snapshot per device
CREATE TABLE IF NOT EXISTS sync_baseline_files (
    device_serial TEXT NOT NULL,
    filename      TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (device_serial, filename)
);

-- Download queue (v20) - spec-007
CREATE TABLE IF NOT EXISTS download_queue (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    file_size INTEGER NOT NULL,
    progress INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'downloading', 'completed', 'failed', 'cancelled')),
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    recording_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Conversations (v12)
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Chat history
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sources TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Conversation context (v12)
CREATE TABLE IF NOT EXISTS conversation_context (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    knowledge_capture_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_capture_id) REFERENCES knowledge_captures(id) ON DELETE CASCADE,
    UNIQUE(conversation_id, knowledge_capture_id)
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Synced files tracking - prevents re-downloading already synced files
CREATE TABLE IF NOT EXISTS synced_files (
    id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL UNIQUE,
    local_filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Contacts extracted from meeting attendees (renamed to People in UI)
-- Note: email is NOT UNIQUE - multiple contacts can share an email (spec-013)
CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    type TEXT CHECK(type IN ('team', 'candidate', 'customer', 'external', 'unknown')) DEFAULT 'unknown',
    role TEXT,
    company TEXT,
    notes TEXT,
    tags TEXT, -- JSON string of tags
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    meeting_count INTEGER DEFAULT 0,
    is_self INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- User-created projects for organizing meetings
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT CHECK(status IN ('active', 'archived')) DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Hosted-app access control (invite list). v34.
CREATE TABLE IF NOT EXISTS allowed_users (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
    invited_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Junction table: Meeting-Contact relationship
CREATE TABLE IF NOT EXISTS meeting_contacts (
    meeting_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'attendee',
    PRIMARY KEY (meeting_id, contact_id),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

-- Junction table: Meeting-Project relationship
CREATE TABLE IF NOT EXISTS meeting_projects (
    meeting_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    PRIMARY KEY (meeting_id, project_id),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Recording-Meeting candidates: tracks all possible meetings a recording could match
-- Allows AI to select the best match and user to override
CREATE TABLE IF NOT EXISTS recording_meeting_candidates (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    confidence_score REAL DEFAULT 0,
    match_reason TEXT,
    is_selected INTEGER DEFAULT 0,
    is_ai_selected INTEGER DEFAULT 0,
    is_user_confirmed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    UNIQUE(recording_id, meeting_id)
);

-- Device files cache - persists device file list for offline viewing
CREATE TABLE IF NOT EXISTS device_files_cache (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    file_size INTEGER,
    duration_seconds REAL,
    date_recorded TEXT NOT NULL,
    cached_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Quality assessments for recordings (v10)
CREATE TABLE IF NOT EXISTS quality_assessments (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL UNIQUE,
    quality TEXT NOT NULL CHECK(quality IN ('high', 'medium', 'low')),
    assessment_method TEXT NOT NULL CHECK(assessment_method IN ('auto', 'manual')),
    confidence REAL DEFAULT 1.0,
    reason TEXT,
    assessed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    assessed_by TEXT,
    FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
);

-- -- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_device_cache_filename ON device_files_cache(filename);
CREATE INDEX IF NOT EXISTS idx_device_cache_date ON device_files_cache(date_recorded);

CREATE INDEX IF NOT EXISTS idx_meetings_start_time ON meetings(start_time);
CREATE INDEX IF NOT EXISTS idx_recordings_date ON recordings(date_recorded);
CREATE INDEX IF NOT EXISTS idx_recordings_meeting ON recordings(meeting_id);
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
CREATE INDEX IF NOT EXISTS idx_transcripts_recording ON transcripts(recording_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_transcript ON embeddings(transcript_id);
CREATE INDEX IF NOT EXISTS idx_queue_status ON transcription_queue(status);
CREATE INDEX IF NOT EXISTS idx_synced_original ON synced_files(original_filename);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_meeting_contacts_meeting ON meeting_contacts(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_contacts_contact ON meeting_contacts(contact_id);
CREATE INDEX IF NOT EXISTS idx_meeting_projects_meeting ON meeting_projects(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_projects_project ON meeting_projects(project_id);
CREATE INDEX IF NOT EXISTS idx_recording_candidates_recording ON recording_meeting_candidates(recording_id);
CREATE INDEX IF NOT EXISTS idx_recording_candidates_meeting ON recording_meeting_candidates(meeting_id);
CREATE INDEX IF NOT EXISTS idx_recording_candidates_selected ON recording_meeting_candidates(is_selected);
CREATE INDEX IF NOT EXISTS idx_knowledge_captures_quality ON knowledge_captures(quality_rating);
CREATE INDEX IF NOT EXISTS idx_knowledge_captures_status ON knowledge_captures(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_captures_category ON knowledge_captures(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_title ON knowledge_captures(title);
CREATE INDEX IF NOT EXISTS idx_knowledge_summary ON knowledge_captures(summary);
CREATE INDEX IF NOT EXISTS idx_quality_recording ON quality_assessments(recording_id);
CREATE INDEX IF NOT EXISTS idx_quality_level ON quality_assessments(quality);

-- Actionables (intent to create artifacts) (v15 - unified with v11 architecture)
CREATE TABLE IF NOT EXISTS actionables (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    source_knowledge_id TEXT NOT NULL,
    source_action_item_id TEXT,
    suggested_template TEXT,
    suggested_recipients TEXT, -- JSON array
    status TEXT CHECK(status IN ('pending', 'in_progress', 'generated', 'shared', 'dismissed')) DEFAULT 'pending',
    confidence REAL CHECK(confidence >= 0.0 AND confidence <= 1.0),
    artifact_id TEXT, -- Links to outputs table
    generated_at TEXT,
    shared_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_knowledge_id) REFERENCES knowledge_captures(id) ON DELETE CASCADE,
    FOREIGN KEY (artifact_id) REFERENCES outputs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_actionables_source_knowledge ON actionables(source_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_actionables_status ON actionables(status);

-- Summarization templates (spec 2026-06-21) -- user-CRUD, one seeded builtin Default.
CREATE TABLE IF NOT EXISTS summarization_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    example_triggers TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_summ_templates_enabled ON summarization_templates(enabled, is_builtin);

-- Per-recording selector audit / telemetry / selection cache.
CREATE TABLE IF NOT EXISTS transcript_template_runs (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    template_id TEXT,
    selection_kind TEXT NOT NULL,
    selection_confidence REAL NOT NULL DEFAULT 0,
    runnerup_confidence REAL,
    candidate_scores_json TEXT,
    selection_reason TEXT,
    selector_provider TEXT,
    selector_model TEXT,
    selector_elapsed_ms INTEGER,
    full_text_hash TEXT,
    suggested_template_json TEXT,
    applied_instructions_hash TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_template_runs_recording ON transcript_template_runs(recording_id, created_at DESC);

-- Idempotent seed of the protected built-in Default (empty instructions => byte-identical today).
INSERT OR IGNORE INTO summarization_templates (id, name, description, instructions, is_default, is_builtin, enabled)
VALUES ('builtin-default', 'Default', 'Base summarization (no extra emphasis).', '', 0, 1, 1);

`

// Migration functions for schema upgrades
const MIGRATIONS: Record<number, () => void> = {
  2: () => {
    // v2: Add contacts, projects, and junction tables
    // These are idempotent (CREATE TABLE IF NOT EXISTS), so safe to re-run
    console.log('Running migration to schema v2: Adding contacts and projects tables')
  },
  3: () => {
    // v3: Add recording-meeting candidates table for AI-powered matching
    console.log('Running migration to schema v3: Adding recording_meeting_candidates table')
    // The table is created in the schema, this just logs the migration
  },
  6: () => {
    // v6: Add recording lifecycle columns for unified recording management
    console.log('Running migration to schema v6: Adding recording lifecycle columns')
    const database = getDatabase()

    // Add new columns to recordings table if they don't exist
    // SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we use try-catch
    const columnsToAdd = [
      "ALTER TABLE recordings ADD COLUMN location TEXT DEFAULT 'device-only'",
      "ALTER TABLE recordings ADD COLUMN transcription_status TEXT DEFAULT 'none'",
      "ALTER TABLE recordings ADD COLUMN on_device INTEGER DEFAULT 1",
      "ALTER TABLE recordings ADD COLUMN device_last_seen TEXT",
      "ALTER TABLE recordings ADD COLUMN on_local INTEGER DEFAULT 0",
      "ALTER TABLE recordings ADD COLUMN source TEXT DEFAULT 'hidock'",
      "ALTER TABLE recordings ADD COLUMN is_imported INTEGER DEFAULT 0"
    ]

    for (const sql of columnsToAdd) {
      try {
        database.exec(sql)
      } catch {
        // Column likely already exists, ignore
        console.log(`Column may already exist: ${sql}`)
      }
    }

    // Update existing recordings: if they have a file_path, mark them as on_local
    try {
      database.exec(`
        UPDATE recordings
        SET on_local = 1,
            location = CASE WHEN on_device = 1 THEN 'both' ELSE 'local-only' END
        WHERE file_path IS NOT NULL AND file_path != ''
      `)
    } catch (e) {
      console.warn('Failed to update existing recordings:', e)
    }

    console.log('Migration v6 complete: Recording lifecycle columns added')
  },
  7: () => {
    // v7: Recalculate durations for HDA files using correct formula (file_size / 4)
    // This fixes recordings that had incorrect duration calculated before
    console.log('Running migration to schema v7: Recalculating HDA file durations')
    const database = getDatabase()

    try {
      // Get all recordings with .hda extension and file_size available
      const recordings = database.prepare(`
        SELECT id, filename, file_size, duration_seconds
        FROM recordings
        WHERE (filename LIKE '%.hda' OR filename LIKE '%.HDA')
        AND file_size IS NOT NULL
        AND file_size > 0
      `).raw().all() as Array<[string, string, number, number | null]>

      if (recordings.length > 0) {
        let updatedCount = 0
        const upd = database.prepare('UPDATE recordings SET duration_seconds = ? WHERE id = ?')
        for (const row of recordings) {
          const [id, filename, fileSize, oldDuration] = row

          // Calculate correct duration: HDA version 1 format uses fileSize / 8000 seconds
          // This formula was verified against real recordings (e.g., 15.7MB = 32m39s)
          const newDuration = Math.round(fileSize / 8000)

          // Only update if different (or was null/0)
          if (oldDuration !== newDuration) {
            upd.run(newDuration, id)
            updatedCount++
            console.log(`[Migration v7] Updated ${filename}: ${oldDuration || 0}s -> ${newDuration}s`)
          }
        }
        console.log(`[Migration v7] Updated durations for ${updatedCount} recordings`)
      } else {
        console.log('[Migration v7] No HDA recordings found to update')
      }

      // Also update device_files_cache if present
      try {
        const cachedFiles = database.prepare(`
          SELECT id, filename, file_size, duration_seconds
          FROM device_files_cache
          WHERE (filename LIKE '%.hda' OR filename LIKE '%.HDA')
          AND file_size IS NOT NULL
          AND file_size > 0
        `).raw().all() as Array<[string, string, number, number | null]>

        if (cachedFiles.length > 0) {
          const updCache = database.prepare('UPDATE device_files_cache SET duration_seconds = ? WHERE id = ?')
          for (const row of cachedFiles) {
            const [id, _filename, fileSize, oldDuration] = row
            const newDuration = Math.round(fileSize / 8000)

            if (oldDuration !== newDuration) {
              updCache.run(newDuration, id)
            }
          }
          console.log('[Migration v7] Updated device_files_cache durations')
        }
      } catch {
        // device_files_cache may not exist
        console.log('[Migration v7] device_files_cache not found or empty')
      }
    } catch (e) {
      console.error('[Migration v7] Error recalculating durations:', e)
    }

    console.log('Migration v7 complete: HDA durations recalculated')
  },
  8: () => {
    // v8: Fix HDA duration calculation formula - v7 used /4 which was wrong, correct formula is /8000
    // This fixes recordings that got wrong duration from v7 migration
    console.log('Running migration to schema v8: Fixing HDA duration formula (v7 was wrong)')
    const database = getDatabase()

    try {
      // Get all recordings with .hda extension and file_size available
      const recordings = database.prepare(`
        SELECT id, filename, file_size, duration_seconds
        FROM recordings
        WHERE (filename LIKE '%.hda' OR filename LIKE '%.HDA')
        AND file_size IS NOT NULL
        AND file_size > 0
      `).raw().all() as Array<[string, string, number, number | null]>

      if (recordings.length > 0) {
        let updatedCount = 0
        const upd = database.prepare('UPDATE recordings SET duration_seconds = ? WHERE id = ?')
        for (const row of recordings) {
          const [id, filename, fileSize, oldDuration] = row

          // CORRECT formula: fileSize / 8000 gives seconds
          // Verified: 15.7MB file = 1959 seconds = 32m39s
          const newDuration = Math.round(fileSize / 8000)

          // Update if different
          if (oldDuration !== newDuration) {
            upd.run(newDuration, id)
            updatedCount++
            const oldMin = oldDuration ? Math.floor(oldDuration / 60) : 0
            const oldSec = oldDuration ? Math.round(oldDuration % 60) : 0
            const newMin = Math.floor(newDuration / 60)
            const newSec = Math.round(newDuration % 60)
            console.log(`[Migration v8] Fixed ${filename}: ${oldMin}m${oldSec}s -> ${newMin}m${newSec}s`)
          }
        }
        console.log(`[Migration v8] Fixed durations for ${updatedCount} recordings`)
      } else {
        console.log('[Migration v8] No HDA recordings found to fix')
      }

      // Also fix device_files_cache
      try {
        const cachedFiles = database.prepare(`
          SELECT id, filename, file_size, duration_seconds
          FROM device_files_cache
          WHERE (filename LIKE '%.hda' OR filename LIKE '%.HDA')
          AND file_size IS NOT NULL
          AND file_size > 0
        `).raw().all() as Array<[string, string, number, number | null]>

        if (cachedFiles.length > 0) {
          const updCache = database.prepare('UPDATE device_files_cache SET duration_seconds = ? WHERE id = ?')
          for (const row of cachedFiles) {
            const [id, _filename, fileSize, oldDuration] = row
            const newDuration = Math.round(fileSize / 8000)

            if (oldDuration !== newDuration) {
              updCache.run(newDuration, id)
            }
          }
          console.log('[Migration v8] Fixed device_files_cache durations')
        }
      } catch {
        console.log('[Migration v8] device_files_cache not found or empty')
      }
    } catch (e) {
      console.error('[Migration v8] Error fixing durations:', e)
    }

    console.log('Migration v8 complete: HDA durations fixed with correct formula')
  },
  9: () => {
    // v9: Force re-run HDA duration fix in case v8 didn't run due to version mismatch
    // This ensures all HDA files have correct durations using fileSize / 8000
    console.log('Running migration to schema v9: Ensuring HDA durations are correct')
    const database = getDatabase()

    try {
      // Get all HDA recordings
      const recordings = database.prepare(`
        SELECT id, filename, file_size, duration_seconds
        FROM recordings
        WHERE (filename LIKE '%.hda' OR filename LIKE '%.HDA')
        AND file_size IS NOT NULL
        AND file_size > 0
      `).raw().all() as Array<[string, string, number, number | null]>

      if (recordings.length > 0) {
        let updatedCount = 0
        const upd = database.prepare('UPDATE recordings SET duration_seconds = ? WHERE id = ?')
        for (const row of recordings) {
          const [id, filename, fileSize, oldDuration] = row

          // CORRECT formula: fileSize / 8000 gives seconds
          const newDuration = Math.round(fileSize / 8000)

          // Update if different or if the old duration seems wildly wrong (> 6 hours for any file)
          const needsUpdate = oldDuration !== newDuration || (oldDuration && oldDuration > 21600)

          if (needsUpdate) {
            upd.run(newDuration, id)
            updatedCount++
            const oldMin = oldDuration ? Math.floor(oldDuration / 60) : 0
            const oldSec = oldDuration ? Math.round(oldDuration % 60) : 0
            const newMin = Math.floor(newDuration / 60)
            const newSec = Math.round(newDuration % 60)
            console.log(`[Migration v9] Fixed ${filename}: ${oldMin}m${oldSec}s -> ${newMin}m${newSec}s`)
          }
        }
        console.log(`[Migration v9] Fixed durations for ${updatedCount} recordings`)
      } else {
        console.log('[Migration v9] No HDA recordings found')
      }

      // Also fix device_files_cache
      try {
        const cachedFiles = database.prepare(`
          SELECT id, filename, file_size, duration_seconds
          FROM device_files_cache
          WHERE (filename LIKE '%.hda' OR filename LIKE '%.HDA')
          AND file_size IS NOT NULL
          AND file_size > 0
        `).raw().all() as Array<[string, string, number, number | null]>

        if (cachedFiles.length > 0) {
          const updCache = database.prepare('UPDATE device_files_cache SET duration_seconds = ? WHERE id = ?')
          for (const row of cachedFiles) {
            const [id, _filename, fileSize, oldDuration] = row
            const newDuration = Math.round(fileSize / 8000)
            const needsUpdate = oldDuration !== newDuration || (oldDuration && oldDuration > 21600)

            if (needsUpdate) {
              updCache.run(newDuration, id)
            }
          }
          console.log('[Migration v9] Fixed device_files_cache durations')
        }
      } catch {
        console.log('[Migration v9] device_files_cache not found or empty')
      }
    } catch (e) {
      console.error('[Migration v9] Error fixing durations:', e)
    }

    console.log('Migration v9 complete: HDA durations verified/fixed')
  },
  10: () => {
    // v10: Add quality_assessments table and storage_tier column for Phase 0 architecture
    console.log('Running migration to schema v10: Adding quality assessment and storage policy support')
    const database = getDatabase()

    // Add storage_tier column to recordings table if it doesn't exist
    try {
      database.exec(`
        ALTER TABLE recordings
        ADD COLUMN storage_tier TEXT DEFAULT NULL
        CHECK(storage_tier IN (NULL, 'hot', 'warm', 'cold', 'archive'))
      `)
      console.log('[Migration v10] Added storage_tier column to recordings')
    } catch {
      // Column likely already exists
      console.log('[Migration v10] storage_tier column may already exist')
    }

    // Create index on storage_tier (must be done after column exists)
    try {
      database.exec('CREATE INDEX IF NOT EXISTS idx_recordings_storage_tier ON recordings(storage_tier)')
      console.log('[Migration v10] Created storage_tier index')
    } catch {
      console.log('[Migration v10] storage_tier index may already exist')
    }

    // quality_assessments table is created in the schema, this just logs the migration
    console.log('[Migration v10] quality_assessments table added to schema')
    console.log('Migration v10 complete: Quality assessment and storage policy tables created')
  },
  11: () => {
    // v11: Knowledge Captures architecture
    console.log('Running migration to schema v11: Knowledge Captures architecture')
    const database = getDatabase()

    try {
      // 1. Check if recordings table needs migration columns (v11)
      const recordingsInfo = database.pragma('table_info(recordings)') as Array<{ name: string }>
      const hasMigrationStatus = recordingsInfo.some(col => col.name === 'migration_status')

      if (!hasMigrationStatus) {
        console.log('[Migration v11] Migration columns not found in recordings, adding them...')
        const columnsToAdd = [
          "ALTER TABLE recordings ADD COLUMN migrated_to_capture_id TEXT",
          "ALTER TABLE recordings ADD COLUMN migration_status TEXT CHECK(migration_status IN ('pending', 'migrated', 'skipped', 'error')) DEFAULT 'pending'",
          "ALTER TABLE recordings ADD COLUMN migrated_at TEXT"
        ]
        for (const sql of columnsToAdd) {
          try { database.exec(sql) } catch { /* ignore duplicate */ }
        }
      }

      // 2. Check if knowledge_captures table exists and has all columns
      const tableCheck = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_captures'").get()
      const tableExists = tableCheck !== undefined

      if (!tableExists) {
        console.log('[Migration v11] knowledge_captures table not found, executing full schema script...')
        const schemaPath = join(__dirname, 'migrations/v11-knowledge-captures.sql')
        if (existsSync(schemaPath)) {
          const schemaSQL = readFileSync(schemaPath, 'utf-8')
          const statements = schemaSQL.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(s => s.length > 0)
          for (const sql of statements) {
            try { database.exec(sql) } catch { /* ignore existing */ }
          }
        }
      } else {
        // Table exists, check for ALL columns added during redesign
        const existingCols = (database.pragma('table_info(knowledge_captures)') as Array<{ name: string }>).map(col => col.name)

        const requiredColumns = [
          { name: 'category', def: "category TEXT CHECK(category IN ('meeting', 'interview', '1:1', 'brainstorm', 'note', 'other')) DEFAULT 'meeting'" },
          { name: 'status', def: "status TEXT CHECK(status IN ('processing', 'ready', 'enriched')) DEFAULT 'ready'" },
          { name: 'quality_rating', def: "quality_rating TEXT CHECK(quality_rating IN ('valuable', 'archived', 'low-value', 'garbage', 'unrated')) DEFAULT 'unrated'" },
          { name: 'quality_confidence', def: "quality_confidence REAL" },
          { name: 'quality_assessed_at', def: "quality_assessed_at TEXT" },
          { name: 'storage_tier', def: "storage_tier TEXT CHECK(storage_tier IN ('hot', 'cold', 'expiring', 'deleted')) DEFAULT 'hot'" },
          { name: 'retention_days', def: "retention_days INTEGER" },
          { name: 'expires_at', def: "expires_at TEXT" },
          { name: 'meeting_id', def: "meeting_id TEXT REFERENCES meetings(id)" },
          { name: 'correlation_confidence', def: "correlation_confidence REAL" },
          { name: 'correlation_method', def: "correlation_method TEXT" },
          { name: 'source_recording_id', def: "source_recording_id TEXT REFERENCES recordings(id)" }
        ]

        for (const col of requiredColumns) {
          if (!existingCols.includes(col.name)) {
            console.log(`[Migration v11] Adding missing column ${col.name} to knowledge_captures`)
            try {
              database.exec(`ALTER TABLE knowledge_captures ADD COLUMN ${col.def}`)
            } catch (e) {
              console.warn(`[Migration v11] Could not add column ${col.name}: ${e}`)
            }
          }
        }
      }

      // 3. Ensure all v11 indexes exist
      const indexes = [
        "CREATE INDEX IF NOT EXISTS idx_knowledge_captures_status ON knowledge_captures(status)",
        "CREATE INDEX IF NOT EXISTS idx_knowledge_captures_category ON knowledge_captures(category)",
        "CREATE INDEX IF NOT EXISTS idx_actionables_source_knowledge ON actionables(source_knowledge_id)",
        "CREATE INDEX IF NOT EXISTS idx_actionables_status ON actionables(status)"
      ]
      for (const sql of indexes) {
        try { database.exec(sql) } catch (e) { console.warn(`Index warning: ${e}`) }
      }

    } catch (error) {
      console.error('[Migration v11] Error during schema upgrade:', error)
    }

    console.log('Migration v11 complete: Schema version updated to v11')
  },
  12: () => {
    // v12: Conversation History & Context
    console.log('Running migration to schema v12: Adding conversations and conversation_context tables')
    const database = getDatabase()

    // Add conversation_id column to chat_messages if it doesn't exist
    try {
      database.exec('ALTER TABLE chat_messages ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE')
      console.log('[Migration v12] Added conversation_id column to chat_messages')
    } catch {
      console.log('[Migration v12] conversation_id column may already exist')
    }

    // conversation_context and conversations tables are handled by CREATE TABLE IF NOT EXISTS in SCHEMA
    console.log('Migration v12 complete: Conversation tables and columns created')
  },
  13: () => {
    // v13: Enhanced People Entity
    console.log('Running migration to schema v13: Adding fields to contacts table')
    const database = getDatabase()

    const columnsToAdd = [
      "ALTER TABLE contacts ADD COLUMN type TEXT CHECK(type IN ('team', 'candidate', 'customer', 'external', 'unknown')) DEFAULT 'unknown'",
      "ALTER TABLE contacts ADD COLUMN role TEXT",
      "ALTER TABLE contacts ADD COLUMN company TEXT",
      "ALTER TABLE contacts ADD COLUMN tags TEXT"
    ]

    for (const sql of columnsToAdd) {
      try {
        database.exec(sql)
      } catch {
        console.log(`Column may already exist: ${sql}`)
      }
    }
    console.log('Migration v13 complete: Contacts table enhanced')
  },
  14: () => {
    // v14: Project Status
    console.log('Running migration to schema v14: Adding status to projects table')
    const database = getDatabase()

    try {
      database.exec("ALTER TABLE projects ADD COLUMN status TEXT CHECK(status IN ('active', 'archived')) DEFAULT 'active'")
      console.log('[Migration v14] Added status column to projects')
    } catch {
      console.log('[Migration v14] status column may already exist')
    }
    console.log('Migration v14 complete: Projects table enhanced')
  },
  15: () => {
    // v15: Actionables table handled by SCHEMA CREATE TABLE IF NOT EXISTS
    console.log('Running migration to schema v15: Actionables architecture')
    console.log('Migration v15 complete: Actionables table created')
  },
  16: () => {
    // v16: Add title_suggestion and question_suggestions to transcripts table
    console.log('Running migration to schema v16: Adding AI-generated title and question suggestions to transcripts')
    const database = getDatabase()

    const columnsToAdd = [
      "ALTER TABLE transcripts ADD COLUMN title_suggestion TEXT",
      "ALTER TABLE transcripts ADD COLUMN question_suggestions TEXT"
    ]

    for (const sql of columnsToAdd) {
      try {
        database.exec(sql)
      } catch {
        // Column likely already exists, ignore
        console.log(`Column may already exist: ${sql}`)
      }
    }

    console.log('Migration v16 complete: AI title and question suggestions added to transcripts')
  },
  17: () => {
    // v17: Add confidence column to actionables table for AI detection confidence scoring
    console.log('Running migration to schema v17: Adding confidence column to actionables')
    const database = getDatabase()

    // Check if confidence column already exists
    const v17Columns = (database.pragma('table_info(actionables)') as Array<{ name: string }>).map(row => row.name)
    if (v17Columns.length > 0) {
      const columns = v17Columns
      if (!columns.includes('confidence')) {
        try {
          database.exec('ALTER TABLE actionables ADD COLUMN confidence REAL CHECK(confidence >= 0.0 AND confidence <= 1.0)')
          console.log('[Migration v17] Added confidence column to actionables table')
        } catch (e) {
          console.warn('[Migration v17] Failed to add confidence column:', e)
        }
      } else {
        console.log('[Migration v17] Confidence column already exists, skipping')
      }
    }

    console.log('Migration v17 complete: Confidence column added to actionables')
  },
  18: () => {
    // v18: AI-15 — Add missing columns to chat_messages referenced by assistant mapper
    console.log('Running migration to schema v18: Adding missing chat_messages columns')
    const database = getDatabase()

    const v18Columns = (database.pragma('table_info(chat_messages)') as Array<{ name: string }>).map(row => row.name)
    if (v18Columns.length > 0) {
      const columns = v18Columns

      const columnsToAdd = [
        { name: 'edited_at', sql: 'ALTER TABLE chat_messages ADD COLUMN edited_at TEXT' },
        { name: 'original_content', sql: 'ALTER TABLE chat_messages ADD COLUMN original_content TEXT' },
        { name: 'created_output_id', sql: 'ALTER TABLE chat_messages ADD COLUMN created_output_id TEXT' },
        { name: 'saved_as_insight_id', sql: 'ALTER TABLE chat_messages ADD COLUMN saved_as_insight_id TEXT' }
      ]

      for (const col of columnsToAdd) {
        if (!columns.includes(col.name)) {
          try {
            database.exec(col.sql)
            console.log(`[Migration v18] Added ${col.name} column to chat_messages`)
          } catch (e) {
            console.warn(`[Migration v18] Failed to add ${col.name}:`, e)
          }
        }
      }
    }

    console.log('Migration v18 complete: chat_messages columns added')
  },
  19: () => {
    // v19: spec-005 — Add transcription service mutex lock table for atomic process ID tracking
    console.log('Running migration to schema v19: Adding transcription_service_lock table')
    const database = getDatabase()

    try {
      // Create the lock table
      database.exec(`
        CREATE TABLE IF NOT EXISTS transcription_service_lock (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          process_id TEXT,
          acquired_at TEXT,
          updated_at TEXT
        )
      `)

      // Initialize with a single row (process_id = NULL means unlocked)
      database.exec(`
        INSERT OR IGNORE INTO transcription_service_lock (id, process_id, acquired_at, updated_at)
        VALUES (1, NULL, NULL, NULL)
      `)

      console.log('[Migration v19] transcription_service_lock table created')
    } catch (e) {
      console.warn('[Migration v19] Failed to create transcription_service_lock table:', e)
    }

    console.log('Migration v19 complete: Transcription service mutex lock added')
  },
  20: () => {
    // v20: Phase A consolidated fixes (spec-013, spec-010, spec-014, spec-007)
    console.log('Running migration to schema v20: Phase A consolidated fixes')
    const database = getDatabase()

    // 1. spec-013: Remove UNIQUE constraint on contacts.email (allows multiple NULL)
    console.log('[Migration v20] Removing UNIQUE constraint on contacts.email')
    try {
      // Check if the UNIQUE constraint exists by checking the CREATE TABLE sql
      const tableInfo = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='contacts'").get() as { sql: string } | undefined
      const createSql = tableInfo?.sql ?? ''

      if (createSql.includes('UNIQUE')) {
        // SQLite requires table recreation to remove constraints
        database.exec(`
          CREATE TABLE contacts_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT,
            type TEXT CHECK(type IN ('team', 'candidate', 'customer', 'external', 'unknown')) DEFAULT 'unknown',
            role TEXT,
            company TEXT,
            notes TEXT,
            tags TEXT,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            meeting_count INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          )
        `)
        database.exec('INSERT INTO contacts_new SELECT * FROM contacts')
        database.exec('DROP TABLE contacts')
        database.exec('ALTER TABLE contacts_new RENAME TO contacts')
        console.log('[Migration v20] contacts.email UNIQUE constraint removed')
      } else {
        console.log('[Migration v20] contacts.email UNIQUE constraint already absent')
      }
    } catch (e) {
      console.warn('[Migration v20] Contacts email constraint fix failed:', e)
    }

    // 2. spec-010: Add search indexes for knowledge table
    console.log('[Migration v20] Adding search indexes')
    try {
      database.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_title ON knowledge_captures(title)')
      database.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_summary ON knowledge_captures(summary)')
      console.log('[Migration v20] Search indexes created')
    } catch (e) {
      console.warn('[Migration v20] Search index creation failed:', e)
    }

    // 3. spec-014: Add transcription queue progress columns
    console.log('[Migration v20] Adding transcription queue columns')
    const tqColumns = (database.pragma('table_info(transcription_queue)') as Array<{ name: string }>).map(row => row.name)
    if (tqColumns.length > 0) {
      if (!tqColumns.includes('retry_count')) {
        try {
          database.exec('ALTER TABLE transcription_queue ADD COLUMN retry_count INTEGER DEFAULT 0')
          console.log('[Migration v20] Added retry_count column')
        } catch (e) {
          console.warn('[Migration v20] Failed to add retry_count:', e)
        }
      }

      if (!tqColumns.includes('progress')) {
        try {
          database.exec('ALTER TABLE transcription_queue ADD COLUMN progress INTEGER DEFAULT 0')
          console.log('[Migration v20] Added progress column')
        } catch (e) {
          console.warn('[Migration v20] Failed to add progress:', e)
        }
      }
    }

    // 4. spec-007: Add download_queue table
    console.log('[Migration v20] Creating download_queue table')
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS download_queue (
          id TEXT PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          file_size INTEGER NOT NULL,
          progress INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'downloading', 'completed', 'failed')),
          error TEXT,
          started_at TEXT,
          completed_at TEXT,
          recording_date TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `)
      console.log('[Migration v20] download_queue table created')
    } catch (e) {
      console.warn('[Migration v20] download_queue table creation failed:', e)
    }

    console.log('Migration v20 complete: Phase A consolidated fixes applied')
  },
  21: () => {
    // v21: AUD2-001 — Backfill meeting_id in knowledge_captures from recordings
    console.log('Running migration to schema v21: Backfilling meeting_id in knowledge_captures')
    const database = getDatabase()

    try {
      // Update knowledge_captures to inherit meeting_id from their source recordings
      const sql = `
        UPDATE knowledge_captures
        SET meeting_id = (
          SELECT r.meeting_id
          FROM recordings r
          WHERE r.id = knowledge_captures.source_recording_id
          AND r.meeting_id IS NOT NULL
        ),
        correlation_method = COALESCE(correlation_method, 'recording_migration'),
        correlation_confidence = COALESCE(correlation_confidence, 1.0),
        updated_at = CURRENT_TIMESTAMP
        WHERE meeting_id IS NULL
          AND source_recording_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM recordings r
            WHERE r.id = knowledge_captures.source_recording_id
            AND r.meeting_id IS NOT NULL
          )
      `
      database.exec(sql)

      // Log how many were updated
      const updated = database.prepare(`
        SELECT COUNT(*) as count
        FROM knowledge_captures
        WHERE meeting_id IS NOT NULL
          AND correlation_method = 'recording_migration'
      `).get() as { count: number } | undefined
      const count = updated?.count ?? 0
      console.log(`[Migration v21] Backfilled meeting_id for ${count} knowledge captures`)
    } catch (e) {
      console.warn('[Migration v21] Failed to backfill meeting_id:', e)
    }

    console.log('Migration v21 complete: meeting_id backfill applied')
  },

  22: () => {
    // v22: SPEC-002 — Convert legacy rec_ IDs to standard UUIDs
    // recording-watcher used to generate IDs like "rec_1700000000000" which fail
    // Zod UUID validation and cause data fragmentation.
    console.log('Running migration to schema v22: Converting legacy rec_ IDs to UUIDs')
    const database = getDatabase()

    try {
      const legacyRows = database.prepare("SELECT id FROM recordings WHERE id LIKE 'rec_%'").raw().all() as Array<[string]>
      if (legacyRows.length === 0) {
        console.log('[Migration v22] No legacy rec_ IDs found — nothing to migrate')
        return
      }

      const legacyIds = legacyRows.map(row => row[0])
      console.log(`[Migration v22] Found ${legacyIds.length} legacy rec_ IDs to migrate`)

      const updTq = database.prepare('UPDATE transcription_queue SET recording_id = ? WHERE recording_id = ?')
      const updTr = database.prepare('UPDATE transcripts SET recording_id = ? WHERE recording_id = ?')
      const updVe = database.prepare('UPDATE vector_embeddings SET transcript_id = ? WHERE transcript_id = ?')
      const updRmc = database.prepare('UPDATE recording_meeting_candidates SET recording_id = ? WHERE recording_id = ?')
      const selRec = database.prepare('SELECT * FROM recordings WHERE id = ?')
      const delRec = database.prepare('DELETE FROM recordings WHERE id = ?')

      let migratedCount = 0
      for (const oldId of legacyIds) {
        const newId = randomUUID()

        // Update foreign keys first (transcription_queue, transcriptions, etc.)
        updTq.run(newId, oldId)
        updTr.run(newId, oldId)
        updVe.run(newId, oldId)
        updRmc.run(newId, oldId)

        // SQLite doesn't allow updating a PRIMARY KEY directly — use INSERT + DELETE
        const columns = selRec.columns().map(c => c.name)
        const rowValues = selRec.raw().get(oldId) as unknown[] | undefined
        if (rowValues) {
          const values = [...rowValues]
          const idIndex = columns.indexOf('id')
          if (idIndex !== -1) {
            values[idIndex] = newId
          }
          const placeholders = columns.map(() => '?').join(', ')
          const columnList = columns.join(', ')
          database.prepare(`INSERT INTO recordings (${columnList}) VALUES (${placeholders})`).run(...values)
          delRec.run(oldId)
          migratedCount++
        }
      }

      console.log(`[Migration v22] Migrated ${migratedCount} recordings from rec_ to UUID format`)
    } catch (e) {
      console.warn('[Migration v22] Failed to migrate legacy rec_ IDs:', e)
    }

    console.log('Migration v22 complete: legacy rec_ ID conversion applied')
  },

  23: () => {
    // v23: Fix for v22 which crashed on non-existent vector_embeddings table.
    // Re-run rec_ → UUID migration with correct table references.
    console.log('Running migration to schema v23: Re-running rec_ ID migration with corrected tables')
    const database = getDatabase()

    try {
      const legacyRows = database.prepare("SELECT id FROM recordings WHERE id LIKE 'rec_%'").raw().all() as Array<[string]>
      if (legacyRows.length === 0) {
        console.log('[Migration v23] No legacy rec_ IDs found — v22 may have partially succeeded or none existed')
        return
      }

      const legacyIds = legacyRows.map(row => row[0])
      console.log(`[Migration v23] Found ${legacyIds.length} legacy rec_ IDs to migrate`)

      const updTq = database.prepare('UPDATE transcription_queue SET recording_id = ? WHERE recording_id = ?')
      const updTr = database.prepare('UPDATE transcripts SET recording_id = ? WHERE recording_id = ?')
      const updRmc = database.prepare('UPDATE recording_meeting_candidates SET recording_id = ? WHERE recording_id = ?')
      const updQa = database.prepare('UPDATE quality_assessments SET recording_id = ? WHERE recording_id = ?')
      const updKc = database.prepare('UPDATE knowledge_captures SET source_recording_id = ? WHERE source_recording_id = ?')
      const selRec = database.prepare('SELECT * FROM recordings WHERE id = ?')
      const delRec = database.prepare('DELETE FROM recordings WHERE id = ?')

      let migratedCount = 0
      for (const oldId of legacyIds) {
        const newId = randomUUID()

        updTq.run(newId, oldId)
        updTr.run(newId, oldId)
        updRmc.run(newId, oldId)
        updQa.run(newId, oldId)
        updKc.run(newId, oldId)

        const columns = selRec.columns().map(c => c.name)
        const rowValues = selRec.raw().get(oldId) as unknown[] | undefined
        if (rowValues) {
          const values = [...rowValues]
          const idIndex = columns.indexOf('id')
          if (idIndex !== -1) {
            values[idIndex] = newId
          }
          const placeholders = columns.map(() => '?').join(', ')
          const columnList = columns.join(', ')
          database.prepare(`INSERT INTO recordings (${columnList}) VALUES (${placeholders})`).run(...values)
          delRec.run(oldId)
          migratedCount++
        }
      }

      console.log(`[Migration v23] Migrated ${migratedCount} recordings from rec_ to UUID format`)
    } catch (e) {
      console.error('[Migration v23] FAILED to migrate legacy rec_ IDs:', e)
    }
  },

  24: () => {
    console.log('Running migration to schema v24: Add cancelled status to download_queue CHECK constraint')
    const database = getDatabase()

    try {
      // SQLite cannot ALTER CHECK constraints -- must recreate the table
      // Check if migration is needed (idempotent)
      const tableInfoResult = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='download_queue'").get() as { sql: string } | undefined
      if (tableInfoResult) {
        const createSql = String(tableInfoResult.sql)
        if (createSql.includes("'cancelled'")) {
          console.log('[Migration v24] download_queue already has cancelled status, skipping')
          return
        }
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS download_queue_new (
          id TEXT PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          file_size INTEGER NOT NULL,
          progress INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'downloading', 'completed', 'failed', 'cancelled')),
          error TEXT,
          started_at TEXT,
          completed_at TEXT,
          recording_date TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `)

      // Copy existing data
      database.exec(`
        INSERT OR IGNORE INTO download_queue_new
        SELECT id, filename, file_size, progress, status, error, started_at, completed_at, recording_date, created_at
        FROM download_queue
      `)

      database.exec('DROP TABLE IF EXISTS download_queue')
      database.exec('ALTER TABLE download_queue_new RENAME TO download_queue')

      console.log('Migration v24 complete: download_queue CHECK constraint updated')
    } catch (e) {
      console.warn('[Migration v24] Failed:', e)
    }
  },

  25: () => {
    // v25: Auto-pipeline P1 (spec 2026-06-11 §5.8) — two-stage worker columns,
    // quota-parking columns, baseline snapshot table, and Stage-2 backfill.
    console.log('Running migration to schema v25: auto-pipeline two-stage columns')
    const database = getDatabase()

    const columnsToAdd = [
      'ALTER TABLE transcripts ADD COLUMN summarization_provider TEXT',
      'ALTER TABLE transcripts ADD COLUMN summarization_model TEXT',
      'ALTER TABLE transcription_queue ADD COLUMN parked_until TEXT',
      'ALTER TABLE transcription_queue ADD COLUMN first_parked_at TEXT'
    ]
    for (const sql of columnsToAdd) {
      try {
        database.exec(sql)
      } catch (e) {
        const msg = (e as Error).message
        if (msg.includes('duplicate column name')) {
          // Column already exists (fresh DB created from current SCHEMA) — expected, ignore.
          console.log(`Column already exists: ${sql}`)
        } else {
          console.warn(`[Migration v25] ALTER failed (${sql}):`, e)
        }
      }
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS sync_baseline_files (
        device_serial TEXT NOT NULL,
        filename      TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (device_serial, filename)
      )
    `)

    // Backfill: fused-flow transcripts with a REAL summary are Stage-2-complete.
    // The fused flow was Gemini-only and a single model produced both stages —
    // that's why 'gemini' is hardcoded and transcription_model is copied into
    // summarization_model. Rows with NULL summary (the historical silent-failure
    // path) keep a NULL marker: they stay Stage-2-resumable and are recovered
    // via Re-summarize (spec §5.6/§5.8).
    database.exec(`
      UPDATE transcripts
      SET summarization_provider = 'gemini', summarization_model = transcription_model
      WHERE full_text IS NOT NULL AND summary IS NOT NULL AND summarization_provider IS NULL
    `)

    console.log('Migration v25 complete')
  },

  26: () => {
    // v26: Speaker diarization (spec 2026-06-17 §6.3) — structured turns column,
    // the recording_speakers roster/mapping table, and the voiceprints capture table.
    // Pattern mirrors MIGRATIONS[25] (AP-§5.8): try/catch-guarded ALTER for the new
    // column (duplicate-column is expected on a fresh DB created from current SCHEMA),
    // CREATE TABLE IF NOT EXISTS for the new tables. No data backfill — turns is
    // populated going forward by upsertTranscriptStage1; pre-v26 rows keep turns NULL
    // and render via the TranscriptViewer legacy text-prefix path (§6.5).
    console.log('Running migration to schema v26: speaker diarization tables')
    const database = getDatabase()

    const columnsToAdd = ['ALTER TABLE transcripts ADD COLUMN turns TEXT']
    for (const sql of columnsToAdd) {
      try {
        database.exec(sql)
      } catch (e) {
        const msg = (e as Error).message
        if (msg.includes('duplicate column name')) {
          console.log(`Column already exists: ${sql}`)
        } else {
          console.warn(`[Migration v26] ALTER failed (${sql}):`, e)
        }
      }
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS recording_speakers (
        recording_id TEXT NOT NULL,
        file_label TEXT NOT NULL,
        contact_id TEXT,
        confidence REAL,
        source TEXT NOT NULL CHECK(source IN ('user', 'auto')) DEFAULT 'user',
        created_at TEXT NOT NULL,
        PRIMARY KEY (recording_id, file_label)
      )
    `)

    database.exec(`
      CREATE TABLE IF NOT EXISTS voiceprints (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dim INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL
      )
    `)

    console.log('Migration v26 complete')
  },

  27: () => {
    // v27: voice-library foundation (spec 2026-06-19 rev 2 §8). New tables, voiceprint
    // provenance columns, recording_speakers.source CHECK widened (table-rebuild — sql.js
    // can't ALTER a CHECK), and contacts.is_self.
    console.log('Running migration to schema v27: voice-library foundation')
    const database = getDatabase()

    // (a) idempotent column adds (duplicate-column expected on a fresh v27 DB)
    const columnsToAdd = [
      'ALTER TABLE contacts ADD COLUMN is_self INTEGER NOT NULL DEFAULT 0'
    ]
    for (const sql of columnsToAdd) {
      try { database.exec(sql) } catch (e) {
        const msg = (e as Error).message
        if (msg.includes('duplicate column name')) console.log(`Column already exists: ${sql}`)
        else console.warn(`[Migration v27] ALTER failed (${sql}):`, e)
      }
    }

    // (b) new tables (idempotent)
    database.exec(`CREATE TABLE IF NOT EXISTS recording_label_embeddings (
      id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, transcript_id TEXT, diarization_run_id TEXT,
      file_label TEXT NOT NULL, model_id TEXT NOT NULL, model_version INTEGER DEFAULT 1, dim INTEGER NOT NULL,
      embedding BLOB NOT NULL, clean_speech_ms INTEGER, turn_count INTEGER, quality_score REAL, status TEXT,
      created_at TEXT NOT NULL, updated_at TEXT)`)
    database.exec(`CREATE TABLE IF NOT EXISTS speaker_suggestions (
      id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, transcript_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('identity','merge','mixed','backstop')),
      target_label TEXT, target_label_2 TEXT, contact_id TEXT, score REAL, rank INTEGER, rationale TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','accepted','dismissed','expired')) DEFAULT 'pending',
      created_at TEXT NOT NULL, resolved_at TEXT)`)

    // (c) recording_speakers.source CHECK rebuild (sql.js can't ALTER a CHECK — table-rebuild, cf. MIGRATIONS[24])
    database.exec(`CREATE TABLE IF NOT EXISTS recording_speakers_new (
      recording_id TEXT NOT NULL, file_label TEXT NOT NULL, contact_id TEXT, confidence REAL,
      source TEXT NOT NULL CHECK(source IN ('user','auto','confirmed','self_auto','suggestion_confirmed')) DEFAULT 'user',
      created_at TEXT NOT NULL, PRIMARY KEY (recording_id, file_label))`)
    database.exec(`INSERT OR IGNORE INTO recording_speakers_new
      SELECT recording_id, file_label, contact_id, confidence, source, created_at FROM recording_speakers`)
    database.exec('DROP TABLE IF EXISTS recording_speakers')
    database.exec('ALTER TABLE recording_speakers_new RENAME TO recording_speakers')

    // voiceprints created_from CHECK rebuild (sql.js can't ALTER-ADD a CHECK; make the upgraded
    // shape identical to the fresh SCHEMA — cf. the recording_speakers rebuild above). No index
    // on voiceprints, so none to recreate.
    database.exec(`CREATE TABLE IF NOT EXISTS voiceprints_new (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      dim INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      created_at TEXT NOT NULL,
      source_recording_id TEXT,
      source_label TEXT,
      clean_speech_ms INTEGER,
      quality_score REAL,
      model_version INTEGER DEFAULT 1,
      created_from TEXT CHECK(created_from IN ('manual','confirmed','self','import')) DEFAULT 'manual',
      disabled_at TEXT,
      superseded_by TEXT)`)
    database.exec(`INSERT OR IGNORE INTO voiceprints_new
      (id, contact_id, model_id, dim, embedding, created_at)
      SELECT id, contact_id, model_id, dim, embedding, created_at FROM voiceprints`)
    database.exec('DROP TABLE IF EXISTS voiceprints')
    database.exec('ALTER TABLE voiceprints_new RENAME TO voiceprints')

    console.log('Migration v27 complete')
  },

  28: () => {
    // v28: Voice Library Phase 2B (spec 2026-06-19 §5). speaker_suggestions gets a
    // diarization_run_id column so suggestions can be scoped to the transcript run
    // that produced them (re-transcribe invalidation + dismissal scoping).
    console.log('Running migration to schema v28: speaker_suggestions diarization_run_id')
    const database = getDatabase()

    const cols = (database.pragma('table_info(speaker_suggestions)') as Array<{ name: string }>).map(col => col.name)
    if (!cols.includes('diarization_run_id')) {
      try {
        database.exec('ALTER TABLE speaker_suggestions ADD COLUMN diarization_run_id TEXT')
        console.log('[Migration v28] Added diarization_run_id to speaker_suggestions')
      } catch (e) {
        console.warn('[Migration v28] ALTER failed:', e)
      }
    } else {
      console.log('[Migration v28] diarization_run_id already present')
    }

    console.log('Migration v28 complete')
  },

  29: () => {
    // v29: Voice Library Phase 2B cross-contact merge support. speaker_suggestions gets
    // contact_id_2 so merge suggestions can name the second contact for conflict warnings.
    console.log('Running migration to schema v29: speaker_suggestions contact_id_2')
    const database = getDatabase()

    const cols = (database.pragma('table_info(speaker_suggestions)') as Array<{ name: string }>).map(col => col.name)
    if (!cols.includes('contact_id_2')) {
      try {
        database.exec('ALTER TABLE speaker_suggestions ADD COLUMN contact_id_2 TEXT')
        console.log('[Migration v29] Added contact_id_2 to speaker_suggestions')
      } catch (e) {
        console.warn('[Migration v29] ALTER failed:', e)
      }
    } else {
      console.log('[Migration v29] contact_id_2 already present')
    }

    console.log('Migration v29 complete')
  },

  30: () => {
    // v30: Voice Library Phase 2C — conservative static speaker_options + solo handling +
    // diarization-run instrumentation. C owns diarization_runs and transcripts.diarization_run_id.
    console.log('Running migration to schema v30: diarization_runs instrumentation')
    const database = getDatabase()

    database.exec(`CREATE TABLE IF NOT EXISTS diarization_runs (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL,
      transcript_id TEXT,
      provider TEXT NOT NULL,
      model TEXT,
      options_min INTEGER,
      options_max INTEGER,
      options_sent_json TEXT,
      label_count INTEGER NOT NULL,
      is_solo INTEGER NOT NULL DEFAULT 0,
      solo_reason TEXT,
      failure_reason TEXT,
      duration_ms INTEGER,
      policy_version INTEGER,
      created_at TEXT NOT NULL
    )`)
    database.exec(`CREATE INDEX IF NOT EXISTS idx_diar_runs_recording ON diarization_runs(recording_id, created_at)`)

    const cols = (database.pragma('table_info(transcripts)') as Array<{ name: string }>).map(col => col.name)
    if (!cols.includes('diarization_run_id')) {
      try {
        database.exec('ALTER TABLE transcripts ADD COLUMN diarization_run_id TEXT')
        console.log('[Migration v30] Added diarization_run_id to transcripts')
      } catch (e) {
        console.warn('[Migration v30] ALTER failed:', e)
      }
    } else {
      console.log('[Migration v30] diarization_run_id already present')
    }

    console.log('Migration v30 complete')
  },

  31: () => {
    // v31: Smart Labels — drop the CHECK constraint on knowledge_captures.category so
    // user-defined labels (AppConfig.labels.items) are storable. App-layer validation
    // (the sole writer) replaces the dropped CHECK.
    //
    // knowledge_captures is a CENTRAL FK-parent with CASCADE children (transcripts,
    // action-items, embeddings, conversation-context). SQLite can't drop a CHECK in
    // place, so we use the existing *_new + copy + RENAME rebuild pattern. FK enforcement
    // is OFF (no PRAGMA foreign_keys=ON anywhere — see migration v20 contacts rebuild),
    // and every parent id is preserved verbatim by the copy, so children stay valid and
    // CASCADE relationships remain intact. Columns are listed EXPLICITLY (not SELECT *)
    // so the copy is robust to column-order drift from ALTER-based structural repair.
    console.log('Running migration to schema v31: drop knowledge_captures.category CHECK')
    const database = getDatabase()

    try {
      const tableInfo = database.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_captures'"
      ).get() as { sql: string } | undefined
      const createSql = tableInfo?.sql ?? ''

      // Idempotent: only rebuild if the category CHECK is still present.
      if (createSql.includes("category IN ('meeting'") || /category[^,]*CHECK/i.test(createSql)) {
        const cols = `
          id, title, summary, category, status,
          quality_rating, quality_confidence, quality_assessed_at,
          storage_tier, retention_days, expires_at,
          meeting_id, correlation_confidence, correlation_method,
          source_recording_id,
          captured_at, created_at, updated_at, deleted_at
        `.replace(/\s+/g, ' ').trim()

        database.exec(`
          CREATE TABLE knowledge_captures_new (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            summary TEXT,
            category TEXT DEFAULT 'meeting',
            status TEXT CHECK(status IN ('processing', 'ready', 'enriched')) DEFAULT 'ready',
            quality_rating TEXT CHECK(quality_rating IN ('valuable', 'archived', 'low-value', 'garbage', 'unrated')) DEFAULT 'unrated',
            quality_confidence REAL,
            quality_assessed_at TEXT,
            storage_tier TEXT CHECK(storage_tier IN ('hot', 'cold', 'expiring', 'deleted')) DEFAULT 'hot',
            retention_days INTEGER,
            expires_at TEXT,
            meeting_id TEXT,
            correlation_confidence REAL,
            correlation_method TEXT,
            source_recording_id TEXT,
            captured_at TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            deleted_at TEXT,
            FOREIGN KEY (meeting_id) REFERENCES meetings(id),
            FOREIGN KEY (source_recording_id) REFERENCES recordings(id)
          )
        `)
        // Explicit column list both sides → preserves every row + its category verbatim.
        database.exec(`INSERT INTO knowledge_captures_new (${cols}) SELECT ${cols} FROM knowledge_captures`)
        database.exec('DROP TABLE knowledge_captures')
        database.exec('ALTER TABLE knowledge_captures_new RENAME TO knowledge_captures')
        console.log('[Migration v31] knowledge_captures.category CHECK removed (rows preserved)')
      } else {
        console.log('[Migration v31] category CHECK already absent — no rebuild needed')
      }

      // Recreate ALL indexes the table rebuild dropped (DROP TABLE drops its indexes).
      database.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_captures_category ON knowledge_captures(category)')
      database.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_captures_quality ON knowledge_captures(quality_rating)')
      database.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_captures_status ON knowledge_captures(status)')
      database.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_title ON knowledge_captures(title)')
      database.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_summary ON knowledge_captures(summary)')
    } catch (e) {
      console.warn('[Migration v31] CHECK-drop rebuild failed:', e)
    }

    console.log('Migration v31 complete')
  }
  ,

  32: () => {
    // v32: persist mixed-detection per-window embeddings (spec 2026-06-21). Additive
    // only — new table + index, no FK rebuild, no CHECK changes. Idempotent CREATEs so
    // a fresh DB (already created by the canonical SCHEMA) and an upgraded DB converge.
    console.log('Running migration to schema v32: recording_window_embeddings')
    const database = getDatabase()
    database.exec(`CREATE TABLE IF NOT EXISTS recording_window_embeddings (
      id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, transcript_id TEXT, diarization_run_id TEXT,
      file_label TEXT NOT NULL, window_index INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      model_id TEXT NOT NULL, model_version INTEGER NOT NULL DEFAULT 1, dim INTEGER NOT NULL,
      embedding BLOB NOT NULL, created_at TEXT NOT NULL)`)
    database.exec(`CREATE INDEX IF NOT EXISTS idx_rwe_recording_label
      ON recording_window_embeddings(recording_id, file_label)`)
    console.log('Migration v32 complete')
  },

  33: () => {
    // v33: Summarization templates — 2 tables + indexes + 3 transcripts columns + seeded Default.
    console.log('Running migration to schema v33: summarization templates')
    const database = getDatabase()
    database.exec(`CREATE TABLE IF NOT EXISTS summarization_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL, example_triggers TEXT,
      is_default INTEGER NOT NULL DEFAULT 0, is_builtin INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
    database.exec(`CREATE INDEX IF NOT EXISTS idx_summ_templates_enabled ON summarization_templates(enabled, is_builtin)`)
    database.exec(`CREATE TABLE IF NOT EXISTS transcript_template_runs (
      id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, template_id TEXT,
      selection_kind TEXT NOT NULL, selection_confidence REAL NOT NULL DEFAULT 0,
      runnerup_confidence REAL, candidate_scores_json TEXT, selection_reason TEXT,
      selector_provider TEXT, selector_model TEXT, selector_elapsed_ms INTEGER,
      full_text_hash TEXT, suggested_template_json TEXT, applied_instructions_hash TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
    database.exec(`CREATE INDEX IF NOT EXISTS idx_template_runs_recording ON transcript_template_runs(recording_id, created_at DESC)`)
    for (const sql of [
      'ALTER TABLE transcripts ADD COLUMN summarization_template_id TEXT',
      'ALTER TABLE transcripts ADD COLUMN summarization_template_name TEXT',
      'ALTER TABLE transcripts ADD COLUMN summarization_template_hash TEXT'
    ]) {
      try { database.exec(sql) } catch { console.log(`Column may already exist: ${sql}`) }
    }
    database.exec(`INSERT OR IGNORE INTO summarization_templates
      (id, name, description, instructions, is_default, is_builtin, enabled)
      VALUES ('builtin-default', 'Default', 'Base summarization (no extra emphasis).', '', 0, 1, 1)`)
    console.log('Migration v33 complete')
  },

  34: () => {
    // v34: hosted-app access control (invite list). Additive — new table only.
    console.log('Running migration to schema v34: allowed_users')
    getDatabase().exec(`CREATE TABLE IF NOT EXISTS allowed_users (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
      invited_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
    console.log('Migration v34 complete')
  },

}

function runMigrations(currentVersion: number): void {
  for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v]
    if (migration) {
      console.log(`Running migration to v${v}...`)
      migration()
    }
    // Record the migration
    getDatabase().prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(v)
  }
}

/**
 * Safe database initialization.
 * Performs a 4-phase boot sequence:
 * 1. Core Tables: Ensure basic table structure exists.
 * 2. Structural Repair: Force-add missing columns required by the code.
 * 3. Migrations: Handle version-specific data transformations.
 * 4. Full Schema: Apply indexes and constraints safely.
 */
export async function initializeDatabase(): Promise<void> {
  dbPath = getDatabasePath()

  try {
    db = new Database(dbPath)            // opens existing file or creates a new one
    db.pragma('journal_mode = WAL')      // concurrent readers + one safe writer
    db.pragma('foreign_keys = OFF')      // foreign_keys kept OFF to match the prior sql.js runtime (SQLite/sql.js default FK enforcement off;
                                         // the original code never enabled it). NOTE: better-sqlite3 defaults FK ON, so this explicit OFF is
                                         // required for faithful behavior. Rebuild-style migrations (v31, v20: DROP TABLE + rename) RELY on
                                         // FK being off — with FK on they cascade-delete ON DELETE CASCADE children. If FK enforcement is ever
                                         // enabled deliberately, those rebuild migrations must each be wrapped in their own foreign_keys=OFF/ON.

    const database = getDatabase()
    const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0)

    // --- PHASE 1: CORE TABLES ---
    console.log('[Database] Phase 1: Ensuring core tables exist...')
    for (const sql of statements) {
      // Match CREATE TABLE robustly regardless of leading/inline comments. Every SCHEMA
      // statement is comment-prefixed, so a plain startsWith('CREATE TABLE') matched NONE —
      // leaving Phase 1 to create zero tables and Phases 2/3 to crash on a fresh DB
      // (first-launch crash). `includes` can never miss a CREATE TABLE and also tolerates
      // block comments / CRLF that a leading-comment strip would not.
      if (sql.toUpperCase().includes('CREATE TABLE')) {
        try {
          database.exec(sql)
        } catch (e) {
          console.warn(`[Database] Table creation warning: ${(e as Error).message}`)
        }
      }
    }

    // --- PHASE 2: MANDATORY STRUCTURAL REPAIR ---
    // This runs on EVERY boot to ensure parity between code and disk.
    console.log('[Database] Phase 2: Aligning table structures...')
    
    // Repair Recordings
    const recCols = (database.pragma('table_info(recordings)') as Array<{ name: string }>).map(c => c.name)
    const recordingRepairs = [
      { name: 'migrated_to_capture_id', def: "TEXT" },
      { name: 'migration_status', def: "TEXT CHECK(migration_status IN ('pending', 'migrated', 'skipped', 'error')) DEFAULT 'pending'" },
      { name: 'migrated_at', def: "TEXT" }
    ]
    for (const col of recordingRepairs) {
      if (!recCols.includes(col.name)) {
        console.log(`[Database] Repairing recordings: adding ${col.name}`)
        try { database.exec(`ALTER TABLE recordings ADD COLUMN ${col.name} ${col.def}`) } catch {}
      }
    }

    // Repair Knowledge Captures
    const capCols = (database.pragma('table_info(knowledge_captures)') as Array<{ name: string }>).map(c => c.name)
    const knowledgeRepairs = [
      // v31: relaxed — no CHECK (Smart Labels are user-defined; validated in app layer)
      { name: 'category', def: "category TEXT DEFAULT 'meeting'" },
      { name: 'status', def: "status TEXT CHECK(status IN ('processing', 'ready', 'enriched')) DEFAULT 'ready'" },
      { name: 'quality_rating', def: "quality_rating TEXT CHECK(quality_rating IN ('valuable', 'archived', 'low-value', 'garbage', 'unrated')) DEFAULT 'unrated'" },
      { name: 'quality_confidence', def: "quality_confidence REAL" },
      { name: 'quality_assessed_at', def: "quality_assessed_at TEXT" },
      { name: 'storage_tier', def: "storage_tier TEXT CHECK(storage_tier IN ('hot', 'cold', 'expiring', 'deleted')) DEFAULT 'hot'" },
      { name: 'retention_days', def: "retention_days INTEGER" },
      { name: 'expires_at', def: "expires_at TEXT" },
      { name: 'meeting_id', def: "meeting_id TEXT REFERENCES meetings(id)" },
      { name: 'correlation_confidence', def: "correlation_confidence REAL" },
      { name: 'correlation_method', def: "correlation_method TEXT" },
      { name: 'source_recording_id', def: "source_recording_id TEXT REFERENCES recordings(id)" }
    ]
    for (const col of knowledgeRepairs) {
      if (!capCols.includes(col.name)) {
        console.log(`[Database] Repairing knowledge_captures: adding ${col.name}`)
        try { database.exec(`ALTER TABLE knowledge_captures ADD COLUMN ${col.def}`) } catch {}
      }
    }

    // Repair transcription_queue (spec-014: retry persistence and real-time progress)
    const queueCols = (database.pragma('table_info(transcription_queue)') as Array<{ name: string }>).map(c => c.name)
    if (queueCols.length > 0) {
      const queueRepairs = [
        { name: 'retry_count', def: 'INTEGER DEFAULT 0' },
        { name: 'progress', def: 'INTEGER DEFAULT 0' }
      ]
      for (const col of queueRepairs) {
        if (!queueCols.includes(col.name)) {
          console.log(`[Database] Repairing transcription_queue: adding ${col.name}`)
          try { database.exec(`ALTER TABLE transcription_queue ADD COLUMN ${col.name} ${col.def}`) } catch {}
        }
      }
    }

    // Repair chat_messages (AI-15: columns referenced by assistant mapper)
    const chatCols = (database.pragma('table_info(chat_messages)') as Array<{ name: string }>).map(c => c.name)
    if (chatCols.length > 0) {
      const chatRepairs = [
        { name: 'edited_at', def: 'TEXT' },
        { name: 'original_content', def: 'TEXT' },
        { name: 'created_output_id', def: 'TEXT' },
        { name: 'saved_as_insight_id', def: 'TEXT' }
      ]
      for (const col of chatRepairs) {
        if (!chatCols.includes(col.name)) {
          console.log(`[Database] Repairing chat_messages: adding ${col.name}`)
          try { database.exec(`ALTER TABLE chat_messages ADD COLUMN ${col.name} ${col.def}`) } catch {}
        }
      }
    }

    // Repair speaker_suggestions (v28: diarization_run_id; v29: contact_id_2)
    const suggestionCols = (database.pragma('table_info(speaker_suggestions)') as Array<{ name: string }>).map(c => c.name)
    if (suggestionCols.length > 0) {
      if (!suggestionCols.includes('diarization_run_id')) {
        console.log('[Database] Repairing speaker_suggestions: adding diarization_run_id')
        try { database.exec('ALTER TABLE speaker_suggestions ADD COLUMN diarization_run_id TEXT') } catch {}
      }
      if (!suggestionCols.includes('contact_id_2')) {
        console.log('[Database] Repairing speaker_suggestions: adding contact_id_2')
        try { database.exec('ALTER TABLE speaker_suggestions ADD COLUMN contact_id_2 TEXT') } catch {}
      }
    }

    // --- PHASE 3: VERSIONED MIGRATIONS ---
    const versionRow = database.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined
    const currentVersion = versionRow?.version ?? 0

    if (currentVersion < SCHEMA_VERSION) {
      console.log(`[Database] Phase 3: Migrating v${currentVersion} -> v${SCHEMA_VERSION}`)
      runMigrations(currentVersion)
    } else if (currentVersion === 0) {
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
    }

    // Structural self-heal for diarization instrumentation (v30) — AFTER migrations
    // so a fresh DB already has the table and this is a no-op, while a repaired/restored
    // DB converges even if MIGRATIONS[30] was skipped.
    ensureDiarizationSchema()

    // --- PHASE 4: FULL SCHEMA (INDEXES & CONSTRAINTS) ---
    console.log('[Database] Phase 4: Finalizing schema and indexes...')
    for (const sql of statements) {
      try {
        database.exec(sql)
      } catch (e) {
        // Log but don't crash the boot if a statement (like an existing index) fails
        const msg = (e as Error).message
        if (!msg.includes('already exists') && !msg.includes('duplicate column name')) {
          console.warn(`[Database] Schema statement warning: ${msg}`)
        }
      }
    }

    saveDatabase()
    console.log(`[Database] Initialization complete (schema v${SCHEMA_VERSION})`)
  } catch (error) {
    console.error('[Database] FATAL initialization error:', error)
    throw error
  }
}

export function saveDatabase(): void {
  // No-op: better-sqlite3 persists synchronously to disk (WAL). Retained so the
  // many existing callers across services keep compiling without edits.
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db
}

/**
 * Structural self-heal for the diarization_runs instrumentation table and the
 * transcripts.diarization_run_id FK column (Voice Library Phase 2C, v30).
 *
 * Runs on every boot so freshly-initialized DBs (Phase 1/4) and older restored
 * backups converge. All statements are idempotent and log only — failures are
 * swallowed to avoid blocking app launch.
 */
export function ensureDiarizationSchema(): void {
  const database = getDatabase()
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS diarization_runs (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL,
      transcript_id TEXT,
      provider TEXT NOT NULL,
      model TEXT,
      options_min INTEGER,
      options_max INTEGER,
      options_sent_json TEXT,
      label_count INTEGER NOT NULL,
      is_solo INTEGER NOT NULL DEFAULT 0,
      solo_reason TEXT,
      failure_reason TEXT,
      duration_ms INTEGER,
      policy_version INTEGER,
      created_at TEXT NOT NULL
    )`)
    database.exec(`CREATE INDEX IF NOT EXISTS idx_diar_runs_recording ON diarization_runs(recording_id, created_at)`)

    const cols = (database.pragma('table_info(transcripts)') as Array<{ name: string }>).map(c => c.name)
    if (!cols.includes('diarization_run_id')) {
      try {
        database.exec('ALTER TABLE transcripts ADD COLUMN diarization_run_id TEXT')
        console.log('[ensureDiarizationSchema] Added diarization_run_id to transcripts')
      } catch (e) {
        console.warn('[ensureDiarizationSchema] ALTER failed:', e)
      }
    }
  } catch (e) {
    console.warn('[ensureDiarizationSchema] Schema repair failed:', e)
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

/**
 * Update knowledge_capture title based on title_suggestion
 * Only updates if the current title matches the filename pattern
 */
export function updateKnowledgeCaptureTitle(recordingId: string, titleSuggestion: string): void {
  try {
    // Get the recording to find the knowledge_capture
    const recording = getRecordingById(recordingId)
    if (!recording) return

    // Get the knowledge capture via migrated_to_capture_id
    const captureId = recording.migrated_to_capture_id
    if (!captureId) return

    // Get the knowledge capture
    const capture = queryOne<{ id: string; title: string }>(
      'SELECT id, title FROM knowledge_captures WHERE id = ?',
      [captureId]
    )
    if (!capture) return

    // Only update if title looks like a filename (contains .hda or similar)
    if (capture.title.includes('.') || capture.title === 'Untitled') {
      run(
        'UPDATE knowledge_captures SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [titleSuggestion, captureId]
      )
      console.log(`Updated knowledge_capture title: "${capture.title}" -> "${titleSuggestion}"`)
    }
  } catch (error) {
    console.warn('Failed to update knowledge_capture title:', error)
  }
}

// Generic query helpers
export function queryAll<T>(sql: string, params: any[] = []): T[] {
  return getDatabase().prepare(sql).all(...params) as T[]
}

export function queryOne<T>(sql: string, params: any[] = []): T | undefined {
  return getDatabase().prepare(sql).get(...params) as T | undefined
}

export function run(sql: string, params: any[] = []): void {
  getDatabase().prepare(sql).run(...params)
}

// Retained for API compatibility. With better-sqlite3 there is no per-statement
// export/save, so this is identical to run(); callers inside runInTransaction()
// may keep using it.
export function runNoSave(sql: string, params: any[] = []): void {
  getDatabase().prepare(sql).run(...params)
}

/**
 * Execute a function within a database transaction.
 * Automatically handles BEGIN/COMMIT/ROLLBACK.
 * Use this for operations that must be atomic (all-or-nothing).
 */
export function runInTransaction<T>(fn: () => T): T {
  const database = getDatabase()
  database.exec('BEGIN')
  try {
    const result = fn()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function runMany(sql: string, items: any[][]): void {
  const database = getDatabase()
  const stmt = database.prepare(sql)
  const tx = database.transaction((rows: any[][]) => {
    for (const row of rows) stmt.run(...row)
  })
  tx(items)
}

/**
 * Batch upsert multiple meetings atomically.
 * Used by calendar sync to ensure all-or-nothing behavior.
 * If any meeting fails to upsert, the entire batch is rolled back.
 */
export function upsertMeetingsBatch(meetings: Omit<Meeting, 'created_at' | 'updated_at'>[]): void {
  if (meetings.length === 0) return

  runInTransaction(() => {
    for (const meeting of meetings) {
      const existing = getMeetingById(meeting.id)

      if (existing) {
        runNoSave(
          `UPDATE meetings SET
            subject = ?, start_time = ?, end_time = ?, location = ?,
            organizer_name = ?, organizer_email = ?, attendees = ?,
            description = ?, is_recurring = ?, recurrence_rule = ?,
            meeting_url = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
          [
            meeting.subject,
            meeting.start_time,
            meeting.end_time,
            meeting.location ?? null,
            meeting.organizer_name ?? null,
            meeting.organizer_email ?? null,
            meeting.attendees ?? null,
            meeting.description ?? null,
            meeting.is_recurring,
            meeting.recurrence_rule ?? null,
            meeting.meeting_url ?? null,
            meeting.id
          ]
        )
      } else {
        runNoSave(
          `INSERT INTO meetings (id, subject, start_time, end_time, location, organizer_name,
            organizer_email, attendees, description, is_recurring, recurrence_rule, meeting_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            meeting.id,
            meeting.subject,
            meeting.start_time,
            meeting.end_time,
            meeting.location ?? null,
            meeting.organizer_name ?? null,
            meeting.organizer_email ?? null,
            meeting.attendees ?? null,
            meeting.description ?? null,
            meeting.is_recurring,
            meeting.recurrence_rule ?? null,
            meeting.meeting_url ?? null
          ]
        )
      }
      // Extract contacts (uses runNoSave internally)
      extractContactsFromMeetingDataInternal(meeting)
    }
  })
}

// Meeting queries
export interface Meeting {
  id: string
  subject: string
  start_time: string
  end_time: string
  location: string | null
  organizer_name: string | null
  organizer_email: string | null
  attendees: string | null
  description: string | null
  is_recurring: number
  recurrence_rule: string | null
  meeting_url: string | null
  created_at: string
  updated_at: string
}

export function getMeetings(startDate?: string, endDate?: string): Meeting[] {
  let sql = 'SELECT * FROM meetings'
  const params: string[] = []

  if (startDate && endDate) {
    sql += ' WHERE start_time >= ? AND start_time <= ?'
    params.push(startDate, endDate)
  } else if (startDate) {
    sql += ' WHERE start_time >= ?'
    params.push(startDate)
  } else if (endDate) {
    sql += ' WHERE start_time <= ?'
    params.push(endDate)
  }

  sql += ' ORDER BY start_time ASC'

  return queryAll<Meeting>(sql, params)
}

export function getMeetingById(id: string): Meeting | undefined {
  return queryOne<Meeting>('SELECT * FROM meetings WHERE id = ?', [id])
}

export function updateMeeting(id: string, updates: Partial<Pick<Meeting, 'subject' | 'start_time' | 'end_time' | 'location' | 'description'>>): void {
  const fields: string[] = []
  const params: unknown[] = []

  if (updates.subject !== undefined) { fields.push('subject = ?'); params.push(updates.subject); }
  if (updates.start_time !== undefined) { fields.push('start_time = ?'); params.push(updates.start_time); }
  if (updates.end_time !== undefined) { fields.push('end_time = ?'); params.push(updates.end_time); }
  if (updates.location !== undefined) { fields.push('location = ?'); params.push(updates.location); }
  if (updates.description !== undefined) { fields.push('description = ?'); params.push(updates.description); }

  if (fields.length === 0) return

  fields.push('updated_at = ?')
  params.push(new Date().toISOString())
  params.push(id)

  run(`UPDATE meetings SET ${fields.join(', ')} WHERE id = ?`, params)
}

// ──────────────────────────────────────────────────────────────────────────────
// Hosted-app access control — allowed_users (v34)
// ──────────────────────────────────────────────────────────────────────────────

export interface AllowedUser {
  email: string
  role: 'admin' | 'member'
  status: 'active' | 'revoked'
  invited_by: string | null
  created_at: string
}

export function getAllowedUser(email: string): AllowedUser | undefined {
  return queryOne<AllowedUser>('SELECT * FROM allowed_users WHERE email = ?', [email])
}

export function listAllowedUsers(): AllowedUser[] {
  return queryAll<AllowedUser>('SELECT * FROM allowed_users ORDER BY created_at ASC')
}

export function countActiveAdmins(): number {
  return queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM allowed_users WHERE role = 'admin' AND status = 'active'"
  )?.n ?? 0
}

export function upsertAllowedUser(input: { email: string; role?: 'admin' | 'member'; invitedBy?: string | null }): void {
  run(
    `INSERT INTO allowed_users (email, role, status, invited_by)
     VALUES (?, ?, 'active', ?)
     ON CONFLICT(email) DO UPDATE SET role = excluded.role, invited_by = COALESCE(excluded.invited_by, allowed_users.invited_by)`,
    [input.email, input.role ?? 'member', input.invitedBy ?? null]
  )
}

export function setAllowedUserStatus(email: string, status: 'active' | 'revoked'): void {
  run('UPDATE allowed_users SET status = ? WHERE email = ?', [status, email])
}

export function ensureBootstrapAdmin(adminEmail: string): void {
  run(
    `INSERT INTO allowed_users (email, role, status, invited_by)
     VALUES (?, 'admin', 'active', NULL)
     ON CONFLICT(email) DO UPDATE SET role = 'admin', status = 'active'`,
    [adminEmail]
  )
}

// ──────────────────────────────────────────────────────────────────────────────

/**
 * Batch get meetings by IDs - avoids N+1 query problem
 */
export function getMeetingsByIds(meetingIds: string[]): Map<string, Meeting> {
  if (meetingIds.length === 0) return new Map()

  // Remove duplicates and nulls
  const uniqueIds = [...new Set(meetingIds.filter(Boolean))]
  if (uniqueIds.length === 0) return new Map()

  const results = new Map<string, Meeting>()
  const chunkSize = 100

  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const meetings = queryAll<Meeting>(
      `SELECT * FROM meetings WHERE id IN (${placeholders})`,
      chunk
    )

    for (const meeting of meetings) {
      results.set(meeting.id, meeting)
    }
  }

  return results
}

/**
 * Upsert a meeting and its associated contacts atomically.
 * All operations are wrapped in a single transaction for data integrity.
 */
export function upsertMeeting(meeting: Omit<Meeting, 'created_at' | 'updated_at'>): void {
  runInTransaction(() => {
    // Check if meeting exists
    const existing = getMeetingById(meeting.id)

    if (existing) {
      runNoSave(
        `UPDATE meetings SET
          subject = ?, start_time = ?, end_time = ?, location = ?,
          organizer_name = ?, organizer_email = ?, attendees = ?,
          description = ?, is_recurring = ?, recurrence_rule = ?,
          meeting_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [
          meeting.subject,
          meeting.start_time,
          meeting.end_time,
          meeting.location ?? null,
          meeting.organizer_name ?? null,
          meeting.organizer_email ?? null,
          meeting.attendees ?? null,
          meeting.description ?? null,
          meeting.is_recurring,
          meeting.recurrence_rule ?? null,
          meeting.meeting_url ?? null,
          meeting.id
        ]
      )
    } else {
      runNoSave(
        `INSERT INTO meetings (id, subject, start_time, end_time, location, organizer_name,
          organizer_email, attendees, description, is_recurring, recurrence_rule, meeting_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meeting.id,
          meeting.subject,
          meeting.start_time,
          meeting.end_time,
          meeting.location ?? null,
          meeting.organizer_name ?? null,
          meeting.organizer_email ?? null,
          meeting.attendees ?? null,
          meeting.description ?? null,
          meeting.is_recurring,
          meeting.recurrence_rule ?? null,
          meeting.meeting_url ?? null
        ]
      )
    }
    // Extract contacts from meeting attendees (uses runNoSave internally)
    extractContactsFromMeetingDataInternal(meeting)
  })
}

/**
 * Extract contacts from meeting attendees and organizer.
 * Internal version using runNoSave - must be called within a transaction.
 * Uses batch lookup to avoid N+1 query problem.
 */
function extractContactsFromMeetingDataInternal(meeting: Omit<Meeting, 'created_at' | 'updated_at'>): void {
  // Collect all emails for batch lookup
  const emailsToLookup: string[] = []

  if (meeting.organizer_email) {
    emailsToLookup.push(meeting.organizer_email)
  }

  let attendees: Array<{ name?: string; email?: string }> = []
  if (meeting.attendees) {
    try {
      attendees = JSON.parse(meeting.attendees)
      for (const attendee of attendees) {
        if (attendee.email) {
          emailsToLookup.push(attendee.email)
        }
      }
    } catch {
      // Invalid JSON, skip attendees
    }
  }

  // Single batch query for all contacts
  const existingContacts = getContactsByEmails(emailsToLookup)

  // Handle organizer
  if (meeting.organizer_email || meeting.organizer_name) {
    const existing = meeting.organizer_email ? existingContacts.get(meeting.organizer_email) : undefined
    let contactId

    if (existing) {
      runNoSave(`UPDATE contacts SET name = COALESCE(?, name), last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`,
        [meeting.organizer_name, meeting.start_time, existing.id])
      contactId = existing.id
    } else {
      contactId = crypto.randomUUID()
      runNoSave(`INSERT INTO contacts (id, name, email, first_seen_at, last_seen_at, meeting_count) VALUES (?, ?, ?, ?, ?, 1)`,
        [contactId, meeting.organizer_name || 'Unknown', meeting.organizer_email || null, meeting.start_time, meeting.start_time])
    }
    runNoSave('INSERT OR IGNORE INTO meeting_contacts (meeting_id, contact_id, role) VALUES (?, ?, ?)',
      [meeting.id, contactId, 'organizer'])
  }

  // Handle attendees (already parsed above)
  for (const attendee of attendees) {
    if (!attendee.email && !attendee.name) continue

    const existing = attendee.email ? existingContacts.get(attendee.email) : undefined
    let contactId

    if (existing) {
      runNoSave(`UPDATE contacts SET name = COALESCE(?, name), last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`,
        [attendee.name, meeting.start_time, existing.id])
      contactId = existing.id
    } else {
      contactId = crypto.randomUUID()
      runNoSave(`INSERT INTO contacts (id, name, email, first_seen_at, last_seen_at, meeting_count) VALUES (?, ?, ?, ?, ?, 1)`,
        [contactId, attendee.name || attendee.email || 'Unknown', attendee.email || null, meeting.start_time, meeting.start_time])
    }
    runNoSave('INSERT OR IGNORE INTO meeting_contacts (meeting_id, contact_id, role) VALUES (?, ?, ?)',
      [meeting.id, contactId, 'attendee'])
  }
}

// Recording queries
export interface Recording {
  id: string
  filename: string
  original_filename?: string
  file_path: string | null  // NULL if not stored locally
  file_size?: number
  duration_seconds?: number
  date_recorded: string
  meeting_id?: string
  correlation_confidence?: number
  correlation_method?: string
  status: string  // Legacy field for backwards compatibility
  created_at: string
  // New lifecycle fields
  location: 'device-only' | 'local-only' | 'both' | 'deleted'
  transcription_status: 'none' | 'pending' | 'processing' | 'complete' | 'error'
  on_device: number
  device_last_seen?: string
  on_local: number
  source: 'hidock' | 'import' | 'external' | 'upload'
  is_imported: number
  storage_tier?: 'hot' | 'warm' | 'cold' | 'archive' | null
  // Migration fields (for Phase 0 -> Phase 1 migration)
  migration_status?: 'pending' | 'migrated' | 'skipped' | 'error' | null
  migrated_to_capture_id?: string | null
  migrated_at?: string | null
}

export function getRecordings(): Recording[] {
  return queryAll<Recording>('SELECT * FROM recordings ORDER BY date_recorded DESC')
}

export function getRecordingById(id: string): Recording | undefined {
  return queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', [id])
}

/**
 * Look up the knowledge capture that originated from a given recording.
 * Used by voiceprint provenance to show a human-readable source title.
 */
export function getKnowledgeCaptureByRecordingId(
  recordingId: string
): { id: string; title?: string | null } | null | undefined {
  const capture = queryOne<{ id: string; title: string | null }>(
    'SELECT id, title FROM knowledge_captures WHERE source_recording_id = ? LIMIT 1',
    [recordingId]
  )
  return capture ?? null
}

export function getRecordingsForMeeting(meetingId: string): Recording[] {
  return queryAll<Recording>('SELECT * FROM recordings WHERE meeting_id = ?', [meetingId])
}

// Batch get recordings by IDs (avoids N+1 queries)
export function getRecordingsByIds(ids: string[]): Map<string, Recording> {
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const recordings = queryAll<Recording>(
    `SELECT * FROM recordings WHERE id IN (${placeholders})`,
    ids
  )
  const map = new Map<string, Recording>()
  recordings.forEach(r => map.set(r.id, r))
  return map
}


// Get recording by filename (canonical identifier)
export function getRecordingByFilename(filename: string): Recording | undefined {
  return queryOne<Recording>('SELECT * FROM recordings WHERE filename = ?', [filename])
}

// Update recording lifecycle state
export function updateRecordingLifecycle(
  id: string,
  updates: Partial<Pick<Recording, 'location' | 'on_device' | 'on_local' | 'device_last_seen' | 'file_path' | 'transcription_status'>>
): void {
  const setClauses: string[] = []
  const values: unknown[] = []

  if (updates.location !== undefined) {
    setClauses.push('location = ?')
    values.push(updates.location)
  }
  if (updates.on_device !== undefined) {
    setClauses.push('on_device = ?')
    values.push(updates.on_device)
  }
  if (updates.on_local !== undefined) {
    setClauses.push('on_local = ?')
    values.push(updates.on_local)
  }
  if (updates.device_last_seen !== undefined) {
    setClauses.push('device_last_seen = ?')
    values.push(updates.device_last_seen)
  }
  if (updates.file_path !== undefined) {
    setClauses.push('file_path = ?')
    values.push(updates.file_path)
  }
  if (updates.transcription_status !== undefined) {
    setClauses.push('transcription_status = ?')
    values.push(updates.transcription_status)
  }

  if (setClauses.length > 0) {
    values.push(id)
    run(`UPDATE recordings SET ${setClauses.join(', ')} WHERE id = ?`, values)
  }
}

// Upsert recording from device - creates or updates based on filename
export function upsertRecordingFromDevice(deviceFile: {
  filename: string
  size: number
  duration: number
  dateCreated: Date
}): Recording {
  const existing = getRecordingByFilename(deviceFile.filename)
  const now = new Date().toISOString()

  if (existing) {
    // Update device presence and refresh duration from device (may have been calculated incorrectly before)
    const newLocation = existing.on_local ? 'both' : 'device-only'
    run(
      `UPDATE recordings SET on_device = 1, device_last_seen = ?, location = ?, file_size = ?, duration_seconds = ? WHERE id = ?`,
      [now, newLocation, deviceFile.size, deviceFile.duration, existing.id]
    )
    return { ...existing, on_device: 1, device_last_seen: now, location: newLocation as Recording['location'], duration_seconds: deviceFile.duration }
  } else {
    // Create new recording entry
    const id = crypto.randomUUID()
    run(
      `INSERT INTO recordings (id, filename, file_path, file_size, duration_seconds, date_recorded,
        status, location, transcription_status, on_device, device_last_seen, on_local, source, is_imported)
       VALUES (?, ?, NULL, ?, ?, ?, 'none', 'device-only', 'none', 1, ?, 0, 'hidock', 0)`,
      [id, deviceFile.filename, deviceFile.size, deviceFile.duration, deviceFile.dateCreated.toISOString(), now]
    )
    return getRecordingById(id)!
  }
}

// Mark recordings as no longer on device
export function markRecordingsNotOnDevice(presentFilenames: string[]): void {
  if (presentFilenames.length === 0) return

  // Get all recordings marked as on_device
  const onDevice = queryAll<Recording>('SELECT * FROM recordings WHERE on_device = 1')

  for (const rec of onDevice) {
    if (!presentFilenames.includes(rec.filename)) {
      const newLocation = rec.on_local ? 'local-only' : 'deleted'
      updateRecordingLifecycle(rec.id, {
        on_device: 0,
        location: newLocation as Recording['location']
      })
    }
  }
}

// Get all recordings with unified view
export function getAllRecordingsUnified(): Recording[] {
  return queryAll<Recording>(`
    SELECT * FROM recordings
    ORDER BY date_recorded DESC
  `)
}

// Mark recording as downloaded
export function markRecordingDownloaded(filename: string, localPath: string): void {
  const recording = getRecordingByFilename(filename)
  if (recording) {
    const newLocation = recording.on_device ? 'both' : 'local-only'
    updateRecordingLifecycle(recording.id, {
      file_path: localPath,
      on_local: 1,
      location: newLocation as Recording['location']
    })
  }
}

// Delete recording file from local storage (keeps metadata if transcribed)
export function deleteRecordingLocal(id: string): void {
  const recording = getRecordingById(id)
  if (!recording) return

  const newLocation = recording.on_device ? 'device-only' : 'deleted'
  updateRecordingLifecycle(id, {
    file_path: null,
    on_local: 0,
    location: newLocation as Recording['location']
  })
  deleteLabelEmbeddingsForRecording(id)
  deleteWindowEmbeddingsForRecording(id)
}

export function insertRecording(recording: Omit<Recording, 'created_at'>): void {
  run(
    `INSERT INTO recordings (id, filename, original_filename, file_path, file_size,
      duration_seconds, date_recorded, meeting_id, correlation_confidence,
      correlation_method, status,
      location, transcription_status, on_device, device_last_seen, on_local, source, is_imported)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      recording.id,
      recording.filename,
      recording.original_filename ?? null,
      recording.file_path,
      recording.file_size ?? null,
      recording.duration_seconds ?? null,
      recording.date_recorded,
      recording.meeting_id ?? null,
      recording.correlation_confidence ?? null,
      recording.correlation_method ?? null,
      recording.status,
      recording.location ?? 'device-only',
      recording.transcription_status ?? 'none',
      recording.on_device ?? 1,
      recording.device_last_seen ?? null,
      recording.on_local ?? 0,
      recording.source ?? 'hidock',
      recording.is_imported ?? 0
    ]
  )
}

export function updateRecordingStatus(id: string, status: string): void {
  run('UPDATE recordings SET status = ? WHERE id = ?', [status, id])
}

export function updateRecordingTranscriptionStatus(id: string, transcriptionStatus: string): void {
  run('UPDATE recordings SET transcription_status = ? WHERE id = ?', [transcriptionStatus, id])
}

export function linkRecordingToMeeting(
  recordingId: string,
  meetingId: string,
  confidence: number,
  method: string
): void {
  // Update the recording's meeting link
  run(
    `UPDATE recordings SET meeting_id = ?, correlation_confidence = ?, correlation_method = ? WHERE id = ?`,
    [meetingId, confidence, method, recordingId]
  )

  // AUD2-001: Propagate meeting_id to knowledge_captures that reference this recording
  run(
    `UPDATE knowledge_captures
     SET meeting_id = ?,
         correlation_confidence = ?,
         correlation_method = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE source_recording_id = ?
       AND (meeting_id IS NULL OR meeting_id != ?)`,
    [meetingId, confidence, method, recordingId, meetingId]
  )
}

// Transcript queries
export interface Transcript {
  id: string
  recording_id: string
  full_text: string
  language: string
  summary?: string
  action_items?: string
  topics?: string
  key_points?: string
  sentiment?: string
  speakers?: string
  /** JSON-serialized Turn[] (AssemblyAI diarization path; NULL for Whisper/Gemini). */
  turns?: string
  word_count?: number
  transcription_provider?: string
  transcription_model?: string
  title_suggestion?: string
  question_suggestions?: string
  summarization_provider?: string
  summarization_model?: string
  /** FK to diarization_runs.id (Voice Library Phase 2C). */
  diarization_run_id?: string
  /** Live, single-shot summarization-template override (nulled on the Stage-2 write). */
  summarization_template_id?: string | null
  /** Provenance: denormalized template name (survives template delete/rename). */
  summarization_template_name?: string | null
  /** Provenance: hash of the instructions revision that produced the summary. */
  summarization_template_hash?: string | null
  created_at: string
}

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

export function getTranscriptByRecordingId(recordingId: string): Transcript | undefined {
  return queryOne<Transcript>('SELECT * FROM transcripts WHERE recording_id = ?', [recordingId])
}

/**
 * Batch get transcripts by recording IDs - avoids N+1 query problem
 */
export function getTranscriptsByRecordingIds(recordingIds: string[]): Map<string, Transcript> {
  if (recordingIds.length === 0) return new Map()

  // SQLite has a limit on SQL query length, so batch in chunks of 100
  const results = new Map<string, Transcript>()
  const chunkSize = 100

  for (let i = 0; i < recordingIds.length; i += chunkSize) {
    const chunk = recordingIds.slice(i, i + chunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const transcripts = queryAll<Transcript>(
      `SELECT * FROM transcripts WHERE recording_id IN (${placeholders})`,
      chunk
    )

    for (const transcript of transcripts) {
      results.set(transcript.recording_id, transcript)
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Diarization-run instrumentation (Voice Library Phase 2C, v30)
// ---------------------------------------------------------------------------

/** Persist one diarization attempt. The caller mints the run id. */
export function insertDiarizationRun(diarizationRun: DiarizationRun): void {
  run(
    `INSERT INTO diarization_runs (
       id, recording_id, transcript_id, provider, model, options_min, options_max,
       options_sent_json, label_count, is_solo, solo_reason, failure_reason,
       duration_ms, policy_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      diarizationRun.id,
      diarizationRun.recording_id,
      diarizationRun.transcript_id ?? null,
      diarizationRun.provider,
      diarizationRun.model ?? null,
      diarizationRun.options_min ?? null,
      diarizationRun.options_max ?? null,
      diarizationRun.options_sent_json ?? null,
      diarizationRun.label_count,
      diarizationRun.is_solo ? 1 : 0,
      diarizationRun.solo_reason ?? null,
      diarizationRun.failure_reason ?? null,
      diarizationRun.duration_ms ?? null,
      diarizationRun.policy_version ?? null,
      diarizationRun.created_at
    ]
  )
}

export function getLatestDiarizationRun(recordingId: string): DiarizationRun | null {
  return queryOne<DiarizationRun>(
    `SELECT * FROM diarization_runs WHERE recording_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [recordingId]
  ) ?? null
}

export function getDiarizationRunsForRecording(recordingId: string): DiarizationRun[] {
  return queryAll<DiarizationRun>(
    `SELECT * FROM diarization_runs WHERE recording_id = ? ORDER BY created_at DESC, id DESC`,
    [recordingId]
  )
}

// ---------------------------------------------------------------------------
// recording_speakers — per-recording speaker label -> contact mapping (v26, §6.3)
// v1 writes source='user' only. Powers the Speakers panel (D3) and the
// voiceprint capture trigger (D4). Merge/reassign rewrite transcripts.turns in
// D3; these are the row-level primitives.
// ---------------------------------------------------------------------------

export interface RecordingSpeaker {
  recording_id: string
  file_label: string
  contact_id: string | null
  confidence: number | null
  source: 'user' | 'auto' | 'confirmed' | 'self_auto' | 'suggestion_confirmed'
  created_at: string
}

/** Insert or update (PK = recording_id, file_label) a speaker mapping. */
export function upsertRecordingSpeaker(s: {
  recording_id: string
  file_label: string
  contact_id?: string | null
  confidence?: number | null
  source?: 'user' | 'auto' | 'confirmed' | 'self_auto' | 'suggestion_confirmed'
}): void {
  run(
    `INSERT INTO recording_speakers (recording_id, file_label, contact_id, confidence, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(recording_id, file_label) DO UPDATE SET
       contact_id = excluded.contact_id,
       confidence = excluded.confidence,
       source = excluded.source`,
    [
      s.recording_id,
      s.file_label,
      s.contact_id ?? null,
      s.confidence ?? null,
      s.source ?? 'user',
      new Date().toISOString()
    ]
  )
}

/**
 * Persist an edited turns array (merge / per-turn reassign, §6.3, D3-T3).
 *
 * Writes ONLY the `transcripts.turns` column (JSON-serialized). Stage-1 roster
 * (`speakers`/`sentiment`) and all Stage-2 columns are intentionally left intact:
 * merge/reassign mutate which label a turn carries but never re-derive the roster
 * here — the caller (speakers:merge handler) owns the recording_speakers rows, and
 * Stage-2 (summary) must never be clobbered by an edit (single-writer rule).
 */
export function updateTranscriptTurns(recordingId: string, turns: Turn[]): void {
  run('UPDATE transcripts SET turns = ? WHERE recording_id = ?', [JSON.stringify(turns), recordingId])
}

/** All speaker rows for a recording (roster order = insertion order). */
export function getRecordingSpeakers(recordingId: string): RecordingSpeaker[] {
  return queryAll<RecordingSpeaker>(
    'SELECT * FROM recording_speakers WHERE recording_id = ? ORDER BY created_at, file_label',
    [recordingId]
  )
}

/** Delete one label's mapping (merge support, §6.3). */
export function deleteRecordingSpeaker(recordingId: string, fileLabel: string): void {
  run('DELETE FROM recording_speakers WHERE recording_id = ? AND file_label = ?', [recordingId, fileLabel])
}

/** Read a single label's mapping for a recording, or undefined if none exists. */
export function getRecordingSpeaker(recordingId: string, fileLabel: string): RecordingSpeaker | undefined {
  return queryOne<RecordingSpeaker>(
    'SELECT * FROM recording_speakers WHERE recording_id = ? AND file_label = ? LIMIT 1',
    [recordingId, fileLabel]
  )
}

/** Drop all mappings for a recording (re-transcribe, §6.3/§6.8). Returns the
 *  number of rows removed (counted before delete; run() resets sql.js's modified
 *  counter on each statement, so getRowsModified() is unreliable here). */
export function deleteRecordingSpeakersForRecording(recordingId: string): number {
  const before = queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM recording_speakers WHERE recording_id = ?',
    [recordingId]
  )
  run('DELETE FROM recording_speakers WHERE recording_id = ?', [recordingId])
  return before?.n ?? 0
}

// NOTE (auto-pipeline P3, spec §5.3 single-writer rule / P1 carry-note #4):
// the former `insertTranscript` (INSERT OR REPLACE on UNIQUE recording_id) was
// removed. It silently clobbered the Stage-2 stage marker, so any future caller
// would have wiped a completed summary. The only sanctioned transcript writers
// are the stage pair: `upsertTranscriptStage1` (Stage 1, never touches Stage-2
// columns) and `updateTranscriptStage2` (Stage 2, writes the marker atomically).

/**
 * Compute the derived diarization columns from a Turn[] (spec §6.3):
 *  - speakers: distinct speaker roster in first-seen order, e.g. ["A","B"]
 *  - sentiment: per-label dominant (majority) sentiment {label: 'POSITIVE'|...};
 *    ties broken by fixed precedence POSITIVE > NEUTRAL > NEGATIVE
 *    (order-independent — spec §Integration Corrections); {} when no turn
 *    carries a sentiment field.
 * Pure + exported so the persistence behavior is unit-testable in isolation.
 */
export function deriveSpeakerRosterSummary(turns: Turn[]): {
  speakers: string[]
  sentiment: Record<string, 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'>
} {
  const speakers: string[] = []
  // label -> tally of sentiments
  const sentimentsByLabel = new Map<string, Map<'POSITIVE' | 'NEUTRAL' | 'NEGATIVE', number>>()

  for (const turn of turns) {
    if (!speakers.includes(turn.speaker)) speakers.push(turn.speaker)
    if (turn.sentiment) {
      if (!sentimentsByLabel.has(turn.speaker)) {
        sentimentsByLabel.set(turn.speaker, new Map())
      }
      const counts = sentimentsByLabel.get(turn.speaker)!
      counts.set(turn.sentiment, (counts.get(turn.sentiment) ?? 0) + 1)
    }
  }

  const sentiment: Record<string, 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'> = {}
  // Fixed tie-break precedence: POSITIVE > NEUTRAL > NEGATIVE (order-independent)
  const precedence: Array<'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'> = ['POSITIVE', 'NEUTRAL', 'NEGATIVE']
  for (const [label, counts] of sentimentsByLabel) {
    let best: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | undefined
    let bestCount = -1
    for (const s of precedence) {
      const c = counts.get(s) ?? 0
      if (c > bestCount) {
        best = s
        bestCount = c
      }
    }
    if (best !== undefined) sentiment[label] = best
  }

  return { speakers, sentiment }
}

/**
 * Stage 1 write (auto-pipeline spec §5.3): persist ASR output without ever
 * touching Stage-2 (analysis) columns. The conflict target is the UNIQUE
 * recording_id; id keeps the existing `trans_${recordingId}` rule.
 * NOTE: language inserts as NULL when the ASR doesn't supply one (Gemini path) —
 * Stage 2 fills it via COALESCE. The schema DEFAULT 'es' applies only when the
 * column is omitted, which this INSERT never does.
 *
 * When `turns` is supplied (AssemblyAI diarization path), also writes the
 * derived `speakers` roster and `sentiment` roster-summary (spec §6.3, AC1).
 * When `turns` is absent (Whisper/Gemini), those columns are written as NULL
 * (backward-compatible with all pre-diarization callers).
 */
export function upsertTranscriptStage1(t: {
  recording_id: string
  full_text: string
  language?: string
  word_count?: number
  transcription_provider: string
  transcription_model?: string
  turns?: Turn[]
  diarization_run_id?: string
}): void {
  // Diarization columns (spec §6.3) are additive and written ONLY when the
  // provider supplies turns. Whisper/Gemini (no turns) leave turns/speakers/
  // sentiment NULL — exactly today's behavior. These are Stage-1 columns, so the
  // ON CONFLICT update sets them alongside full_text and never touches the
  // Stage-2 (analysis) columns.
  let turnsJson: string | null = null
  let speakersJson: string | null = null
  let sentimentJson: string | null = null
  if (t.turns !== undefined) {
    const { speakers, sentiment } = deriveSpeakerRosterSummary(t.turns)
    turnsJson = JSON.stringify(t.turns)
    speakersJson = JSON.stringify(speakers)
    sentimentJson = JSON.stringify(sentiment)
  }

  run(
    `INSERT INTO transcripts (id, recording_id, full_text, language, word_count,
       transcription_provider, transcription_model, turns, speakers, sentiment, diarization_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(recording_id) DO UPDATE SET
       full_text = excluded.full_text,
       language = COALESCE(excluded.language, transcripts.language),
       word_count = excluded.word_count,
       transcription_provider = excluded.transcription_provider,
       transcription_model = excluded.transcription_model,
       turns = excluded.turns,
       speakers = excluded.speakers,
       sentiment = excluded.sentiment,
       diarization_run_id = excluded.diarization_run_id`,
    [
      `trans_${t.recording_id}`,
      t.recording_id,
      t.full_text,
      t.language ?? null,
      t.word_count ?? null,
      t.transcription_provider,
      t.transcription_model ?? null,
      turnsJson,
      speakersJson,
      sentimentJson,
      t.diarization_run_id ?? null
    ]
  )
}

/**
 * Stage 2 write (auto-pipeline spec §5.3): one atomic UPDATE that sets the
 * analysis content AND the stage marker (summarization_provider). No other
 * runtime path writes the marker (the v25 migration backfill is the one-time
 * exception). language uses COALESCE so an ASR-provided value (whisper
 * verbose_json) is never overwritten; Gemini rows (Stage-1 NULL) receive the
 * analysis language — identical to today's behavior.
 *
 * NOTE: this is a full REPLACE of the analysis columns, not a patch — every
 * omitted optional field is written as NULL. Callers must pass the complete
 * analysis result; do not use this for partial updates.
 *
 * Throws if no transcript row exists for the recording (Stage 2 must always
 * follow a Stage-1 upsert or a resume pre-read; a 0-row update here would
 * otherwise let a recording be marked 'complete' with no analysis).
 */
export function updateTranscriptStage2(recordingId: string, fields: {
  summary?: string
  action_items?: string
  topics?: string
  key_points?: string
  title_suggestion?: string
  question_suggestions?: string
  language?: string
  summarization_provider: string
  summarization_model?: string
  /** Provenance: denormalized display name of the applied template (survives delete/rename). */
  template_name?: string | null
  /** Provenance: SHA-256 hex digest of the applied template's instructions. */
  template_hash?: string | null
}): void {
  // Existence guard (not getRowsModified(): the run() helper auto-persists
  // after each statement, which resets sql.js's modification counter).
  const existing = queryOne<{ id: string }>(
    'SELECT id FROM transcripts WHERE recording_id = ?',
    [recordingId]
  )
  if (!existing) {
    throw new Error(`updateTranscriptStage2: no transcript row for recording ${recordingId}`)
  }
  run(
    `UPDATE transcripts SET
       summary = ?, action_items = ?, topics = ?, key_points = ?,
       title_suggestion = ?, question_suggestions = ?,
       language = COALESCE(language, ?),
       summarization_provider = ?, summarization_model = ?,
       summarization_template_name = ?, summarization_template_hash = ?,
       summarization_template_id = NULL,
       created_at = CURRENT_TIMESTAMP
     WHERE recording_id = ?`,
    [
      fields.summary ?? null,
      fields.action_items ?? null,
      fields.topics ?? null,
      fields.key_points ?? null,
      fields.title_suggestion ?? null,
      fields.question_suggestions ?? null,
      fields.language ?? null,
      fields.summarization_provider,
      fields.summarization_model ?? null,
      fields.template_name ?? null,
      fields.template_hash ?? null,
      recordingId
    ]
  )
}

/** Resummarize support (spec §5.3): clears ONLY the stage marker so the worker's
 *  resume rule re-runs Stage 2 with the currently configured LLM. The old summary
 *  is deliberately KEPT until the new one lands — a failed re-run must not lose data. */
export function clearTranscriptStage2Marker(recordingId: string): void {
  const existing = queryOne<{ id: string }>('SELECT id FROM transcripts WHERE recording_id = ?', [recordingId])
  if (!existing) {
    throw new Error(`clearTranscriptStage2Marker: no transcript row for recording ${recordingId}`)
  }
  run('UPDATE transcripts SET summarization_provider = NULL, summarization_model = NULL WHERE recording_id = ?', [recordingId])
}

/** Phase 4 (Task 13): write the single-shot override column so the worker picks up
 *  the requested template on its next Stage-2 pass.  The worker's Stage-2 write
 *  (updateTranscriptStage2) atomically nulls the column after consuming it, ensuring
 *  it is applied exactly once.  Throws when no transcript row exists so the caller
 *  (recording-handlers) can surface a proper error rather than a silent no-op. */
export function setTranscriptTemplateOverride(recordingId: string, templateId: string | null): void {
  const existing = queryOne<{ id: string }>('SELECT id FROM transcripts WHERE recording_id = ?', [recordingId])
  if (!existing) {
    throw new Error(`setTranscriptTemplateOverride: no transcript row for recording ${recordingId}`)
  }
  run('UPDATE transcripts SET summarization_template_id = ? WHERE recording_id = ?', [templateId, recordingId])
}

/** Phase 4 (Task 13): concurrency guard — returns true when the recording has a
 *  transcription_queue row in `pending` OR `processing` state.  The resummarize
 *  handler uses this to reject a re-summarize request with "transcription in progress"
 *  before writing any override, so a rejected call leaves the DB unchanged.
 *  Spec §8.3 is authoritative: reject-if-in-flight, no last-write-wins. */
export function hasInFlightQueueItem(recordingId: string): boolean {
  const row = queryOne<{ c: number }>(
    "SELECT COUNT(*) AS c FROM transcription_queue WHERE recording_id = ? AND status IN ('pending','processing')",
    [recordingId]
  )
  return (row?.c ?? 0) > 0
}

/** D5 §6.8: re-transcribe support — clears BOTH stage markers so the worker
 *  short-circuit (`full_text && summarization_provider`) AND the Stage-2-only
 *  resume rule (`full_text && !summarization_provider`) are both defeated, forcing
 *  a FRESH Stage 1 (new ASR). full_text is set to '' rather than NULL because the
 *  column is NOT NULL (schema line 243); '' is falsy, so it reads as "no Stage-1
 *  text yet" to the worker's truthiness gates. The diarization columns (turns,
 *  speakers, sentiment) are cleared too since a new ASR pass re-letters speakers.
 *  No-op when there is no transcript row (a first-time transcribe clears nothing). */
export function clearTranscriptForRetranscribe(recordingId: string): void {
  const existing = queryOne<{ id: string }>('SELECT id FROM transcripts WHERE recording_id = ?', [recordingId])
  if (!existing) return
  run(
    `UPDATE transcripts
       SET full_text = '',
           turns = NULL,
           speakers = NULL,
           sentiment = NULL,
           summarization_provider = NULL,
           summarization_model = NULL,
           summarization_template_id = NULL
     WHERE recording_id = ?`,
    [recordingId]
  )
}

/** D5 §6.6: build the Stage-2 analysis input from structured turns, prefixing
 *  each turn with the mapped contact NAME (via recording_speakers -> contacts)
 *  when present, else the human "Speaker <label>" form. Falls back to the flat
 *  full_text when turns is absent/empty (Whisper/Gemini / pre-migration / zero-
 *  speaker rows) — the §10(c) regression path. Returns undefined when there is
 *  no transcript row. */
export function buildAttributedTranscript(recordingId: string): string | undefined {
  const t = queryOne<{ full_text: string; turns: string | null }>(
    'SELECT full_text, turns FROM transcripts WHERE recording_id = ?',
    [recordingId]
  )
  if (!t) return undefined

  let turns: Array<{ speaker: string; text: string }> = []
  if (t.turns) {
    try {
      const parsed = JSON.parse(t.turns)
      if (Array.isArray(parsed)) turns = parsed
    } catch {
      turns = []
    }
  }
  if (turns.length === 0) return t.full_text

  // label -> contact name (only for mapped labels)
  const speakers = getRecordingSpeakers(recordingId)
  const nameByLabel = new Map<string, string>()
  for (const s of speakers) {
    if (!s.contact_id) continue
    const c = queryOne<{ name: string }>('SELECT name FROM contacts WHERE id = ?', [s.contact_id])
    if (c?.name) nameByLabel.set(s.file_label, c.name)
  }

  return turns
    .map((turn) => {
      const label = nameByLabel.get(turn.speaker) ?? `Speaker ${turn.speaker}`
      return `${label}: ${turn.text}`
    })
    .join('\n')
}

/** D5 §6.6: the Stage-2 summary is "stale" iff at least one speaker mapping
 *  exists whose created_at is strictly NEWER than the transcript's summary stamp
 *  (transcripts.created_at, re-stamped by updateTranscriptStage2). Used to drive
 *  the "Summary uses generic speaker labels — re-summarize to attribute names"
 *  badge; clears once a resummarize moves the stamp past every mapping. Returns
 *  false when no transcript row exists or no mappings exist.
 *
 *  SUMMARY-EXISTS GUARD: because updateTranscriptStage2 re-stamps created_at, a
 *  Stage-1-only row (no summary yet, or Stage 2 failed/parked) still carries its
 *  row-insert created_at. A later mapping would otherwise satisfy the timestamp
 *  comparison and wrongly report stale even though there is NO summary to be stale.
 *  We gate on summarization_provider IS NOT NULL — the canonical Stage-2-completion
 *  marker (cleared to NULL by clearTranscriptStage2Marker on resummarize; always
 *  set by updateTranscriptStage2). NOT summary IS NOT NULL, since a completed
 *  Stage 2 may legitimately produce a NULL summary.
 *
 *  TIMESTAMP NORMALIZATION: recording_speakers.created_at is written as a JS ISO
 *  string ('YYYY-MM-DDTHH:MM:SS.sssZ') while transcripts.created_at is stamped by
 *  CURRENT_TIMESTAMP (SQLite space-format: 'YYYY-MM-DD HH:MM:SS'). A raw lexical
 *  '>' comparison is unreliable across these formats because 'T' > ' ' in ASCII,
 *  making ISO strings sort later than space-format strings with the same time value.
 *  Both sides are normalized via datetime() so the comparison is time-correct
 *  regardless of which format each column holds. */
export function isSummaryStale(recordingId: string): boolean {
  const row = queryOne<{ stale: number }>(
    `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM recording_speakers rs
       JOIN transcripts t ON t.recording_id = rs.recording_id
       WHERE rs.recording_id = ?
         AND t.summarization_provider IS NOT NULL
         AND datetime(rs.created_at) > datetime(t.created_at)
     ) THEN 1 ELSE 0 END AS stale`,
    [recordingId]
  )
  return row?.stale === 1
}

/**
 * Escape special LIKE pattern characters to prevent SQL injection via wildcards.
 * In SQLite LIKE, % matches any sequence and _ matches any single character.
 * We escape them with \ and specify ESCAPE '\' in the query.
 */
export function escapeLikePattern(pattern: string): string {
  return pattern
    .replace(/\\/g, '\\\\')  // Escape backslash first
    .replace(/%/g, '\\%')     // Escape percent
    .replace(/_/g, '\\_')     // Escape underscore
}

// Full-text search (simple LIKE-based for sql.js)
export function searchTranscripts(query: string): Transcript[] {
  const escaped = escapeLikePattern(query)
  return queryAll<Transcript>(
    `SELECT * FROM transcripts WHERE full_text LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR topics LIKE ? ESCAPE '\\'`,
    [`%${escaped}%`, `%${escaped}%`, `%${escaped}%`]
  )
}

// Embedding queries
export interface Embedding {
  id: string
  transcript_id: string
  chunk_index: number
  chunk_text: string
  embedding: Uint8Array
  created_at: string
}

export function insertEmbedding(embedding: Omit<Embedding, 'created_at'>): void {
  run(
    `INSERT INTO embeddings (id, transcript_id, chunk_index, chunk_text, embedding) VALUES (?, ?, ?, ?, ?)`,
    [embedding.id, embedding.transcript_id, embedding.chunk_index, embedding.chunk_text, embedding.embedding]
  )
}

export function getEmbeddingsForTranscript(transcriptId: string): Embedding[] {
  return queryAll<Embedding>('SELECT * FROM embeddings WHERE transcript_id = ? ORDER BY chunk_index', [transcriptId])
}

export function getAllEmbeddings(): Embedding[] {
  return queryAll<Embedding>('SELECT * FROM embeddings')
}

// Voiceprint queries (speaker-diarization §6.3) — v1 CAPTURE ONLY; nothing
// reads these for matching in v1 (matcher is Phase 2). BLOB is bound as a
// Uint8Array exactly like insertEmbedding above.
export interface Voiceprint {
  id: string
  contact_id: string
  model_id: string
  dim: number
  embedding: Uint8Array
  created_at: string
  // v27 provenance + hygiene columns (Phase 2)
  source_recording_id?: string | null
  source_label?: string | null
  clean_speech_ms?: number | null
  quality_score?: number | null
  model_version?: number | null
  created_from?: 'manual' | 'confirmed' | 'self' | 'import' | null
  disabled_at?: string | null
  superseded_by?: string | null
}

export function insertVoiceprint(vp: Omit<Voiceprint, 'created_at'>): void {
  run(
    `INSERT INTO voiceprints
      (id, contact_id, model_id, dim, embedding, created_at,
       source_recording_id, source_label, clean_speech_ms, quality_score, model_version, created_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      vp.id,
      vp.contact_id,
      vp.model_id,
      vp.dim,
      vp.embedding,
      new Date().toISOString(),
      vp.source_recording_id ?? null,
      vp.source_label ?? null,
      vp.clean_speech_ms ?? null,
      vp.quality_score ?? null,
      vp.model_version ?? 1,
      vp.created_from ?? 'manual'
    ]
  )
}

export function getVoiceprintsByContactId(contactId: string): Voiceprint[] {
  return queryAll<Voiceprint>(
    'SELECT * FROM voiceprints WHERE contact_id = ? ORDER BY created_at',
    [contactId]
  )
}

// v27 voice-library foundation (spec 2026-06-19 rev 2 §8) — DB helpers for the
// new label-embedding/suggestion tables and voiceprint hygiene primitives.
export interface LabelEmbedding {
  id: string; recording_id: string; transcript_id?: string | null; diarization_run_id?: string | null
  file_label: string; model_id: string; model_version?: number; dim: number; embedding: Uint8Array
  clean_speech_ms?: number | null; turn_count?: number | null; quality_score?: number | null; status?: string | null
}
export function insertLabelEmbedding(e: LabelEmbedding): void {
  run(`INSERT OR REPLACE INTO recording_label_embeddings
    (id, recording_id, transcript_id, diarization_run_id, file_label, model_id, model_version, dim, embedding, clean_speech_ms, turn_count, quality_score, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [e.id, e.recording_id, e.transcript_id ?? null, e.diarization_run_id ?? null, e.file_label, e.model_id, e.model_version ?? 1, e.dim, e.embedding, e.clean_speech_ms ?? null, e.turn_count ?? null, e.quality_score ?? null, e.status ?? null, new Date().toISOString()])
}
export function getLabelEmbeddingsForRecording(recordingId: string): LabelEmbedding[] {
  return queryAll<LabelEmbedding>('SELECT * FROM recording_label_embeddings WHERE recording_id = ?', [recordingId])
}
export function deleteLabelEmbeddingsForRecording(recordingId: string): void {
  run('DELETE FROM recording_label_embeddings WHERE recording_id = ?', [recordingId])
}

// v32 mixed-detection window embeddings (spec 2026-06-21 §2). The fingerprint is the
// content cache key (NOT diarization_run_id); see speaker-matcher.labelTurnsFingerprint.
export interface WindowEmbeddingRow {
  id: string; recording_id: string; transcript_id?: string | null; diarization_run_id?: string | null
  file_label: string; window_index: number; fingerprint: string
  model_id: string; model_version?: number; dim: number; embedding: Uint8Array; created_at?: string
}

export interface WindowEmbeddingGroup {
  fileLabel: string; fingerprint: string; embeddings: Uint8Array[]
}

/** Insert all window-embedding rows inside ONE better-sqlite3 transaction.
 *  Avoids per-row overhead. Empty input is a no-op. */
export function insertWindowEmbeddingsBatch(rows: WindowEmbeddingRow[]): void {
  if (rows.length === 0) return
  const now = new Date().toISOString()
  const database = getDatabase()
  const stmt = database.prepare(`INSERT OR REPLACE INTO recording_window_embeddings
    (id, recording_id, transcript_id, diarization_run_id, file_label, window_index, fingerprint,
     model_id, model_version, dim, embedding, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  const tx = database.transaction((items: Array<readonly unknown[]>) => {
    for (const args of items) stmt.run(...args)
  })
  tx(rows.map(r => [
    r.id, r.recording_id, r.transcript_id ?? null, r.diarization_run_id ?? null,
    r.file_label, r.window_index, r.fingerprint, r.model_id, r.model_version ?? 1,
    r.dim, Buffer.from(r.embedding), r.created_at ?? now
  ]))
}

/** Rows for a recording, grouped by file_label, embeddings ordered by window_index,
 *  with each label's fingerprint. Stale model_id / model_version rows are excluded. */
export function getWindowEmbeddingsForRecording(
  recordingId: string,
  modelId: string,
  modelVersion: number
): WindowEmbeddingGroup[] {
  const rows = queryAll<WindowEmbeddingRow>(
    `SELECT * FROM recording_window_embeddings
     WHERE recording_id = ? AND model_id = ? AND model_version = ?
     ORDER BY file_label, window_index`,
    [recordingId, modelId, modelVersion]
  )
  const byLabel = new Map<string, WindowEmbeddingGroup>()
  for (const r of rows) {
    let g = byLabel.get(r.file_label)
    if (!g) {
      g = { fileLabel: r.file_label, fingerprint: r.fingerprint, embeddings: [] }
      byLabel.set(r.file_label, g)
    }
    g.embeddings.push(r.embedding)
  }
  return [...byLabel.values()]
}

export function deleteWindowEmbeddingsForRecording(recordingId: string): void {
  run('DELETE FROM recording_window_embeddings WHERE recording_id = ?', [recordingId])
}

export function deleteWindowEmbeddingsForLabel(recordingId: string, fileLabel: string): void {
  run('DELETE FROM recording_window_embeddings WHERE recording_id = ? AND file_label = ?', [recordingId, fileLabel])
}

/** Atomically replace one label's window rows: DELETE the label's existing rows + INSERT the
 *  fresh set inside ONE transaction, saving the sql.js image ONCE. This is the recompute accessor
 *  the matcher uses — a separate delete + batch-insert would be TWO auto-saving transactions with a
 *  crash window that could leave the label with zero rows (spec §4.4 atomicity). Empty `rows` just
 *  deletes the label. */
export function replaceWindowEmbeddingsForLabel(
  recordingId: string,
  fileLabel: string,
  rows: WindowEmbeddingRow[]
): void {
  const now = new Date().toISOString()
  runInTransaction(() => {
    runNoSave('DELETE FROM recording_window_embeddings WHERE recording_id = ? AND file_label = ?', [
      recordingId,
      fileLabel,
    ])
    if (rows.length === 0) return
    const database = getDatabase()
    const stmt = database.prepare(`INSERT OR REPLACE INTO recording_window_embeddings
      (id, recording_id, transcript_id, diarization_run_id, file_label, window_index, fingerprint,
       model_id, model_version, dim, embedding, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const r of rows) {
      stmt.run(
        r.id, r.recording_id, r.transcript_id ?? null, r.diarization_run_id ?? null,
        r.file_label, r.window_index, r.fingerprint, r.model_id, r.model_version ?? 1,
        r.dim, Buffer.from(r.embedding), r.created_at ?? now
      )
    }
  })
}

export interface SpeakerSuggestion {
  id: string; recording_id: string; transcript_id?: string | null; diarization_run_id?: string | null
  kind: 'identity' | 'merge' | 'mixed' | 'backstop'
  target_label?: string | null; target_label_2?: string | null
  contact_id?: string | null; contact_id_2?: string | null
  score?: number | null; rank?: number | null; rationale?: string | null
  status?: 'pending' | 'dismissed' | 'accepted' | 'expired'
}
export function insertSuggestion(s: SpeakerSuggestion): void {
  run(`INSERT OR REPLACE INTO speaker_suggestions
    (id, recording_id, transcript_id, diarization_run_id, kind, target_label, target_label_2, contact_id, contact_id_2, score, rank, rationale, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [s.id, s.recording_id, s.transcript_id ?? null, s.diarization_run_id ?? null, s.kind, s.target_label ?? null, s.target_label_2 ?? null, s.contact_id ?? null, s.contact_id_2 ?? null, s.score ?? null, s.rank ?? null, s.rationale ?? null, s.status ?? 'pending', new Date().toISOString()])
}
export function dismissSuggestion(id: string): void {
  run("UPDATE speaker_suggestions SET status='dismissed', resolved_at=? WHERE id=?", [new Date().toISOString(), id])
}
export function getPendingSuggestions(recordingId: string, diarizationRunId?: string | null): SpeakerSuggestion[] {
  if (diarizationRunId != null) {
    return queryAll<SpeakerSuggestion>(
      "SELECT * FROM speaker_suggestions WHERE recording_id=? AND status='pending' AND diarization_run_id=? ORDER BY rank",
      [recordingId, diarizationRunId]
    )
  }
  return queryAll<SpeakerSuggestion>("SELECT * FROM speaker_suggestions WHERE recording_id=? AND status='pending' ORDER BY rank", [recordingId])
}

/** All suggestions for a recording, optionally scoped to one diarization run. */
export function getSuggestionsForRecording(recordingId: string, diarizationRunId?: string | null): SpeakerSuggestion[] {
  if (diarizationRunId != null) {
    return queryAll<SpeakerSuggestion>(
      'SELECT * FROM speaker_suggestions WHERE recording_id=? AND diarization_run_id=? ORDER BY rank',
      [recordingId, diarizationRunId]
    )
  }
  return queryAll<SpeakerSuggestion>('SELECT * FROM speaker_suggestions WHERE recording_id=? ORDER BY rank', [recordingId])
}

/** Mark pending/accepted suggestions for a recording as expired (used on re-transcribe/merge). */
export function expireSuggestionsForRecording(recordingId: string): void {
  run(
    "UPDATE speaker_suggestions SET status='expired', resolved_at=? WHERE recording_id=? AND status IN ('pending','accepted')",
    [new Date().toISOString(), recordingId]
  )
}

/** Mark a single suggestion as accepted. */
export function acceptSuggestion(id: string): void {
  run("UPDATE speaker_suggestions SET status='accepted', resolved_at=? WHERE id=?", [new Date().toISOString(), id])
}

/** Delete pending suggestions for a recording, optionally scoped to one diarization run. */
export function deletePendingSuggestionsForRecording(recordingId: string, diarizationRunId?: string | null): void {
  if (diarizationRunId != null) {
    run(
      "DELETE FROM speaker_suggestions WHERE recording_id=? AND diarization_run_id=? AND status='pending'",
      [recordingId, diarizationRunId]
    )
  } else {
    run("DELETE FROM speaker_suggestions WHERE recording_id=? AND status='pending'", [recordingId])
  }
}

/** Contacts that have at least one active (non-disabled) voiceprint for a given model. */
export function getContactsWithActiveVoiceprints(modelId: string): Array<{ contact_id: string }> {
  return queryAll<{ contact_id: string }>(
    'SELECT DISTINCT contact_id FROM voiceprints WHERE model_id=? AND disabled_at IS NULL ORDER BY contact_id',
    [modelId]
  )
}

export function getActiveVoiceprintsByContactId(contactId: string): Voiceprint[] {
  return queryAll<Voiceprint>('SELECT * FROM voiceprints WHERE contact_id=? AND disabled_at IS NULL ORDER BY created_at', [contactId])
}
export function enableVoiceprint(id: string): void {
  run('UPDATE voiceprints SET disabled_at=NULL WHERE id=?', [id])
}
export function disableVoiceprint(id: string): void {
  run('UPDATE voiceprints SET disabled_at=? WHERE id=?', [new Date().toISOString(), id])
}
export function deleteVoiceprint(id: string): void {
  run('DELETE FROM voiceprints WHERE id=?', [id])
}

/** Delete every voiceprint belonging to a contact. Returns the number of rows removed. */
export function deleteVoiceprintsByContactId(contactId: string): number {
  const before = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM voiceprints WHERE contact_id = ?', [contactId])
  run('DELETE FROM voiceprints WHERE contact_id = ?', [contactId])
  return before?.n ?? 0
}

/** Delete every voiceprint in the library. Returns the number of rows removed. */
export function deleteAllVoiceprints(): number {
  const before = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM voiceprints')
  run('DELETE FROM voiceprints')
  return before?.n ?? 0
}

/**
 * List-valued provenance lookup. The voiceprints table has no unique constraint on
 * (source_recording_id, source_label), so a single provenance can map to many rows
 * (repeated assignments, reassignments across contacts). The optional contactId scope
 * makes "the print(s) this assignment produced" unambiguous (§3.6).
 */
export function getVoiceprintsBySource(
  recordingId: string,
  fileLabel: string,
  contactId?: string
): Voiceprint[] {
  if (contactId !== undefined) {
    return queryAll<Voiceprint>(
      'SELECT * FROM voiceprints WHERE source_recording_id=? AND source_label=? AND contact_id=? ORDER BY created_at DESC',
      [recordingId, fileLabel, contactId]
    )
  }
  return queryAll<Voiceprint>(
    'SELECT * FROM voiceprints WHERE source_recording_id=? AND source_label=? ORDER BY created_at DESC',
    [recordingId, fileLabel]
  )
}

/**
 * Batch un-bank for a specific contact's prints from one (recording, label) provenance.
 * Always contact-scoped so a reassign auto-purge can never touch the new contact's
 * freshly-banked print (§3.6).
 */
export function deleteVoiceprintsBySource(recordingId: string, fileLabel: string, contactId: string): number {
  const before = queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM voiceprints WHERE source_recording_id=? AND source_label=? AND contact_id=?',
    [recordingId, fileLabel, contactId]
  )
  run('DELETE FROM voiceprints WHERE source_recording_id=? AND source_label=? AND contact_id=?', [
    recordingId,
    fileLabel,
    contactId
  ])
  return before?.n ?? 0
}

export function getSelfContactId(): string | null {
  return queryOne<{ id: string }>('SELECT id FROM contacts WHERE is_self=1 LIMIT 1')?.id ?? null
}
export function setSelfContact(contactId: string): void {
  runInTransaction(() => {
    runNoSave('UPDATE contacts SET is_self=0 WHERE is_self=1')
    runNoSave('UPDATE contacts SET is_self=1 WHERE id=?', [contactId])
  })
}

/** Unset the current self contact (sets is_self=0 on whoever is self). Idempotent. */
export function clearSelfContact(): void {
  run('UPDATE contacts SET is_self=0 WHERE is_self=1')
}

// Queue queries
export interface QueueItem {
  id: string
  recording_id: string
  status: string
  attempts: number
  retry_count: number
  progress: number
  error_message?: string
  created_at: string
  started_at?: string
  completed_at?: string
  parked_until?: string
  first_parked_at?: string
}

/** Insert a queue item — deduped (spec §5.7): if a pending/processing item already
 *  exists for this recording, return ITS id (truthy contract — useOperations.ts
 *  treats falsy as failure and would otherwise toast a spurious error). Parked
 *  items keep status='pending' (§7.2), so the dedupe covers them automatically.
 *  Terminal items (completed/failed/cancelled) do not block a fresh queue entry. */
export function addToQueue(recordingId: string): string {
  // ORDER matches getQueueItems' pick order (retry_count ASC, created_at ASC) so the
  // returned id is the item the processor will actually run next — matters only for
  // legacy duplicate rows that predate this dedupe (new duplicates can't form).
  const existing = queryOne<{ id: string }>(
    "SELECT id FROM transcription_queue WHERE recording_id = ? AND status IN ('pending', 'processing') " +
      'ORDER BY retry_count ASC, created_at ASC LIMIT 1',
    [recordingId]
  )
  if (existing) return existing.id
  const id = crypto.randomUUID()
  run('INSERT INTO transcription_queue (id, recording_id) VALUES (?, ?)', [id, recordingId])
  return id
}

export function getQueueItems(status?: string): (QueueItem & { filename?: string })[] {
  // Sort by priority: lower retry_count first (fresh items before retries), then FIFO by created_at
  const sql = `
    SELECT tq.*, r.filename
    FROM transcription_queue tq
    LEFT JOIN recordings r ON tq.recording_id = r.id
    ${status ? 'WHERE tq.status = ?' : ''}
    ORDER BY tq.retry_count ASC, tq.created_at ASC`
  if (status) {
    return queryAll<QueueItem & { filename?: string }>(sql, [status])
  }
  return queryAll<QueueItem & { filename?: string }>(sql)
}

export function updateQueueItem(id: string, status: string, errorMessage?: string): void {
  if (status === 'processing') {
    run('UPDATE transcription_queue SET status = ?, started_at = CURRENT_TIMESTAMP, attempts = attempts + 1 WHERE id = ?', [
      status,
      id
    ])
  } else if (status === 'completed' || status === 'failed') {
    run('UPDATE transcription_queue SET status = ?, completed_at = CURRENT_TIMESTAMP, error_message = ? WHERE id = ?', [
      status,
      errorMessage ?? null,
      id
    ])
  } else if (status === 'pending') {
    // When retrying, increment retry_count and reset progress
    run('UPDATE transcription_queue SET status = ?, retry_count = retry_count + 1, progress = 0 WHERE id = ?', [status, id])
  } else {
    run('UPDATE transcription_queue SET status = ? WHERE id = ?', [status, id])
  }
}

export function updateQueueProgress(id: string, progress: number): void {
  // Clamp progress between 0 and 100
  const clampedProgress = Math.max(0, Math.min(100, Math.round(progress)))
  run('UPDATE transcription_queue SET progress = ? WHERE id = ?', [clampedProgress, id])
}

/** Quota parking (spec §7.2): keep status='pending' (no new status — dedupe/startup
 *  recovery/re-pend stay correct by construction) and deliberately BYPASS the
 *  generic 'pending' transition, which increments retry_count (see updateQueueItem).
 *  first_parked_at anchors the 24h terminal cap and survives re-parks via COALESCE.
 *  delayMs is converted to a timestamp IN SQL so the stored format matches
 *  CURRENT_TIMESTAMP (space-separated UTC) — see the plan's TIMESTAMP FORMAT note. */
export function parkQueueItem(id: string, delayMs: number): void {
  const delaySeconds = Math.max(1, Math.round(delayMs / 1000))
  run(
    `UPDATE transcription_queue
     SET status = 'pending',
         parked_until = datetime('now', '+' || ? || ' seconds'),
         first_parked_at = COALESCE(first_parked_at, CURRENT_TIMESTAMP),
         progress = 0
     WHERE id = ?`,
    [String(delaySeconds), id]
  )
}

/** Poller selection (spec §7.2): pending items not parked into the future.
 *  datetime() on both sides normalizes any format drift. Everything else keeps
 *  using getQueueItems unchanged. */
export function getRunnableQueueItems(): (QueueItem & { filename?: string })[] {
  return queryAll<QueueItem & { filename?: string }>(`
    SELECT tq.*, r.filename
    FROM transcription_queue tq
    LEFT JOIN recordings r ON tq.recording_id = r.id
    WHERE tq.status = 'pending' AND (tq.parked_until IS NULL OR datetime(tq.parked_until) <= datetime('now'))
    ORDER BY tq.retry_count ASC, tq.created_at ASC`)
}

/** 24h-cap check (spec §7.2) — computed entirely in SQL (julianday) so the
 *  space-format first_parked_at is never parsed by V8 (which would read it as
 *  LOCAL time and skew the age by the UTC offset). */
export function getQueueItemParkedHours(id: string): number | null {
  const row = queryOne<{ hours: number | null }>(
    `SELECT CASE WHEN first_parked_at IS NULL THEN NULL
                 ELSE (julianday('now') - julianday(first_parked_at)) * 24.0 END AS hours
     FROM transcription_queue WHERE id = ?`,
    [id]
  )
  return row?.hours ?? null
}

/** Clear parking columns on any successful stage completion (spec §7.2):
 *  so a Stage-1 park never poisons Stage-2's 24h clock. */
export function clearParking(id: string): void {
  run('UPDATE transcription_queue SET parked_until = NULL, first_parked_at = NULL WHERE id = ?', [id])
}

/** Key-fix / Retry-all re-pend (spec §7.3). Markers are LIKE-escaped. Returns count.
 *  NOTE: row count is determined via SELECT first — never via getRowsModified()
 *  because run() auto-persists and resets sql.js's modification counter (P1 lesson). */
export function rependFailedItems(markers: string[]): number {
  if (markers.length === 0) return 0
  const likeClauses = markers.map(() => `error_message LIKE ? ESCAPE '\\'`).join(' OR ')
  const params = markers.map((m) => `%${escapeLikePattern(m)}%`)
  const matching = queryAll<{ id: string; recording_id: string }>(
    `SELECT id, recording_id FROM transcription_queue WHERE status = 'failed' AND (${likeClauses})`,
    params
  )
  if (matching.length === 0) return 0
  run(
    `UPDATE transcription_queue SET status = 'pending', retry_count = 0, parked_until = NULL, first_parked_at = NULL
     WHERE status = 'failed' AND (${likeClauses})`,
    params
  )
  // Reset linked recordings so the UI shows retrying
  for (const row of matching) {
    updateRecordingTranscriptionStatus(row.recording_id, 'pending')
  }
  return matching.length
}

export function removeFromQueue(id: string): void {
  run('DELETE FROM transcription_queue WHERE id = ?', [id])
}

export function removeFromQueueByRecordingId(recordingId: string): void {
  run('DELETE FROM transcription_queue WHERE recording_id = ?', [recordingId])
}

export function cancelPendingTranscriptions(): number {
  const pending = getQueueItems('pending')
  const processing = getQueueItems('processing')
  run("DELETE FROM transcription_queue WHERE status = 'pending'")
  run("UPDATE transcription_queue SET status = 'cancelled' WHERE status = 'processing'")
  for (const item of pending) {
    updateRecordingTranscriptionStatus(item.recording_id, 'none')
  }
  for (const item of processing) {
    updateRecordingTranscriptionStatus(item.recording_id, 'none')
  }
  return pending.length + processing.length
}

// Chat queries
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: string
  created_at: string
}

export function getChatHistory(limit = 50): ChatMessage[] {
  return queryAll<ChatMessage>('SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT ?', [limit]).reverse()
}

export function addChatMessage(role: 'user' | 'assistant', content: string, sources?: string): string {
  const id = crypto.randomUUID()
  run('INSERT INTO chat_messages (id, role, content, sources) VALUES (?, ?, ?, ?)', [id, role, content, sources ?? null])
  return id
}

export function clearChatHistory(): void {
  run('DELETE FROM chat_messages', [])
}

// Synced files queries - track which device files have been downloaded
export interface SyncedFile {
  id: string
  original_filename: string
  local_filename: string
  file_path: string
  file_size?: number
  synced_at: string
}

export function isFileSynced(originalFilename: string): boolean {
  const result = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM synced_files WHERE original_filename = ?', [
    originalFilename
  ])
  return (result?.count ?? 0) > 0
}

export function getSyncedFile(originalFilename: string): SyncedFile | undefined {
  return queryOne<SyncedFile>('SELECT * FROM synced_files WHERE original_filename = ?', [originalFilename])
}

export function getAllSyncedFiles(): SyncedFile[] {
  return queryAll<SyncedFile>('SELECT * FROM synced_files ORDER BY synced_at DESC')
}

export function addSyncedFile(
  originalFilename: string,
  localFilename: string,
  filePath: string,
  fileSize?: number
): string {
  const id = crypto.randomUUID()
  run(
    'INSERT OR REPLACE INTO synced_files (id, original_filename, local_filename, file_path, file_size) VALUES (?, ?, ?, ?, ?)',
    [id, originalFilename, localFilename, filePath, fileSize ?? null]
  )
  return id
}

export function removeSyncedFile(originalFilename: string): void {
  run('DELETE FROM synced_files WHERE original_filename = ?', [originalFilename])
}

/**
 * Clear all synced file records from the database.
 * Used when cleaning up wrongly-named files for re-download.
 */
export function clearAllSyncedFiles(): number {
  const countBefore = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM synced_files')?.count ?? 0
  run('DELETE FROM synced_files')
  console.log(`Cleared ${countBefore} synced file records from database`)
  return countBefore
}

// Get all synced filenames as a Set for quick lookup
export function getSyncedFilenames(): Set<string> {
  const files = queryAll<{ original_filename: string }>('SELECT original_filename FROM synced_files')
  return new Set(files.map((f) => f.original_filename))
}

// =============================================================================
// Device files cache queries - persist device file list for offline viewing
// =============================================================================

export interface DeviceCacheEntry {
  id: string
  filename: string
  file_size?: number
  duration_seconds?: number
  date_recorded: string
  cached_at: string
}

export function getDeviceFilesCache(): DeviceCacheEntry[] {
  return queryAll<DeviceCacheEntry>('SELECT * FROM device_files_cache ORDER BY date_recorded DESC')
}

export function saveDeviceFilesCache(files: Array<{
  filename: string
  size?: number
  file_size?: number
  duration_seconds?: number
  date_recorded: string
}>): void {
  // Clear existing cache
  run('DELETE FROM device_files_cache')

  // Insert new cache entries
  for (const file of files) {
    const id = `cache_${file.filename.replace(/[^a-zA-Z0-9]/g, '_')}`
    // Accept both 'size' and 'file_size' for flexibility
    const fileSize = file.size ?? file.file_size ?? null
    run(
      `INSERT OR REPLACE INTO device_files_cache (id, filename, file_size, duration_seconds, date_recorded)
       VALUES (?, ?, ?, ?, ?)`,
      [id, file.filename, fileSize, file.duration_seconds ?? null, file.date_recorded]
    )
  }
}

export function clearDeviceFilesCache(): void {
  run('DELETE FROM device_files_cache')
}

/**
 * Clear all meetings from the database atomically.
 * Use this to force a complete re-sync from ICS source.
 * Also clears recording→meeting links to prevent orphaned foreign keys.
 */
export function clearAllMeetings(): void {
  runInTransaction(() => {
    // Clear meeting-contact links (has ON DELETE CASCADE but explicit is safer)
    runNoSave('DELETE FROM meeting_contacts')
    // Clear recording-meeting candidates (has ON DELETE CASCADE)
    runNoSave('DELETE FROM recording_meeting_candidates')
    // Clear recording→meeting links to prevent orphaned FKs
    // This preserves the recordings but removes their meeting association
    runNoSave('UPDATE recordings SET meeting_id = NULL, correlation_confidence = NULL, correlation_method = NULL WHERE meeting_id IS NOT NULL')
    // Finally clear meetings
    runNoSave('DELETE FROM meetings')
  })
  console.log('[Database] Cleared all meetings and associated links')
}

/**
 * Clear all cached data (meetings + device cache) to force fresh sync.
 * Use when timezone or duration calculations have been fixed.
 */
export function clearAllCachedData(): void {
  clearDeviceFilesCache()
  clearAllMeetings()
  console.log('[Database] Cleared all cached data (device files + meetings)')
}

// =============================================================================
// Contact queries
// =============================================================================

export interface Contact {
  id: string
  name: string
  email: string | null
  type: string
  role: string | null
  company: string | null
  notes: string | null
  tags: string | null // JSON string
  is_self: number // SQLite boolean 0 or 1
  first_seen_at: string
  last_seen_at: string
  meeting_count: number
  created_at: string
  voiceprint_count?: number
}

export type ContactRole = 'organizer' | 'attendee'

export interface MeetingContact {
  meeting_id: string
  contact_id: string
  role: ContactRole
}

export function getContacts(search?: string, type?: string, limit = 100, offset = 0): { contacts: Contact[]; total: number } {
  let countSql = 'SELECT COUNT(*) as count FROM contacts c'
  let sql = `SELECT c.*, COALESCE(v.vp_count, 0) AS voiceprint_count
FROM contacts c
LEFT JOIN (
  SELECT contact_id, COUNT(*) AS vp_count
  FROM voiceprints
  WHERE disabled_at IS NULL
  GROUP BY contact_id
) v ON v.contact_id = c.id`
  const params: unknown[] = []
  const whereClauses: string[] = []

  if (search) {
    const escaped = escapeLikePattern(search)
    whereClauses.push("(c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\' OR c.role LIKE ? ESCAPE '\\')")
    params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`)
  }

  if (type && type !== 'all') {
    whereClauses.push('c.type = ?')
    params.push(type)
  }

  if (whereClauses.length > 0) {
    const whereClause = ' WHERE ' + whereClauses.join(' AND ')
    countSql += whereClause
    sql += whereClause
  }

  sql += ' ORDER BY c.meeting_count DESC, c.last_seen_at DESC LIMIT ? OFFSET ?'

  const countResult = queryOne<{ count: number }>(countSql, params)
  const contacts = queryAll<Contact>(sql, [...params, limit, offset])

  return { contacts, total: countResult?.count ?? 0 }
}

export function getContactById(id: string): Contact | undefined {
  return queryOne<Contact>(
    `SELECT c.*, COALESCE(v.vp_count, 0) AS voiceprint_count
FROM contacts c
LEFT JOIN (
  SELECT contact_id, COUNT(*) AS vp_count
  FROM voiceprints
  WHERE disabled_at IS NULL
  GROUP BY contact_id
) v ON v.contact_id = c.id
WHERE c.id = ?`,
    [id]
  )
}

export function getContactByEmail(email: string): Contact | undefined {
  return queryOne<Contact>('SELECT * FROM contacts WHERE email = ?', [email])
}

/**
 * Batch get contacts by emails - avoids N+1 query problem.
 * Returns a Map of email -> Contact for quick lookup.
 */
export function getContactsByEmails(emails: string[]): Map<string, Contact> {
  if (emails.length === 0) return new Map()

  // Remove duplicates and nulls
  const uniqueEmails = [...new Set(emails.filter(Boolean))]
  if (uniqueEmails.length === 0) return new Map()

  const results = new Map<string, Contact>()
  const chunkSize = 100

  for (let i = 0; i < uniqueEmails.length; i += chunkSize) {
    const chunk = uniqueEmails.slice(i, i + chunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const contacts = queryAll<Contact>(
      `SELECT * FROM contacts WHERE email IN (${placeholders})`,
      chunk
    )

    for (const contact of contacts) {
      if (contact.email) {
        results.set(contact.email, contact)
      }
    }
  }

  return results
}

export function upsertContact(contact: Omit<Contact, 'created_at'>): Contact {
  const existing = contact.email ? getContactByEmail(contact.email) : undefined

  if (existing) {
    // Update existing contact
    run(
      `UPDATE contacts SET
        name = COALESCE(?, name),
        last_seen_at = ?,
        meeting_count = meeting_count + 1
      WHERE id = ?`,
      [contact.name, contact.last_seen_at, existing.id]
    )
    return { ...existing, name: contact.name, last_seen_at: contact.last_seen_at, meeting_count: existing.meeting_count + 1 }
  } else {
    // Insert new contact
    run(
      `INSERT INTO contacts (id, name, email, type, role, company, notes, tags, first_seen_at, last_seen_at, meeting_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contact.id,
        contact.name,
        contact.email,
        contact.type || 'unknown',
        contact.role || null,
        contact.company || null,
        contact.notes || null,
        contact.tags || null,
        contact.first_seen_at,
        contact.last_seen_at,
        contact.meeting_count
      ]
    )
    return { ...contact, created_at: new Date().toISOString() } as Contact
  }
}

export function updateContact(id: string, updates: Partial<Contact>): void {
  const fields: string[] = []
  const params: unknown[] = []

  if (updates.name !== undefined) { fields.push('name = ?'); params.push(updates.name); }
  if (updates.email !== undefined) { fields.push('email = ?'); params.push(updates.email); }
  if (updates.type !== undefined) { fields.push('type = ?'); params.push(updates.type); }
  if (updates.role !== undefined) { fields.push('role = ?'); params.push(updates.role); }
  if (updates.company !== undefined) { fields.push('company = ?'); params.push(updates.company); }
  if (updates.notes !== undefined) { fields.push('notes = ?'); params.push(updates.notes); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); params.push(updates.tags); }

  if (fields.length === 0) return

  params.push(id)
  run(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`, params)
}

export function updateContactNotes(id: string, notes: string | null): void {
  run('UPDATE contacts SET notes = ? WHERE id = ?', [notes, id])
}

export function getMeetingsForContact(contactId: string): Meeting[] {
  return queryAll<Meeting>(
    `SELECT m.* FROM meetings m
     JOIN meeting_contacts mc ON m.id = mc.meeting_id
     WHERE mc.contact_id = ?
     ORDER BY m.start_time DESC`,
    [contactId]
  )
}

export function getContactsForMeeting(meetingId: string): Contact[] {
  return queryAll<Contact>(
    `SELECT c.* FROM contacts c
     JOIN meeting_contacts mc ON c.id = mc.contact_id
     WHERE mc.meeting_id = ?`,
    [meetingId]
  )
}

export function deleteContact(id: string): void {
  // Remove junction table entries, voiceprints (biometric data must not survive the
  // person), and stale recording_speakers rows, then the contact — all atomic.
  runInTransaction(() => {
    runNoSave('DELETE FROM meeting_contacts WHERE contact_id = ?', [id])
    runNoSave('DELETE FROM voiceprints WHERE contact_id = ?', [id])
    runNoSave('DELETE FROM recording_speakers WHERE contact_id = ?', [id])
    runNoSave('DELETE FROM contacts WHERE id = ?', [id])
  })
}

export function linkContactToMeeting(meetingId: string, contactId: string, role: ContactRole): void {
  run(
    'INSERT OR IGNORE INTO meeting_contacts (meeting_id, contact_id, role) VALUES (?, ?, ?)',
    [meetingId, contactId, role]
  )
}

// =============================================================================
// Project queries
// =============================================================================

export interface Project {
  id: string
  name: string
  description: string | null
  status: string
  created_at: string
}

export interface MeetingProject {
  meeting_id: string
  project_id: string
}

export function getProjects(search?: string, limit = 100, offset = 0, status?: string): { projects: Project[]; total: number } {
  let countSql = 'SELECT COUNT(*) as count FROM projects'
  let sql = 'SELECT * FROM projects'
  const params: unknown[] = []
  const whereClauses: string[] = []

  if (search) {
    const escaped = escapeLikePattern(search)
    whereClauses.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')")
    params.push(`%${escaped}%`, `%${escaped}%`)
  }

  if (status && status !== 'all') {
    whereClauses.push('status = ?')
    params.push(status)
  }

  if (whereClauses.length > 0) {
    const whereClause = ' WHERE ' + whereClauses.join(' AND ')
    countSql += whereClause
    sql += whereClause
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'

  const countResult = queryOne<{ count: number }>(countSql, params)
  const projects = queryAll<Project>(sql, [...params, limit, offset])

  return { projects, total: countResult?.count ?? 0 }
}

export function getProjectById(id: string): Project | undefined {
  return queryOne<Project>('SELECT * FROM projects WHERE id = ?', [id])
}

export function createProject(project: Omit<Project, 'created_at'>): Project {
  run(
    'INSERT INTO projects (id, name, description, status) VALUES (?, ?, ?, ?)',
    [project.id, project.name, project.description, project.status || 'active']
  )
  return { ...project, created_at: new Date().toISOString() }
}

export function updateProject(id: string, name?: string, description?: string | null, status?: string): void {
  const updates: string[] = []
  const params: unknown[] = []

  if (name !== undefined) {
    updates.push('name = ?')
    params.push(name)
  }
  if (description !== undefined) {
    updates.push('description = ?')
    params.push(description)
  }
  if (status !== undefined) {
    updates.push('status = ?')
    params.push(status)
  }

  if (updates.length > 0) {
    params.push(id)
    run(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, params)
  }
}

export function deleteProject(id: string): void {
  // Junction table entries will be cascade deleted due to FK constraint
  run('DELETE FROM projects WHERE id = ?', [id])
}

export function getMeetingsForProject(projectId: string): Meeting[] {
  return queryAll<Meeting>(
    `SELECT m.* FROM meetings m
     JOIN meeting_projects mp ON m.id = mp.meeting_id
     WHERE mp.project_id = ?
     ORDER BY m.start_time DESC`,
    [projectId]
  )
}

export function getProjectsForMeeting(meetingId: string): Project[] {
  return queryAll<Project>(
    `SELECT p.* FROM projects p
     JOIN meeting_projects mp ON p.id = mp.project_id
     WHERE mp.meeting_id = ?`,
    [meetingId]
  )
}

export function tagMeetingToProject(meetingId: string, projectId: string): void {
  run(
    'INSERT OR IGNORE INTO meeting_projects (meeting_id, project_id) VALUES (?, ?)',
    [meetingId, projectId]
  )
}

export function untagMeetingFromProject(meetingId: string, projectId: string): void {
  run('DELETE FROM meeting_projects WHERE meeting_id = ? AND project_id = ?', [meetingId, projectId])
}

/**
 * Get knowledge capture IDs associated with a project via its meetings.
 * Path: project -> meeting_projects -> meetings -> recordings -> knowledge_captures
 */
export function getKnowledgeIdsForProject(projectId: string): string[] {
  const rows = queryAll<{ id: string }>(
    `SELECT DISTINCT kc.id FROM knowledge_captures kc
     JOIN recordings r ON kc.source_recording_id = r.id
     JOIN meeting_projects mp ON r.meeting_id = mp.meeting_id
     WHERE mp.project_id = ?`,
    [projectId]
  )
  return rows.map(r => r.id)
}

/**
 * Get person/contact IDs associated with a project via its meetings.
 * Path: project -> meeting_projects -> meeting_contacts -> contacts
 */
export function getPersonIdsForProject(projectId: string): string[] {
  const rows = queryAll<{ contact_id: string }>(
    `SELECT DISTINCT mc.contact_id FROM meeting_contacts mc
     JOIN meeting_projects mp ON mc.meeting_id = mp.meeting_id
     WHERE mp.project_id = ?`,
    [projectId]
  )
  return rows.map(r => r.contact_id)
}

/**
 * Get all transcript topics for a project's meetings in a single JOIN query.
 * Eliminates N+1: project -> meeting_projects -> recordings -> transcripts
 * Returns the raw topics JSON strings (caller parses them).
 */
export function getTopicsForProjectMeetings(projectId: string): string[] {
  const rows = queryAll<{ topics: string }>(
    `SELECT t.topics FROM transcripts t
     JOIN recordings r ON t.recording_id = r.id
     JOIN meeting_projects mp ON r.meeting_id = mp.meeting_id
     WHERE mp.project_id = ? AND t.topics IS NOT NULL`,
    [projectId]
  )
  return rows.map(r => r.topics)
}

// =============================================================================
// Recording-Meeting Candidate queries (AI-powered matching)
// =============================================================================

export interface RecordingMeetingCandidate {
  id: string
  recording_id: string
  meeting_id: string
  confidence_score: number
  match_reason: string | null
  is_selected: boolean
  is_ai_selected: boolean
  is_user_confirmed: boolean
  created_at: string
}

/**
 * Find all meetings that overlap with a recording's time window
 * Uses a buffer of 30 minutes before and after the recording
 */
export function findCandidateMeetingsForRecording(recordingId: string): Meeting[] {
  const recording = getRecordingById(recordingId)
  if (!recording) return []

  const recStart = new Date(recording.date_recorded)
  const durationMs = (recording.duration_seconds || 30 * 60) * 1000
  const recEnd = new Date(recStart.getTime() + durationMs)

  // Buffer: 30 min before recording start, 30 min after recording end
  const bufferMs = 30 * 60 * 1000
  const windowStart = new Date(recStart.getTime() - bufferMs).toISOString()
  const windowEnd = new Date(recEnd.getTime() + bufferMs).toISOString()

  // Find meetings that overlap with this time window
  return queryAll<Meeting>(
    `SELECT * FROM meetings
     WHERE (start_time <= ? AND end_time >= ?)
        OR (start_time >= ? AND start_time <= ?)
        OR (end_time >= ? AND end_time <= ?)
     ORDER BY start_time`,
    [windowEnd, windowStart, windowStart, windowEnd, windowStart, windowEnd]
  )
}

/**
 * Add a candidate meeting for a recording
 */
export function addRecordingMeetingCandidate(
  recordingId: string,
  meetingId: string,
  confidenceScore: number,
  matchReason: string,
  isAiSelected: boolean = false
): string {
  const id = crypto.randomUUID()
  run(
    `INSERT OR REPLACE INTO recording_meeting_candidates
      (id, recording_id, meeting_id, confidence_score, match_reason, is_selected, is_ai_selected)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, recordingId, meetingId, confidenceScore, matchReason, isAiSelected ? 1 : 0, isAiSelected ? 1 : 0]
  )

  // If AI selected, also update the recording's meeting_id
  if (isAiSelected) {
    linkRecordingToMeeting(recordingId, meetingId, confidenceScore, 'ai_transcript_match')
  }

  return id
}

/**
 * Get all candidate meetings for a recording
 */
export function getCandidatesForRecording(recordingId: string): Array<RecordingMeetingCandidate & { meeting: Meeting }> {
  const candidates = queryAll<RecordingMeetingCandidate>(
    `SELECT * FROM recording_meeting_candidates WHERE recording_id = ? ORDER BY confidence_score DESC`,
    [recordingId]
  )

  return candidates.map(c => ({
    ...c,
    is_selected: !!c.is_selected,
    is_ai_selected: !!c.is_ai_selected,
    is_user_confirmed: !!c.is_user_confirmed,
    meeting: getMeetingById(c.meeting_id)!
  })).filter(c => c.meeting)
}

/**
 * User selects a different meeting for a recording (override AI selection)
 */
export function selectMeetingForRecording(recordingId: string, meetingId: string): void {
  // Clear previous selection
  run('UPDATE recording_meeting_candidates SET is_selected = 0 WHERE recording_id = ?', [recordingId])

  // Set new selection
  run(
    `UPDATE recording_meeting_candidates SET is_selected = 1, is_user_confirmed = 1 WHERE recording_id = ? AND meeting_id = ?`,
    [recordingId, meetingId]
  )

  // Update the recording's meeting_id
  linkRecordingToMeeting(recordingId, meetingId, 1.0, 'user_override')
}

/**
 * Get recording with its matched meeting and duration comparison
 */
export interface RecordingWithMeetingMatch extends Recording {
  meeting?: Meeting
  duration_match: 'shorter' | 'longer' | 'matched' | 'no_meeting'
  duration_difference_seconds: number
  has_conflicts: boolean
  conflict_count: number
}

export function getRecordingWithMatchInfo(recordingId: string): RecordingWithMeetingMatch | undefined {
  const recording = getRecordingById(recordingId)
  if (!recording) return undefined

  const meeting = recording.meeting_id ? getMeetingById(recording.meeting_id) : undefined
  const candidates = getCandidatesForRecording(recordingId)

  let durationMatch: 'shorter' | 'longer' | 'matched' | 'no_meeting' = 'no_meeting'
  let durationDifference = 0

  if (meeting && recording.duration_seconds) {
    const meetingStart = new Date(meeting.start_time).getTime()
    const meetingEnd = new Date(meeting.end_time).getTime()
    const meetingDurationSeconds = (meetingEnd - meetingStart) / 1000

    durationDifference = recording.duration_seconds - meetingDurationSeconds

    // 5 minute tolerance
    if (Math.abs(durationDifference) < 300) {
      durationMatch = 'matched'
    } else if (durationDifference < 0) {
      durationMatch = 'shorter'
    } else {
      durationMatch = 'longer'
    }
  }

  return {
    ...recording,
    meeting,
    duration_match: durationMatch,
    duration_difference_seconds: durationDifference,
    has_conflicts: candidates.length > 1,
    conflict_count: candidates.length
  }
}

// =============================================================================
// Recording-Meeting Linking Functions (UI Dialog Support)
// =============================================================================

export interface MeetingCandidateWithDetails {
  id: string
  recordingId: string
  meetingId: string
  subject: string
  startTime: string
  endTime: string
  confidenceScore: number
  matchReason: string | null
  isAiSelected: boolean
  isUserConfirmed: boolean
}

export function getCandidatesForRecordingWithDetails(recordingId: string): MeetingCandidateWithDetails[] {
  if (!recordingId || typeof recordingId !== 'string') return []

  const sql = `
    SELECT c.id, c.recording_id, c.meeting_id, c.confidence_score, c.match_reason,
      c.is_ai_selected, c.is_user_confirmed, m.subject, m.start_time, m.end_time
    FROM recording_meeting_candidates c
    JOIN meetings m ON m.id = c.meeting_id
    WHERE c.recording_id = ?
    ORDER BY c.confidence_score DESC LIMIT 20
  `

  try {
    const rows = queryAll<{
      id: string; recording_id: string; meeting_id: string; confidence_score: number
      match_reason: string | null; is_ai_selected: number; is_user_confirmed: number
      subject: string; start_time: string; end_time: string
    }>(sql, [recordingId])

    return rows.map(r => ({
      id: r.id, recordingId: r.recording_id, meetingId: r.meeting_id,
      subject: r.subject, startTime: r.start_time, endTime: r.end_time,
      confidenceScore: r.confidence_score, matchReason: r.match_reason,
      isAiSelected: r.is_ai_selected === 1, isUserConfirmed: r.is_user_confirmed === 1
    }))
  } catch (error) {
    console.error('Failed to get candidates for recording:', error)
    return []
  }
}

export function getMeetingsNearDate(date: string): Meeting[] {
  if (!date || typeof date !== 'string') return []
  const targetDate = new Date(date)
  if (isNaN(targetDate.getTime())) return []

  const bufferMs = 12 * 60 * 60 * 1000
  const startWindow = new Date(targetDate.getTime() - bufferMs)
  const endWindow = new Date(targetDate.getTime() + bufferMs)

  try {
    return queryAll<Meeting>(
      `SELECT * FROM meetings WHERE start_time >= ? AND start_time <= ?
       ORDER BY ABS(JULIANDAY(start_time) - JULIANDAY(?)) LIMIT 20`,
      [startWindow.toISOString(), endWindow.toISOString(), targetDate.toISOString()]
    )
  } catch (error) {
    console.error('Failed to get meetings near date:', error)
    return []
  }
}

export function selectMeetingForRecordingByUser(recordingId: string, meetingId: string | null): void {
  if (!recordingId || typeof recordingId !== 'string') throw new Error('Invalid recording ID')

  runInTransaction(() => {
    if (meetingId !== null && !getMeetingById(meetingId)) {
      throw new Error(`Meeting ${meetingId} no longer exists`)
    }
    run('UPDATE recording_meeting_candidates SET is_selected = 0 WHERE recording_id = ?', [recordingId])

    if (meetingId === null) {
      run(`UPDATE recordings SET meeting_id = NULL, correlation_confidence = NULL,
           correlation_method = 'user_standalone' WHERE id = ?`, [recordingId])
    } else {
      run(`UPDATE recording_meeting_candidates SET is_selected = 1, is_user_confirmed = 1
           WHERE recording_id = ? AND meeting_id = ?`, [recordingId, meetingId])
      linkRecordingToMeeting(recordingId, meetingId, 1.0, 'user_override')
    }
  })
}

export function resetStuckTranscriptions(): { recordingsReset: number; queueItemsReset: number } {
  const recordingsInfo = getDatabase()
    .prepare("UPDATE recordings SET transcription_status = 'none' WHERE transcription_status IN ('processing', 'pending')")
    .run()
  const recordingsReset = recordingsInfo.changes
  const queueInfo = getDatabase()
    .prepare("UPDATE transcription_queue SET status = 'pending' WHERE status = 'processing'")
    .run()
  const queueItemsReset = queueInfo.changes
  console.log(`[Database] Reset stuck transcriptions: ${recordingsReset} recordings, ${queueItemsReset} queue items`)
  return { recordingsReset, queueItemsReset }
}

// =============================================================================
// Quality Assessment queries (v10)
// =============================================================================

export interface QualityAssessment {
  id: string
  recording_id: string
  quality: 'high' | 'medium' | 'low'
  assessment_method: 'auto' | 'manual'
  confidence: number
  reason?: string
  assessed_at: string
  assessed_by?: string
}

export function getQualityAssessment(recordingId: string): QualityAssessment | undefined {
  return queryOne<QualityAssessment>('SELECT * FROM quality_assessments WHERE recording_id = ?', [recordingId])
}

export function upsertQualityAssessment(assessment: Omit<QualityAssessment, 'assessed_at'>): void {
  const existing = getQualityAssessment(assessment.recording_id)

  if (existing) {
    run(
      `UPDATE quality_assessments SET
        quality = ?, assessment_method = ?, confidence = ?, reason = ?, assessed_by = ?
      WHERE recording_id = ?`,
      [
        assessment.quality,
        assessment.assessment_method,
        assessment.confidence,
        assessment.reason ?? null,
        assessment.assessed_by ?? null,
        assessment.recording_id
      ]
    )
  } else {
    run(
      `INSERT INTO quality_assessments (id, recording_id, quality, assessment_method, confidence, reason, assessed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        assessment.id,
        assessment.recording_id,
        assessment.quality,
        assessment.assessment_method,
        assessment.confidence,
        assessment.reason ?? null,
        assessment.assessed_by ?? null
      ]
    )
  }
}

export function getRecordingsByQuality(quality: 'high' | 'medium' | 'low'): Recording[] {
  return queryAll<Recording>(
    `SELECT r.* FROM recordings r
     JOIN quality_assessments qa ON r.id = qa.recording_id
     WHERE qa.quality = ?
     ORDER BY r.date_recorded DESC`,
    [quality]
  )
}

export function updateRecordingStorageTier(
  recordingId: string,
  tier: 'hot' | 'warm' | 'cold' | 'archive' | null
): void {
  run('UPDATE recordings SET storage_tier = ? WHERE id = ?', [tier, recordingId])
}

export function getRecordingsByStorageTier(tier: 'hot' | 'warm' | 'cold' | 'archive'): Recording[] {
  return queryAll<Recording>(
    'SELECT * FROM recordings WHERE storage_tier = ? ORDER BY date_recorded DESC',
    [tier]
  )
}

// =============================================================================
// Async wrappers for database operations (prevents main thread blocking)
// =============================================================================

/**
 * Async wrapper for getRecordingById - yields to event loop using setImmediate
 * Use this in non-batch operations to prevent blocking the main thread
 */
export async function getRecordingByIdAsync(id: string): Promise<Recording | undefined> {
  return new Promise((resolve) => {
    setImmediate(() => {
      if (!db) { resolve(undefined); return }
      resolve(getRecordingById(id))
    })
  })
}

/**
 * Async wrapper for getTranscriptByRecordingId - yields to event loop using setImmediate
 */
export async function getTranscriptByRecordingIdAsync(recordingId: string): Promise<Transcript | undefined> {
  return new Promise((resolve) => {
    setImmediate(() => {
      if (!db) { resolve(undefined); return }
      resolve(getTranscriptByRecordingId(recordingId))
    })
  })
}

/**
 * Async wrapper for queryAll - yields to event loop using setImmediate
 */
export async function queryAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve) => {
    setImmediate(() => {
      if (!db) { resolve([]); return }
      resolve(queryAll<T>(sql, params))
    })
  })
}

/**
 * Async wrapper for upsertQualityAssessment - yields to event loop using setImmediate
 */
export async function upsertQualityAssessmentAsync(assessment: Omit<QualityAssessment, 'assessed_at'>): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => {
      if (!db) { resolve(); return }
      upsertQualityAssessment(assessment)
      resolve()
    })
  })
}

/**
 * Async wrapper for getQualityAssessment - yields to event loop using setImmediate
 */
export async function getQualityAssessmentAsync(recordingId: string): Promise<QualityAssessment | undefined> {
  return new Promise((resolve) => {
    setImmediate(() => {
      if (!db) { resolve(undefined); return }
      resolve(getQualityAssessment(recordingId))
    })
  })
}

/**
 * Async wrapper for updateRecordingStorageTier - yields to event loop using setImmediate
 */
export async function updateRecordingStorageTierAsync(
  recordingId: string,
  tier: 'hot' | 'warm' | 'cold' | 'archive' | null
): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => {
      if (!db) { resolve(); return }
      updateRecordingStorageTier(recordingId, tier)
      resolve()
    })
  })
}

// =============================================================================
// Transcription Service Mutex Lock (spec-005)
// =============================================================================

/**
 * Clear any stale transcription lock left by a previous app instance.
 * Must be called once on startup before the transcription processor starts.
 * The lock is per-process-run (process_id includes Date.now()), so any lock
 * present at startup is guaranteed stale — the process that held it is dead.
 */
export function clearStaleTranscriptionLock(): void {
  const database = getDatabase()
  const now = new Date().toISOString()

  // Ensure the lock row exists (handles edge case where migration didn't insert it)
  database.prepare(
    `INSERT OR IGNORE INTO transcription_service_lock (id, process_id, acquired_at, updated_at) VALUES (1, NULL, NULL, ?)`
  ).run(now)

  // Unconditionally clear the lock
  database.prepare(
    `UPDATE transcription_service_lock SET process_id = NULL, acquired_at = NULL, updated_at = ? WHERE id = 1`
  ).run(now)

  console.log('[Transcription] Stale lock cleared on startup')
}

/**
 * Atomically acquire the transcription service lock.
 * Uses a database transaction to ensure only one process can acquire the lock.
 * @param processId Unique process identifier
 * @returns true if lock acquired, false if already locked
 */
export function acquireTranscriptionLock(processId: string): boolean {
  const database = getDatabase()
  const now = new Date().toISOString()

  // Check current lock status before attempting to acquire
  const currentStatus = database.prepare('SELECT process_id, acquired_at FROM transcription_service_lock WHERE id = 1')
    .get() as { process_id: string | null; acquired_at: string | null } | undefined
  const currentProcessId = currentStatus?.process_id ?? null

  // If already locked by another process, check for stale lock (held > 5 minutes)
  if (currentProcessId !== null) {
    const acquiredAt = currentStatus?.acquired_at ?? null
    const STALE_LOCK_TIMEOUT_MS = 5 * 60 * 1000
    if (acquiredAt) {
      const lockAge = Date.now() - new Date(acquiredAt).getTime()
      if (lockAge > STALE_LOCK_TIMEOUT_MS) {
        console.warn(`[Transcription] Force-clearing stale lock held by ${currentProcessId} for ${Math.round(lockAge / 1000)}s`)
        database.prepare(
          `UPDATE transcription_service_lock SET process_id = NULL, acquired_at = NULL, updated_at = ? WHERE id = 1`
        ).run(now)
        // Fall through to acquire
      } else {
        return false
      }
    } else {
      return false
    }
  }

  // Atomic check-and-set using UPDATE with WHERE clause
  // If process_id is NULL, set it to our processId
  database.prepare(
    `UPDATE transcription_service_lock
     SET process_id = ?, acquired_at = ?, updated_at = ?
     WHERE id = 1 AND process_id IS NULL`
  ).run(processId, now, now)

  // Verify we acquired the lock by checking again
  const verifyStatus = database.prepare('SELECT process_id FROM transcription_service_lock WHERE id = 1')
    .get() as { process_id: string | null } | undefined
  const newProcessId = verifyStatus?.process_id ?? null

  return newProcessId === processId
}

/**
 * Release the transcription service lock.
 * @param processId The process ID that currently holds the lock
 * @returns true if lock released, false if not held by this process
 */
export function releaseTranscriptionLock(processId: string): boolean {
  const database = getDatabase()

  // Check if we currently hold the lock
  const currentStatus = database.prepare('SELECT process_id FROM transcription_service_lock WHERE id = 1')
    .get() as { process_id: string | null } | undefined
  const currentProcessId = currentStatus?.process_id ?? null

  if (currentProcessId !== processId) {
    return false // Not our lock to release
  }

  // Release the lock
  database.prepare(
    `UPDATE transcription_service_lock
     SET process_id = NULL, acquired_at = NULL, updated_at = ?
     WHERE id = 1 AND process_id = ?`
  ).run(new Date().toISOString(), processId)

  // Verify lock was released
  const verifyStatus = database.prepare('SELECT process_id FROM transcription_service_lock WHERE id = 1')
    .get() as { process_id: string | null } | undefined
  const newProcessId = verifyStatus?.process_id ?? null

  return newProcessId === null
}

// ── Template-run audit (Task 11) ──────────────────────────────────────────

/** All fields that may be stored for a single template-selector run. */
export interface TemplateRunRecord {
  recordingId: string
  templateId?: string | null
  selectionKind: string
  selectionConfidence: number
  runnerupConfidence?: number
  candidateScoresJson?: string
  selectionReason?: string
  selectorProvider?: string
  selectorModel?: string
  selectorElapsedMs?: number
  fullTextHash?: string
  suggestedTemplateJson?: string
  appliedInstructionsHash?: string
}

/**
 * Insert an audit row into `transcript_template_runs` for a completed selector run.
 * The `id` is auto-generated (`tplrun_<uuid>`); `created_at` is set to CURRENT_TIMESTAMP.
 */
export function recordTemplateRun(rec: TemplateRunRecord): void {
  run(
    `INSERT INTO transcript_template_runs (
       id, recording_id, template_id, selection_kind, selection_confidence,
       runnerup_confidence, candidate_scores_json, selection_reason,
       selector_provider, selector_model, selector_elapsed_ms, full_text_hash,
       suggested_template_json, applied_instructions_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      `tplrun_${randomUUID()}`,
      rec.recordingId,
      rec.templateId ?? null,
      rec.selectionKind,
      rec.selectionConfidence,
      rec.runnerupConfidence ?? null,
      rec.candidateScoresJson ?? null,
      rec.selectionReason ?? null,
      rec.selectorProvider ?? null,
      rec.selectorModel ?? null,
      rec.selectorElapsedMs ?? null,
      rec.fullTextHash ?? null,
      rec.suggestedTemplateJson ?? null,
      rec.appliedInstructionsHash ?? null,
    ]
  )
}

/**
 * Returns the most-recent template-selector run for the given recording
 * (ordered by `created_at` DESC, then insertion order via `rowid`),
 * or `null` when no run exists yet.
 *
 * Used as the §5.5 selection cache: if `full_text_hash` matches the current
 * transcript hash, the caller may reuse the prior selection instead of re-running
 * the selector.
 */
export function getLatestTemplateRun(
  recordingId: string
): (TemplateRunRecord & { id: string; createdAt: string }) | null {
  const r = queryOne<{
    id: string
    recording_id: string
    template_id: string | null
    selection_kind: string
    selection_confidence: number
    runnerup_confidence: number | null
    candidate_scores_json: string | null
    selection_reason: string | null
    selector_provider: string | null
    selector_model: string | null
    selector_elapsed_ms: number | null
    full_text_hash: string | null
    suggested_template_json: string | null
    applied_instructions_hash: string | null
    created_at: string
  }>(
    'SELECT * FROM transcript_template_runs WHERE recording_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [recordingId]
  )
  if (!r) return null
  return {
    id: r.id,
    recordingId: r.recording_id,
    templateId: r.template_id ?? undefined,
    selectionKind: r.selection_kind,
    selectionConfidence: r.selection_confidence,
    runnerupConfidence: r.runnerup_confidence ?? undefined,
    candidateScoresJson: r.candidate_scores_json ?? undefined,
    selectionReason: r.selection_reason ?? undefined,
    selectorProvider: r.selector_provider ?? undefined,
    selectorModel: r.selector_model ?? undefined,
    selectorElapsedMs: r.selector_elapsed_ms ?? undefined,
    fullTextHash: r.full_text_hash ?? undefined,
    suggestedTemplateJson: r.suggested_template_json ?? undefined,
    appliedInstructionsHash: r.applied_instructions_hash ?? undefined,
    createdAt: r.created_at,
  }
}

/**
 * Get the current transcription lock status.
 * @returns Lock status with process_id and timestamps
 */
export function getTranscriptionLockStatus(): {
  processId: string | null
  acquiredAt: string | null
  updatedAt: string | null
} {
  const database = getDatabase()
  const row = database.prepare('SELECT process_id, acquired_at, updated_at FROM transcription_service_lock WHERE id = 1')
    .get() as { process_id: string | null; acquired_at: string | null; updated_at: string | null } | undefined

  if (row) {
    return { processId: row.process_id, acquiredAt: row.acquired_at, updatedAt: row.updated_at }
  }

  return { processId: null, acquiredAt: null, updatedAt: null }
}
