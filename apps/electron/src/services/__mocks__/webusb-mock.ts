// Shared WebUSB mock for renderer device-sync tests.
// Emits real Jensen protocol framing (see CLAUDE.md USB safety section) so tests exercise the
// actual parser (`parseJensenStream` in ../jensen.ts) instead of a hand-rolled stand-in.
// No real hardware is ever touched by this module — it is pure byte construction + an in-memory
// USBDevice-shaped object.

export interface MockFile {
  filename: string
  bytes: Uint8Array
}

function frame(cmdId: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length)
  out[0] = 0x12
  out[1] = 0x34
  out[2] = (cmdId >> 8) & 0xff
  out[3] = cmdId & 0xff
  const len = body.length & 0x00ffffff
  out[8] = (len >> 24) & 0xff
  out[9] = (len >> 16) & 0xff
  out[10] = (len >> 8) & 0xff
  out[11] = len & 0xff
  out.set(body, 12)
  return out
}

// Builds one CMD.GET_FILE_LIST entry matching JensenDevice.listFiles()'s real wire format:
// 1-byte version + 3-byte BE nameLen + name bytes + 4-byte BE fileLen + 6-byte padding +
// 16-byte signature (see src/services/jensen.ts listFiles() dynamic handler / parseFileListFlat).
// The earlier version of this mock only wrote `name + \0`, which doesn't survive
// JensenDevice's real per-entry parser (Task 9 found this while wiring `makeDeviceGroup()`
// to a real JensenDevice — see webusb-mock conformance test, which only checks framing, not
// entry layout).
function buildFileListEntry(f: MockFile): number[] {
  const nameBytes = [...f.filename].map((ch) => ch.charCodeAt(0))
  const fileLen = f.bytes.length
  return [
    1, // file version
    (nameBytes.length >> 16) & 0xff,
    (nameBytes.length >> 8) & 0xff,
    nameBytes.length & 0xff,
    ...nameBytes,
    (fileLen >> 24) & 0xff,
    (fileLen >> 16) & 0xff,
    (fileLen >> 8) & 0xff,
    fileLen & 0xff,
    0, 0, 0, 0, 0, 0, // 6 bytes padding
    ...new Array(16).fill(0), // 16-byte signature
  ]
}

export function buildJensenListFrames(files: MockFile[]): Uint8Array {
  const head = new Uint8Array(6)
  head[0] = 0xff
  head[1] = 0xff
  new DataView(head.buffer).setUint32(2, files.length)
  const entries = files.flatMap((f) => buildFileListEntry(f))
  const listBody = new Uint8Array([...head, ...entries])
  return new Uint8Array([...frame(4, listBody), ...frame(4, new Uint8Array(0))])
}

export function buildJensenFileFrames(bytes: Uint8Array, chunk = 32768): Uint8Array {
  const frames: number[] = []
  for (let i = 0; i < bytes.length; i += chunk) {
    frames.push(...frame(5, bytes.subarray(i, i + chunk)))
  }
  frames.push(...frame(5, new Uint8Array(0))) // bodyLength=0 terminator
  return new Uint8Array(frames)
}

// CMD.GET_FILE_COUNT (6) response — 4-byte BE count. Needed because JensenDevice.listFiles()
// calls getFileCount() first whenever versionNumber hasn't been established yet (e.g. no prior
// getDeviceInfo() call), which is the case for a freshly connected mock device.
export function buildJensenFileCountFrame(count: number): Uint8Array {
  const body = new Uint8Array(4)
  new DataView(body.buffer).setUint32(0, count)
  return frame(6, body)
}

export function makeMockUsbDevice(files: MockFile[]): USBDevice {
  let queue: Uint8Array = new Uint8Array(0)
  // JensenDevice keeps exactly one `transferIn` pending at all times (its read loop always
  // awaits the current call before issuing the next), so a single waiting-resolver slot is
  // enough to model "the read blocks until data arrives".
  let waitingForData: (() => void) | null = null
  const enqueue = (b: Uint8Array) => {
    queue = new Uint8Array([...queue, ...b])
    if (waitingForData) {
      const wake = waitingForData
      waitingForData = null
      wake()
    }
  }
  return {
    opened: false,
    configuration: null,
    async open() {
      ;(this as any).opened = true
    },
    async close() {
      ;(this as any).opened = false
    },
    async selectConfiguration() { /* no-op mock */ },
    async claimInterface() { /* no-op mock */ },
    async releaseInterface() { /* no-op mock */ },
    async selectAlternateInterface() { /* no-op mock */ },
    async transferOut(_ep: number, data: BufferSource) {
      const view = new Uint8Array(data as ArrayBuffer)
      const cmd = (view[2] << 8) | view[3]
      if (cmd === 4) enqueue(buildJensenListFrames(files))
      else if (cmd === 5) enqueue(buildJensenFileFrames(files[0]?.bytes ?? new Uint8Array(0)))
      else if (cmd === 6) enqueue(buildJensenFileCountFrame(files.length))
      return { status: 'ok', bytesWritten: view.length } as USBOutTransferResult
    },
    async transferIn(_ep: number, len: number) {
      if (queue.length === 0) {
        // Real WebUSB transferIn blocks until data arrives — it never resolves instantly with
        // zero bytes. JensenDevice's read loop re-issues transferIn as soon as the previous one
        // resolves, so resolving immediately here (even after a short timer) would either
        // (a) starve Node's timer phase with a same-tick microtask loop, or (b) keep resetting
        // the protocol's own debounced-parse timer before it ever gets to fire (a real-time
        // livelock — tried a `setTimeout(5)` yield first and it reproduced exactly this).
        // Waiting for the next `enqueue()` (from a subsequent transferOut) instead matches real
        // hardware semantics and lets that debounce timer actually elapse.
        await new Promise<void>((resolve) => {
          waitingForData = resolve
        })
      }
      const slice = queue.subarray(0, len)
      queue = queue.subarray(slice.length)
      const data = new DataView(slice.buffer, slice.byteOffset, slice.byteLength)
      return { status: 'ok', data } as USBInTransferResult
    },
  } as unknown as USBDevice
}
