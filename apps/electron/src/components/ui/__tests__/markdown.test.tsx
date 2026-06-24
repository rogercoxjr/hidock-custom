import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Markdown } from '../markdown'

describe('Markdown', () => {
  it('renders headings as heading elements (not literal "##")', () => {
    render(<Markdown>{'## Section title'}</Markdown>)
    const h = screen.getByText('Section title')
    expect(h.tagName).toBe('H2')
  })

  it('renders bold as <strong> (Chat test depends on this)', () => {
    render(<Markdown>{'**bold**'}</Markdown>)
    expect(screen.getByText('bold').tagName).toBe('STRONG')
  })

  it('renders unordered lists as <ul><li>', () => {
    render(<Markdown>{'- one\n- two'}</Markdown>)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('one').closest('li')).toBeTruthy()
  })

  it('styles inline code with the pill class; language-tagged block code without it', () => {
    const { container } = render(<Markdown>{'inline `x` text\n\n```js\nblock\n```'}</Markdown>)
    const inline = screen.getByText('x')
    expect(inline.tagName).toBe('CODE')
    expect(inline.className).toContain('bg-surface-sunken')
    expect(inline.className).toContain('px-1')
    const pre = container.querySelector('pre')
    expect(pre).toBeTruthy()
    expect(pre?.querySelector('code')?.className ?? '').not.toContain('px-1')
  })

  it('renders GFM tables (locks remark-gfm)', () => {
    render(<Markdown>{'| A | B |\n|---|---|\n| 1 | 2 |'}</Markdown>)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('A').tagName).toBe('TH')
    expect(screen.getByText('1').tagName).toBe('TD')
  })

  it('renders GFM strikethrough and task-list checkboxes', () => {
    const { container } = render(<Markdown>{'~~gone~~\n\n- [ ] todo'}</Markdown>)
    expect(screen.getByText('gone').tagName).toBe('DEL')
    expect(container.querySelector('input[type="checkbox"]')).toBeTruthy()
  })

  it('styles links with the accent class', () => {
    render(<Markdown>{'[link](https://example.com)'}</Markdown>)
    const a = screen.getByText('link')
    expect(a.tagName).toBe('A')
    expect(a.className).toContain('text-accent-strong')
  })

  it('does not render raw HTML (no rehype-raw)', () => {
    const { container } = render(<Markdown>{'<script>alert(1)</script> and <b>x</b>'}</Markdown>)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  it('neutralizes javascript: URLs', () => {
    render(<Markdown>{'[x](javascript:alert(1))'}</Markdown>)
    const a = screen.getByText('x')
    expect((a.getAttribute('href') ?? '')).not.toContain('javascript:')
  })

  it('merges a passed className onto the wrapper', () => {
    const { container } = render(<Markdown className="text-[13.5px]">{'hi'}</Markdown>)
    expect(container.firstElementChild?.className).toContain('text-[13.5px]')
  })
})
