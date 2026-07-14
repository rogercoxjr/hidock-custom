/**
 * dataFreshness.ts — a tiny, transport-agnostic invalidation bus.
 *
 * Server-originated completion events (a download finishing, a transcription completing,
 * a WS reconnect) are turned into coalesced "this topic changed" pulses. Views subscribe
 * to a topic and re-run their own loader when a pulse arrives, instead of the user having
 * to click Refresh.
 *
 * Coalescing: repeated emit(topic) calls within DEBOUNCE_MS collapse into a single
 * notification, so a burst (e.g. 20 downloads finishing at once) triggers ONE refetch,
 * not twenty.
 *
 * The central wiring from WS/IPC events to this bus lives in useDataFreshnessBridge;
 * views subscribe via the useDataRefresh hook.
 */

export type FreshnessTopic = 'recordings' | 'actionables' | 'projects'

export const ALL_TOPICS: readonly FreshnessTopic[] = ['recordings', 'actionables', 'projects']

/** Coalescing window. A burst of emits inside this window fires listeners once, on the trailing edge. */
const DEBOUNCE_MS = 300

type Listener = () => void

const listeners: Record<FreshnessTopic, Set<Listener>> = {
  recordings: new Set(),
  actionables: new Set(),
  projects: new Set(),
}

const timers: Partial<Record<FreshnessTopic, ReturnType<typeof setTimeout>>> = {}

/** Subscribe to a topic. Returns an unsubscribe function that removes only this listener. */
export function subscribeFreshness(topic: FreshnessTopic, cb: Listener): () => void {
  listeners[topic].add(cb)
  return () => {
    listeners[topic].delete(cb)
  }
}

/** Request a refresh of `topic`. Coalesced: collapses a burst into a single trailing notification. */
export function emitFreshness(topic: FreshnessTopic): void {
  const existing = timers[topic]
  if (existing) clearTimeout(existing)
  timers[topic] = setTimeout(() => {
    delete timers[topic]
    for (const cb of listeners[topic]) cb()
  }, DEBOUNCE_MS)
}
