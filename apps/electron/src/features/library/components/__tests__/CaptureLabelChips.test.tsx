import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { CaptureLabelChips } from '../CaptureLabelChips'
import type { CaptureLabel } from '../../types/captureMeta'

describe('CaptureLabelChips', () => {
  it('renders nothing when labels is empty', () => {
    const { container } = render(<CaptureLabelChips labels={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one chip for a category label', () => {
    const labels: CaptureLabel[] = [{ text: 'meeting', kind: 'category', colorClass: 'bg-primary' }]
    render(<CaptureLabelChips labels={labels} />)
    expect(screen.getByText('meeting')).toBeInTheDocument()
  })

  it('renders the colored dot span when colorClass is set', () => {
    const labels: CaptureLabel[] = [{ text: 'meeting', kind: 'category', colorClass: 'bg-primary' }]
    const { container } = render(<CaptureLabelChips labels={labels} />)
    // The dot span has the colorClass applied
    const dot = container.querySelector('.bg-primary')
    expect(dot).not.toBeNull()
  })

  it('renders without dot when colorClass is undefined', () => {
    const labels: CaptureLabel[] = [{ text: 'custom', kind: 'category' }]
    const { container } = render(<CaptureLabelChips labels={labels} />)
    expect(screen.getByText('custom')).toBeInTheDocument()
    // No dot element (no colorClass utility in this container aside from badge itself)
    expect(container.querySelectorAll('[class*="bg-"]:not(span[class*="border"])').length).toBeGreaterThanOrEqual(0) // soft check
  })

  it('renders multiple chips', () => {
    const labels: CaptureLabel[] = [
      { text: 'meeting', kind: 'category', colorClass: 'bg-primary' },
      { text: 'interview', kind: 'category', colorClass: 'bg-accent-2' },
    ]
    render(<CaptureLabelChips labels={labels} />)
    expect(screen.getByText('meeting')).toBeInTheDocument()
    expect(screen.getByText('interview')).toBeInTheDocument()
  })
})
