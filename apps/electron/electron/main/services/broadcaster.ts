/**
 * Transport-agnostic event broadcaster. Main-process services emit
 * server-originated events through getBroadcaster().broadcast(channel, payload)
 * without knowing the transport. The hosted server installs a WebSocket-backed
 * implementation (see electron/server/ws.ts); unset (or headless tests) → no-op.
 */
export interface Broadcaster {
  broadcast(channel: string, payload: unknown): void
}

const NOOP: Broadcaster = { broadcast: () => { /* no transport wired */ } }

let active: Broadcaster | null = null

export function setBroadcaster(b: Broadcaster | null): void {
  active = b
}

export function getBroadcaster(): Broadcaster {
  return active ?? NOOP
}
