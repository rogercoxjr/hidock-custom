/**
 * AssistantPanel Component
 *
 * AI Assistant panel for the Library tri-pane layout.
 * Provides context-aware suggestions and quick actions for selected recordings.
 *
 * Security:
 * - User input sanitized before display
 * - AI responses rendered as text-only (no HTML injection)
 * - Query length limited to 500 characters
 * - Rate limiting enforced (max 10 queries per minute)
 */

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { UnifiedRecording, hasLocalPath } from '@/types/unified-recording'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Sparkles, FileText, Lightbulb, AlertCircle, Send } from 'lucide-react'

interface AssistantPanelProps {
  recording: UnifiedRecording | null
  transcript?: { question_suggestions: string | null } | null
  onAskAssistant?: (recording: UnifiedRecording) => void
  onGenerateOutput?: (recording: UnifiedRecording) => void
}

const MAX_QUERY_LENGTH = 500
const MAX_QUERIES_PER_MINUTE = 10

export function AssistantPanel({ recording, transcript, onAskAssistant, onGenerateOutput }: AssistantPanelProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [queryCount, setQueryCount] = useState(0)
  const [rateLimitReset, setRateLimitReset] = useState<number | null>(null)

  // Rate limiting: reset count every minute
  useEffect(() => {
    if (queryCount > 0 && !rateLimitReset) {
      const resetTime = Date.now() + 60000 // 1 minute from now
      setRateLimitReset(resetTime)

      const timer = setTimeout(() => {
        setQueryCount(0)
        setRateLimitReset(null)
      }, 60000)

      return () => clearTimeout(timer)
    }
    return undefined
  }, [queryCount, rateLimitReset])

  const handleQuerySubmit = () => {
    if (!recording || !query.trim()) return

    // Rate limiting check
    if (queryCount >= MAX_QUERIES_PER_MINUTE) {
      alert('Rate limit exceeded. Please wait before submitting more queries.')
      return
    }

    // Sanitize input (basic trim and length limit)
    const sanitizedQuery = query.trim().slice(0, MAX_QUERY_LENGTH)

    // Increment query count for rate limiting
    setQueryCount((prev) => prev + 1)

    // Navigate to assistant with context
    navigate('/assistant', {
      state: {
        contextId: recording.knowledgeCaptureId || recording.id,
        initialQuery: sanitizedQuery
      }
    })

    // Clear input
    setQuery('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleQuerySubmit()
    }
  }

  const isRateLimited = queryCount >= MAX_QUERIES_PER_MINUTE
  const canQuery = recording && query.trim().length > 0 && !isRateLimited

  // Parse dynamic questions from transcript, fallback to default questions
  const suggestedQuestions = (() => {
    if (transcript?.question_suggestions) {
      try {
        const parsed = JSON.parse(transcript.question_suggestions)
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed
        }
      } catch (e) {
        console.warn('Failed to parse question_suggestions:', e)
      }
    }
    // Fallback to default questions
    return [
      'What were the key topics discussed?',
      'What action items were mentioned?',
      'Summarize the main decisions made'
    ]
  })()

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header — sparkle (teal accent) + Assistant title + capture meta */}
      <div className="flex-none px-[var(--space-4)] py-[var(--space-3)] border-b border-border flex items-center gap-[9px]">
        <Sparkles className="h-[17px] w-[17px] text-accent-2 flex-none" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">Assistant</div>
          {recording && (
            <div className="font-mono text-[10px] text-ink-muted overflow-hidden text-ellipsis whitespace-nowrap">
              {recording.title || recording.filename}
            </div>
          )}
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto px-[var(--space-4)] py-[var(--space-4)]">
        {recording ? (
          <div className="flex flex-col gap-[var(--space-4)]">
            {/* Quick Actions — chip row */}
            {(recording.transcriptionStatus === 'complete' || hasLocalPath(recording)) && (
              <div className="flex flex-col gap-2">
                <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-muted">
                  Quick Actions
                </div>
                <div className="flex flex-wrap gap-[6px]">
                  {recording.transcriptionStatus === 'complete' && (
                    <button
                      className="inline-flex items-center gap-[6px] px-[11px] py-[6px] bg-surface border border-border rounded-full text-xs font-medium text-foreground hover:bg-surface-hover transition-colors"
                      onClick={() => onGenerateOutput?.(recording)}
                    >
                      <FileText className="h-[13px] w-[13px] text-accent-2" />
                      Generate Meeting Minutes
                    </button>
                  )}

                  {hasLocalPath(recording) && (
                    <button
                      className="inline-flex items-center gap-[6px] px-[11px] py-[6px] bg-surface border border-border rounded-full text-xs font-medium text-foreground hover:bg-surface-hover transition-colors"
                      onClick={() => onAskAssistant?.(recording)}
                    >
                      <Lightbulb className="h-[13px] w-[13px] text-accent-2" />
                      Ask about this recording
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Suggested Questions — assistant-bubble styled prompts */}
            <div className="flex flex-col gap-2">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-muted">
                Suggested Questions
              </div>
              <div className="flex flex-col gap-[var(--space-3)]">
                {suggestedQuestions.map((question, index) => (
                  <button
                    key={index}
                    className="self-start max-w-[86%] text-left text-[13px] leading-[1.55] px-[13px] py-[10px] rounded-lg rounded-bl-[4px] bg-surface-sunken border border-border text-ink hover:bg-surface-hover transition-colors"
                    onClick={() => setQuery(question)}
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center text-ink-muted py-8">
            <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">Select a recording to get AI assistance</p>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex-none px-[var(--space-4)] py-[var(--space-3)] border-t border-border space-y-2">
        {isRateLimited && (
          <div className="flex items-start gap-2 p-2 bg-danger-soft text-danger text-xs rounded-md">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p>Rate limit reached. Wait {Math.ceil((rateLimitReset! - Date.now()) / 1000)}s before submitting more queries.</p>
          </div>
        )}
        <div className="flex items-end gap-2 bg-surface border-[1.5px] border-border rounded-lg pl-3 pr-2 py-2">
          <Textarea
            placeholder={
              recording
                ? 'Ask about this capture…'
                : 'Select a recording first'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, MAX_QUERY_LENGTH))}
            onKeyDown={handleKeyDown}
            disabled={!recording || isRateLimited}
            className="flex-1 min-h-0 resize-none border-none bg-transparent px-0 py-1 shadow-none focus-visible:ring-0 text-[13px] text-ink"
            rows={2}
          />
          <Button
            size="icon"
            onClick={handleQuerySubmit}
            disabled={!canQuery}
            className="h-8 w-8 flex-none rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
            aria-label="Ask"
          >
            <Send className="h-[15px] w-[15px]" />
          </Button>
        </div>
        <div className="flex items-center justify-end">
          <span className="text-xs text-ink-muted">
            {query.length}/{MAX_QUERY_LENGTH}
          </span>
        </div>
      </div>
    </div>
  )
}
