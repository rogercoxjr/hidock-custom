// SEAM 1 — produced by the renderer device layer, consumed by the upload client.
export interface DeviceFileSource {
  filename: string
  size: number // device-reported byte length
  stream(): AsyncIterable<Uint8Array> // streams from byte 0; no seek
}

// Device metadata sent to the server (base64-JSON in the x-device-file header).
export interface DeviceFileMeta {
  filename: string
  size: number
  deviceId?: string
  dateMs?: number
}

// SEAM 2 — server responses.
export interface SyncCreateResponse {
  uploadId: string
  serverSha256: string
  bytesReceived: number
}
export interface SyncFinalizeResponse {
  recordingId: string
  status: 'synced' | 'skipped'
}
