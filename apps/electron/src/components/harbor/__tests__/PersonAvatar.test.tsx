import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PersonAvatar } from '../PersonAvatar'

describe('PersonAvatar', () => {
  it('renders initials with no badge by default', () => {
    render(<PersonAvatar name="Mario Rossi" />)
    expect(screen.getByText('MR')).toBeInTheDocument()
    // pip should not exist
    expect(screen.queryByTitle('Has enrolled voiceprint')).not.toBeInTheDocument()
  })

  it('renders pip when voiceBadge is true', () => {
    render(<PersonAvatar name="Mario Rossi" voiceBadge />)
    // accessible label must exist
    const label = screen.getByTitle('Has enrolled voiceprint')
    expect(label).toBeInTheDocument()
  })

  it('does not render pip when voiceBadge is false', () => {
    render(<PersonAvatar name="Mario Rossi" voiceBadge={false} />)
    expect(screen.queryByTitle('Has enrolled voiceprint')).not.toBeInTheDocument()
  })

  it('does not render pip when voiceBadge is undefined (existing sites unaffected)', () => {
    render(<PersonAvatar name="Mario Rossi" />)
    expect(screen.queryByTitle('Has enrolled voiceprint')).not.toBeInTheDocument()
  })

  it('accessible label is NOT inside an aria-hidden subtree', () => {
    const { container } = render(<PersonAvatar name="Mario Rossi" voiceBadge />)
    const hiddenSpan = container.querySelector('[aria-hidden="true"]')
    const label = screen.getByTitle('Has enrolled voiceprint')
    // The pip element should not be a descendant of the aria-hidden span
    expect(hiddenSpan?.contains(label)).toBe(false)
  })
})
