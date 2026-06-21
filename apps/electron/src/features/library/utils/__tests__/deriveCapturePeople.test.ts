import { describe, it, expect } from 'vitest'
import { deriveCapturePeople, buildPeopleKey } from '../deriveCapturePeople'
import type { Meeting } from '@/types'

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    subject: 'Test Meeting',
    start_time: '2026-01-01T09:00:00Z',
    end_time: '2026-01-01T10:00:00Z',
    location: null,
    organizer_name: null,
    organizer_email: null,
    attendees: null,
    description: null,
    is_recurring: 0,
    recurrence_rule: null,
    meeting_url: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('deriveCapturePeople', () => {
  it('returns empty array when meeting is undefined', () => {
    expect(deriveCapturePeople(undefined)).toEqual([])
  })

  it('returns empty array when meeting has no attendees', () => {
    expect(deriveCapturePeople(makeMeeting({ attendees: null }))).toEqual([])
  })

  it('returns empty array when attendees is empty JSON array', () => {
    expect(deriveCapturePeople(makeMeeting({ attendees: '[]' }))).toEqual([])
  })

  it('derives people from attendees with names', () => {
    const attendees = JSON.stringify([
      { name: 'Alice Smith', email: 'alice@example.com' },
      { name: 'Bob Jones', email: 'bob@example.com' },
    ])
    const people = deriveCapturePeople(makeMeeting({ attendees }))
    expect(people).toHaveLength(2)
    expect(people[0]).toMatchObject({ name: 'Alice Smith', source: 'attendee' })
    expect(people[1]).toMatchObject({ name: 'Bob Jones', source: 'attendee' })
  })

  it('falls back to email when name is missing', () => {
    const attendees = JSON.stringify([{ email: 'noname@example.com' }])
    const people = deriveCapturePeople(makeMeeting({ attendees }))
    expect(people).toHaveLength(1)
    expect(people[0].name).toBe('noname@example.com')
  })

  it('skips attendees with no name AND no email', () => {
    const attendees = JSON.stringify([{}, { name: 'Alice' }])
    const people = deriveCapturePeople(makeMeeting({ attendees }))
    expect(people).toHaveLength(1)
    expect(people[0].name).toBe('Alice')
  })

  it('handles malformed JSON gracefully (returns empty array)', () => {
    const people = deriveCapturePeople(makeMeeting({ attendees: 'not-json' }))
    expect(people).toEqual([])
  })
})

describe('buildPeopleKey', () => {
  it('returns empty string for empty array', () => {
    expect(buildPeopleKey([])).toBe('')
  })

  it('produces stable key: same people → same string', () => {
    const attendees = JSON.stringify([{ name: 'Alice Smith' }])
    const a = deriveCapturePeople(makeMeeting({ attendees }))
    const b = deriveCapturePeople(makeMeeting({ attendees }))
    expect(buildPeopleKey(a)).toBe(buildPeopleKey(b))
  })

  it('produces different key for different people', () => {
    const a = buildPeopleKey([{ name: 'Alice', source: 'attendee' }])
    const b = buildPeopleKey([{ name: 'Bob', source: 'attendee' }])
    expect(a).not.toBe(b)
  })

  it('produces different key for different count', () => {
    const a = buildPeopleKey([{ name: 'Alice', source: 'attendee' }])
    const b = buildPeopleKey([{ name: 'Alice', source: 'attendee' }, { name: 'Bob', source: 'attendee' }])
    expect(a).not.toBe(b)
  })
})
