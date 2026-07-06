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

export function buildJensenListFrames(files: MockFile[]): Uint8Array {
  const enc = new TextEncoder()
  const head = new Uint8Array(6)
  head[0] = 0xff
  head[1] = 0xff
  new DataView(head.buffer).setUint32(2, files.length)
  const entries = files.flatMap((f) => [...enc.encode(f.filename + '\0')])
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

export function makeMockUsbDevice(files: MockFile[]): USBDevice {
  let queue: Uint8Array = new Uint8Array(0)
  const enqueue = (b: Uint8Array) => {
    queue = new Uint8Array([...queue, ...b])
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
    async selectConfiguration() {},
    async claimInterface() {},
    async releaseInterface() {},
    async transferOut(_ep: number, data: BufferSource) {
      const view = new Uint8Array(data as ArrayBuffer)
      const cmd = (view[2] << 8) | view[3]
      if (cmd === 4) enqueue(buildJensenListFrames(files))
      else if (cmd === 5) enqueue(buildJensenFileFrames(files[0]?.bytes ?? new Uint8Array(0)))
      return { status: 'ok', bytesWritten: view.length } as USBOutTransferResult
    },
    async transferIn(_ep: number, len: number) {
      const slice = queue.subarray(0, len)
      queue = queue.subarray(slice.length)
      const data = new DataView(slice.buffer, slice.byteOffset, slice.byteLength)
      return { status: 'ok', data } as USBInTransferResult
    },
  } as unknown as USBDevice
}
