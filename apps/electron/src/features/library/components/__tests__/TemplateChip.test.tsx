/**
 * TemplateChip + SuggestNewBanner — Phase 3 (Task 13b) / Phase 4 (Task 14)
 *
 * Unit tests for the components themselves (props → rendering).
 * SourceReader integration tests live in SourceReader.template.test.tsx.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TemplateChip, SuggestNewBanner } from '../TemplateChip'

// Phase 4: patch only window.electronAPI, not the whole window object (stubGlobal
// would replace window entirely and break React's DOM instanceof checks).
const mockAcceptSuggestedTemplate = vi.fn()
beforeAll(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      summarizationTemplates: {
        acceptSuggestedTemplate: mockAcceptSuggestedTemplate,
      },
    },
    configurable: true,
    writable: true,
  })
})
afterAll(() => {
  // @ts-expect-error cleaning up
  delete window.electronAPI
})

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
    render(<SuggestNewBanner suggestedTemplate={{ name: 'Interview notes' }} recordingId="rec-1" />)
    expect(screen.getByTestId('suggest-new-banner')).toBeInTheDocument()
    expect(screen.getByText(/Interview notes/i)).toBeInTheDocument()
  })

  it('falls back to "a new template" when suggestedTemplate.name is absent', () => {
    render(<SuggestNewBanner suggestedTemplate={null} recordingId="rec-1" />)
    expect(screen.getByTestId('suggest-new-banner')).toBeInTheDocument()
    expect(screen.getByText(/a new template/i)).toBeInTheDocument()
  })

  it('renders the Save button (Phase 4 — enabled)', () => {
    render(<SuggestNewBanner suggestedTemplate={{ name: 'Foo' }} recordingId="rec-1" />)
    const btn = screen.getByTestId('suggest-new-save')
    expect(btn).not.toBeDisabled()
  })

  it('renders the "Edit & save" button (Phase 4 — enabled)', () => {
    render(<SuggestNewBanner suggestedTemplate={{ name: 'Foo' }} recordingId="rec-1" />)
    const btn = screen.getByTestId('suggest-new-edit-save')
    expect(btn).not.toBeDisabled()
  })

  it('renders "No matching template" label', () => {
    render(<SuggestNewBanner suggestedTemplate={null} recordingId="rec-1" />)
    expect(screen.getByText(/no matching template/i)).toBeInTheDocument()
  })
})
