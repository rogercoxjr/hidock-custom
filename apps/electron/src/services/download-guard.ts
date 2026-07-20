/**
 * download-guard.ts — a tiny ref-counted flag marking that a device→server download/sync is
 * in flight.
 *
 * WHY: WebUSB gives us ONE shared read loop on the ONE shared JensenDevice singleton. A
 * concurrent device command issued mid-download — a `listFiles` scan from a UI refresh or the
 * 30s device poll, or a reconnect's `setup()`/re-claim — cancels the download's in-flight
 * `transferIn` and can cross-resolve its promise, collapsing the read to 0 bytes (the hosted
 * 0-byte-download bug). Download paths bracket their work with beginDownload()/endDownload();
 * the refresh/poll/auto-connect paths check isDownloadInFlight() and defer, so nothing churns
 * the USB bus while a download is streaming.
 *
 * Ref-counted so nested/overlapping download calls (e.g. queueBulkDownloads → queueDownload)
 * keep the guard raised until the outermost one finishes. Neutral module (no React/USB imports)
 * so the writer (useOperations) and the readers (useUnifiedRecordings, hidock-device) can all
 * import it without a dependency cycle.
 */
let depth = 0

/** Raise the guard for the duration of a download/sync. Always pair with endDownload() in finally. */
export function beginDownload(): void {
  depth++
}

/** Lower the guard. Clamped at 0 so an unbalanced call can't leave it negative/stuck. */
export function endDownload(): void {
  depth = Math.max(0, depth - 1)
}

/** True while any device→server download/sync is in progress. */
export function isDownloadInFlight(): boolean {
  return depth > 0
}
