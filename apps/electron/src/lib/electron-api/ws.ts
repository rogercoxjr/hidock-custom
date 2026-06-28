/**
 * ws.ts — WebSocket event multiplexer for the renderer REST SDK.
 *
 * One authenticated WebSocket to the 0c-1 `/ws` endpoint; per-channel listener
 * sets; auto-reconnect with capped exponential backoff; re-attach is automatic
 * because listeners live in the multiplexer's Map, not on the socket.
 *
 * Wire format (0c-1): `JSON.stringify({ channel: string, payload: unknown })`
 * Cookie auth rides the WS upgrade automatically — nothing to set.
 *
 * Usage:
 *   const ws = new WsClient()
 *   const unsub = ws.subscribe('transcription:progress', (payload) => { … })
 *   // later:
 *   unsub()
 */

type Callback = (payload: unknown) => void

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

function wsUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost/ws'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
}

export class WsClient {
  /** Per-channel listener sets — survive socket close/reconnect. */
  private readonly _listeners: Map<string, Set<Callback>> = new Map()

  private _socket: WebSocket | null = null
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _backoff: number = MIN_BACKOFF_MS
  private _closed = false // true after explicit close() call; disables auto-reconnect

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to frames on `channel`.
   * Opens the socket lazily on first call.
   * Returns an unsubscribe function that removes only this callback.
   */
  subscribe(channel: string, cb: Callback): () => void {
    if (!this._listeners.has(channel)) {
      this._listeners.set(channel, new Set())
    }
    this._listeners.get(channel)!.add(cb)

    // Open lazily on first subscriber.
    if (this._socket === null && !this._closed) {
      this._open()
    }

    return () => {
      const set = this._listeners.get(channel)
      if (set) {
        set.delete(cb)
        if (set.size === 0) {
          this._listeners.delete(channel)
        }
      }
    }
  }

  /** Explicitly open (or re-open) the socket. */
  connect(): void {
    this._closed = false
    // Clear any pending reconnect timer so a manual connect() during a backoff
    // window doesn't spawn a second concurrent socket when the timer fires.
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    if (this._socket === null) {
      this._open()
    }
  }

  /** Permanently close the socket and disable auto-reconnect. */
  close(): void {
    this._closed = true
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    if (this._socket !== null) {
      this._socket.onclose = null // prevent reconnect loop
      this._socket.close()
      this._socket = null
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private _open(): void {
    const url = wsUrl()
    const socket = new WebSocket(url)
    this._socket = socket

    socket.onopen = () => {
      // Reset backoff on successful connection.
      this._backoff = MIN_BACKOFF_MS
    }

    socket.onmessage = (ev: MessageEvent<string>) => {
      this._dispatch(ev.data)
    }

    socket.onclose = () => {
      this._socket = null
      if (!this._closed) {
        this._scheduleReconnect()
      }
    }

    socket.onerror = () => {
      // onerror is always followed by onclose — let onclose drive reconnect.
    }
  }

  private _dispatch(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Malformed JSON — silently ignore.
      return
    }

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('channel' in parsed) ||
      !('payload' in parsed)
    ) {
      return
    }

    const { channel, payload } = parsed as { channel: unknown; payload: unknown }
    if (typeof channel !== 'string') return

    const listeners = this._listeners.get(channel)
    if (!listeners || listeners.size === 0) return

    for (const cb of listeners) {
      cb(payload)
    }
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer !== null) return

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (!this._closed) {
        this._open()
      }
    }, this._backoff)

    // Cap exponential backoff.
    this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_MS)
  }
}
