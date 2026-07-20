import { describe, it, expect, beforeEach } from 'vitest'
import { beginDownload, endDownload, isDownloadInFlight } from '../download-guard'

describe('download-guard', () => {
  // Module state is process-wide; drain any leftover so tests are order-independent.
  beforeEach(() => {
    while (isDownloadInFlight()) endDownload()
  })

  it('is not in flight by default', () => {
    expect(isDownloadInFlight()).toBe(false)
  })

  it('ref-counts nested begin/end (stays raised until the outermost end)', () => {
    beginDownload()
    expect(isDownloadInFlight()).toBe(true)
    beginDownload() // nested (e.g. queueBulkDownloads → queueDownload)
    expect(isDownloadInFlight()).toBe(true)
    endDownload()
    expect(isDownloadInFlight()).toBe(true) // one still outstanding
    endDownload()
    expect(isDownloadInFlight()).toBe(false)
  })

  it('clamps at zero so an unbalanced end cannot leave it stuck', () => {
    endDownload()
    endDownload()
    expect(isDownloadInFlight()).toBe(false)
    beginDownload()
    expect(isDownloadInFlight()).toBe(true)
    endDownload()
    expect(isDownloadInFlight()).toBe(false)
  })
})
