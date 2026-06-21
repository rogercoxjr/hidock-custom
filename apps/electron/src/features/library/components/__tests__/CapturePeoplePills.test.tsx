import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { CapturePeoplePills } from '../CapturePeoplePills'
import type { CapturePerson } from '../../types/captureMeta'

const people3: CapturePerson[] = [
  { name: 'Alice Smith', source: 'attendee' },
  { name: 'Bob Jones', source: 'attendee' },
  { name: 'Carol Davis', source: 'attendee' },
]

const people5: CapturePerson[] = [
  ...people3,
  { name: 'Dave Brown', source: 'attendee' },
  { name: 'Eve Miller', source: 'attendee' },
]

describe('CapturePeoplePills', () => {
  it('renders nothing when people is empty', () => {
    const { container } = render(<CapturePeoplePills people={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders up to cap (default 3) visible names', () => {
    render(<CapturePeoplePills people={people3} />)
    expect(screen.getByText('Alice Smith')).toBeInTheDocument()
    expect(screen.getByText('Bob Jones')).toBeInTheDocument()
    expect(screen.getByText('Carol Davis')).toBeInTheDocument()
  })

  it('renders "+N" overflow pill when count exceeds cap', () => {
    render(<CapturePeoplePills people={people5} />)
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('does NOT render overflow pill when count equals cap', () => {
    render(<CapturePeoplePills people={people3} cap={3} />)
    expect(screen.queryByText(/^\+\d+$/)).toBeNull()
  })

  it('respects custom cap prop', () => {
    render(<CapturePeoplePills people={people5} cap={2} />)
    expect(screen.getByText('+3')).toBeInTheDocument()
  })

  it('renders wrapper with accessible aria-label', () => {
    render(<CapturePeoplePills people={people3} />)
    expect(screen.getByRole('group', { name: '3 people' })).toBeInTheDocument()
  })
})
