/**
 * A person associated with a capture — derived renderer-side from meeting
 * attendees (slice 1) or diarized speakers (slice 2, fast-follow).
 */
export interface CapturePerson {
  /** Contact ID if known (from attendee or speaker record). */
  id?: string
  name: string
  source: 'attendee' | 'speaker'
  /** True if this person is the app user (used to hide self on cards). Slice 1: always undefined. */
  isSelf?: boolean
}

/**
 * A label associated with a capture — category (slice 1) or topic chip (slice 2).
 */
export interface CaptureLabel {
  text: string
  kind: 'category' | 'topic'
  /**
   * Tailwind utility string for the dot color (e.g. "bg-accent-2").
   * Set only for category kind. Topics are uncolored in slice 1.
   */
  colorClass?: string
}
