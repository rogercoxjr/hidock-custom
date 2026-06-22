/**
 * TemplateChip + SuggestNewBanner — Phase 3 (Task 13b)
 *
 * Unit tests for the components themselves (props → rendering).
 * SourceReader integration tests live in SourceReader.template.test.tsx.
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TemplateChip, SuggestNewBanner } from '../TemplateChip'

// ---------------------------------------------------------------------------
// TemplateChip
// ---------------------------------------------------------------------------

describe('TemplateChip', () => {
  it('renders "Template: <name>" when name is provided', () => {
    render(<TemplateChip name="Sales call" />)
    expect(screen.getByTestId('template-chip')).toHaveTextContent('Template: Sales call')
  })

  it('renders confidence percentage when confidence is provided', () => {
    render(<TemplateChip name="Sales call" confidence={0.86} />)
    expect(screen.getByTestId('template-chip')).toHaveTextContent('Template: Sales call · 86%')
  })

  it('rounds confidence to nearest percent', () => {
    render(<TemplateChip name="Standup" confidence={0.7351} />)
    expect(screen.getByTestId('template-chip')).toHaveTextContent('74%')
  })

  it('renders nothing when name is null', () => {
    const { container } = render(<TemplateChip name={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when name is undefined', () => {
    const { container } = render(<TemplateChip name={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when name is an empty string', () => {
    const { container } = render(<TemplateChip name="" />)
    expect(container.firstChild).toBeNull()
  })

  it('shows instructions-changed icon when instructionsChanged is true', () => {
    render(<TemplateChip name="Sales call" instructionsChanged={true} />)
    expect(screen.getByTestId('template-instructions-changed')).toBeInTheDocument()
  })

  it('does NOT show instructions-changed icon when instructionsChanged is false', () => {
    render(<TemplateChip name="Sales call" instructionsChanged={false} />)
    expect(screen.queryByTestId('template-instructions-changed')).not.toBeInTheDocument()
  })

  it('does NOT show instructions-changed icon when instructionsChanged is absent', () => {
    render(<TemplateChip name="Sales call" />)
    expect(screen.queryByTestId('template-instructions-changed')).not.toBeInTheDocument()
  })

  it('renders without confidence when confidence is null', () => {
    render(<TemplateChip name="Demo" confidence={null} />)
    const chip = screen.getByTestId('template-chip')
    expect(chip).toHaveTextContent('Template: Demo')
    expect(chip.textContent).not.toContain('%')
  })
})

// ---------------------------------------------------------------------------
// SuggestNewBanner
// ---------------------------------------------------------------------------

describe('SuggestNewBanner', () => {
  it('renders the banner with a suggested template name', () => {
    render(<SuggestNewBanner suggestedTemplate={{ name: 'Interview notes' }} />)
    expect(screen.getByTestId('suggest-new-banner')).toBeInTheDocument()
    expect(screen.getByText(/Interview notes/i)).toBeInTheDocument()
  })

  it('falls back to "a new template" when suggestedTemplate.name is absent', () => {
    render(<SuggestNewBanner suggestedTemplate={null} />)
    expect(screen.getByTestId('suggest-new-banner')).toBeInTheDocument()
    expect(screen.getByText(/a new template/i)).toBeInTheDocument()
  })

  it('renders the Accept button in disabled state (Phase 4)', () => {
    render(<SuggestNewBanner suggestedTemplate={{ name: 'Foo' }} />)
    const btn = screen.getByRole('button', { name: /accept/i })
    expect(btn).toBeDisabled()
  })

  it('renders "No matching template" label', () => {
    render(<SuggestNewBanner suggestedTemplate={null} />)
    expect(screen.getByText(/no matching template/i)).toBeInTheDocument()
  })
})
