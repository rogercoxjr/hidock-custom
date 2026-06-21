import { parseAttendees } from '@/types'
import type { Meeting } from '@/types'
import type { CapturePerson } from '../types/captureMeta'

/**
 * Derive capture people (slice 1: meeting attendees only).
 * Slice 2 will add diarized/assigned speakers from recording_speakers.
 */
export function deriveCapturePeople(meeting?: Meeting): CapturePerson[] {
  if (!meeting) return []
  const attendees = parseAttendees(meeting.attendees)
  const people: CapturePerson[] = []
  for (const attendee of attendees) {
    const name = attendee.name?.trim() || attendee.email?.trim()
    if (!name) continue
    people.push({ name, source: 'attendee' })
  }
  return people
}

/**
 * Stable primitive key from a people array — safe to use in memo comparators
 * without array allocation per comparison.
 */
export function buildPeopleKey(people: CapturePerson[]): string {
  return people.map((p) => p.name).join('|')
}
