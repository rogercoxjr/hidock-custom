/**
 * Vector Store Service
 * Simple in-memory vector store with SQLite persistence for meeting transcript embeddings
 */

import { getDatabase } from './database'
import { getEmbeddingService } from './embeddings/embedding-provider'

interface VectorDocument {
  id: string
  content: string
  embedding: number[]
  metadata: {
    meetingId?: string
    recordingId?: string
    chunkIndex: number
    timestamp?: string
    subject?: string
  }
}

interface SearchResult {
  document: VectorDocument
  score: number
}

// Cosine similarity between two vectors
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dotProduct / denominator
}

// Split text into chunks for embedding
function chunkText(text: string, chunkSize = 500, overlap = 50): string[] {
  const chunks: string[] = []
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0)

  let currentChunk = ''

  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (currentChunk.length + trimmed.length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())
      // Keep overlap from end of previous chunk
      const words = currentChunk.split(' ')
      const overlapWords = words.slice(-Math.ceil(overlap / 10))
      currentChunk = overlapWords.join(' ') + ' ' + trimmed
    } else {
      currentChunk += (currentChunk.length > 0 ? '. ' : '') + trimmed
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim())
  }

  return chunks
}

class VectorStore {
  private documents: Map<string, VectorDocument> = new Map()
  private initialized = false

  async initialize(): Promise<void> {
    if (this.initialized) return

    const db = getDatabase()

    // Create vector_embeddings table (separate from database.ts embeddings table)
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_embeddings (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        meeting_id TEXT,
        recording_id TEXT,
        chunk_index INTEGER,
        timestamp TEXT,
        subject TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Create index for faster lookups
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vector_embeddings_meeting ON vector_embeddings(meeting_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vector_embeddings_recording ON vector_embeddings(recording_id)`)

    // Load existing embeddings into memory
    await this.loadFromDatabase()

    this.initialized = true
    console.log(`Vector store initialized with ${this.documents.size} documents`)
  }

  private async loadFromDatabase(): Promise<void> {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM vector_embeddings').all() as Array<Record<string, unknown>>

    for (const row of rows) {
      const vectorDoc: VectorDocument = {
        id: row['id'] as string,
        content: row['content'] as string,
        embedding: JSON.parse(row['embedding'] as string),
        metadata: {
          meetingId: row['meeting_id'] as string | undefined,
          recordingId: row['recording_id'] as string | undefined,
          chunkIndex: row['chunk_index'] as number,
          timestamp: row['timestamp'] as string | undefined,
          subject: row['subject'] as string | undefined
        }
      }

      this.documents.set(vectorDoc.id, vectorDoc)
    }
  }

  async addDocument(
    content: string,
    metadata: VectorDocument['metadata']
  ): Promise<string | null> {
    const embeddings = getEmbeddingService()

    // Generate embedding. On failure the embedding service has already logged a
    // single concise warning — return null silently to avoid a per-chunk flood.
    const embedding = await embeddings.generateEmbedding(content)
    if (!embedding) {
      return null
    }

    const id = `${metadata.recordingId || 'doc'}_${metadata.chunkIndex}_${Date.now()}`

    const doc: VectorDocument = {
      id,
      content,
      embedding,
      metadata
    }

    // Store in memory
    this.documents.set(id, doc)

    // Persist to database
    const db = getDatabase()
    db.prepare(
      `INSERT OR REPLACE INTO vector_embeddings
       (id, content, embedding, meeting_id, recording_id, chunk_index, timestamp, subject)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      content,
      JSON.stringify(embedding),
      metadata.meetingId ?? null,
      metadata.recordingId ?? null,
      metadata.chunkIndex,
      metadata.timestamp ?? null,
      metadata.subject ?? null
    )

    return id
  }

  async indexTranscript(
    transcript: string,
    metadata: {
      meetingId?: string
      recordingId?: string
      timestamp?: string
      subject?: string
    }
  ): Promise<number> {
    // Check if already indexed
    if (metadata.recordingId) {
      const existing = Array.from(this.documents.values()).filter(
        (d) => d.metadata.recordingId === metadata.recordingId
      )
      if (existing.length > 0) {
        console.log(`Transcript ${metadata.recordingId} already indexed`)
        return 0
      }
    }

    // Chunk the transcript
    const chunks = chunkText(transcript)
    let indexed = 0

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const id = await this.addDocument(chunk, {
        ...metadata,
        chunkIndex: i
      })

      if (id) indexed++
    }

    console.log(`Indexed ${indexed} chunks for transcript`)
    return indexed
  }

  async search(query: string, topK = 5): Promise<SearchResult[]> {
    const embeddings = getEmbeddingService()

    // Generate query embedding. On failure the embedding service has already
    // logged a single concise warning — return empty results silently.
    const queryEmbedding = await embeddings.generateEmbedding(query)
    if (!queryEmbedding) {
      return []
    }

    // Calculate similarity scores
    const results: SearchResult[] = []

    for (const doc of this.documents.values()) {
      const score = cosineSimilarity(queryEmbedding, doc.embedding)
      results.push({ document: doc, score })
    }

    // Sort by score descending and take top K
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  async searchByMeeting(meetingId: string): Promise<VectorDocument[]> {
    return Array.from(this.documents.values())
      .filter((d) => d.metadata.meetingId === meetingId)
      .sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex)
  }

  async deleteByRecording(recordingId: string): Promise<number> {
    let deleted = 0
    const db = getDatabase()

    for (const [id, doc] of this.documents.entries()) {
      if (doc.metadata.recordingId === recordingId) {
        this.documents.delete(id)
        deleted++
      }
    }

    db.prepare('DELETE FROM vector_embeddings WHERE recording_id = ?').run(recordingId)
    return deleted
  }

  /**
   * AI-06 FIX: Update meeting_id for all chunks belonging to a recording
   * Called when AI links a recording to a meeting after transcription
   */
  async updateMeetingIdForRecording(recordingId: string, meetingId: string, meetingSubject?: string): Promise<number> {
    let updated = 0
    const db = getDatabase()

    // Update in-memory documents
    for (const doc of this.documents.values()) {
      if (doc.metadata.recordingId === recordingId) {
        doc.metadata.meetingId = meetingId
        if (meetingSubject) {
          doc.metadata.subject = meetingSubject
        }
        updated++
      }
    }

    // Update in database
    if (meetingSubject) {
      db.prepare(
        'UPDATE vector_embeddings SET meeting_id = ?, subject = ? WHERE recording_id = ?'
      ).run(meetingId, meetingSubject, recordingId)
    } else {
      db.prepare(
        'UPDATE vector_embeddings SET meeting_id = ? WHERE recording_id = ?'
      ).run(meetingId, recordingId)
    }

    console.log(`Updated meeting_id for ${updated} vector chunks (recording ${recordingId} -> meeting ${meetingId})`)
    return updated
  }

  getDocumentCount(): number {
    return this.documents.size
  }

  getMeetingCount(): number {
    const meetingIds = new Set<string>()
    for (const doc of this.documents.values()) {
      if (doc.metadata.meetingId) {
        meetingIds.add(doc.metadata.meetingId)
      }
    }
    return meetingIds.size
  }

  getAllDocuments(): VectorDocument[] {
    return Array.from(this.documents.values())
  }
}

// Singleton instance
let vectorStoreInstance: VectorStore | null = null

export function getVectorStore(): VectorStore {
  if (!vectorStoreInstance) {
    vectorStoreInstance = new VectorStore()
  }
  return vectorStoreInstance
}

export { VectorStore, chunkText, cosineSimilarity }
export type { VectorDocument, SearchResult }
