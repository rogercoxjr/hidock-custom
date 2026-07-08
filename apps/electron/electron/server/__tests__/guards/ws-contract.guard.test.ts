/**
 * ws-contract.guard.test.ts — GUARD: WebSocket channel contract (broadcast <-> subscribe).
 *
 * Invariant under test
 * --------------------
 * Every channel the main process broadcasts over the /ws transport
 * (getBroadcaster().broadcast(...), including the thin `notifyRenderer(...)` wrappers in
 * transcription.ts / recording-watcher.ts) MUST have a matching renderer subscription in
 * src/lib/electron-api/groups/events.ts (wsClient.subscribe(...)), and vice-versa.
 * A channel broadcast with no subscriber is DEAD; a channel subscribed with no broadcaster
 * is NEVER-FIRED. Both are silent contract drift and this guard fails on either.
 *
 * Why a static guard (reads source, not runtime)
 * ----------------------------------------------
 * The contract lives in string literals on the two ends of a socket; there is no single
 * symbol to import and diff. We extract the literals straight from source so the guard can
 * never rot: add/remove a channel on one side and the other side must move to match.
 *
 * Scan scope
 * ----------
 * Broadcasts: electron/server + electron/main/services (the dirs named by the contract task)
 * PLUS electron/main/ipc. The ipc handlers are genuine /ws publishers — voiceprint:captured
 * (speakers-handlers.ts:224) and migration:progress (migration-handlers.ts). Excluding ipc
 * would raise FALSE never-fired reports for channels that are, in fact, fully wired, so the
 * correct invariant requires scanning it.
 * Subscriptions: src/lib/electron-api/groups/events.ts (the sole renderer events group).
 *
 * Allowlists — both are kept honest by hygiene tests below (stale entries fail the suite)
 * -------------------------------------------------------------------------------------
 *  - ONE_DIRECTIONAL: device-pipeline jensen:* channels. Broadcast from ipc/jensen-handlers.ts
 *    but consumed by the device pipeline through a SEPARATE renderer subscription surface (not
 *    events.ts). Intentionally one-directional with respect to the events.ts contract.
 *  - KNOWN_DEFECTS: real never-fired gaps that exist in product code right now. They are NOT
 *    silently masked — each is pinned by an xfail `it.fails` test that flips RED the moment a
 *    real /ws broadcaster is added (telling you to remove the entry). See the DEFECT REPORT
 *    block at the bottom of this file.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, resolve, join } from 'path'

// Resolve the apps/electron root by walking up from cwd until both contract endpoints exist.
// (import.meta.url is not a file:// URL under the jsdom test environment, so we cannot use it.)
function findAppRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'electron/main/services')) && existsSync(join(dir, 'src/lib/electron-api'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`could not locate apps/electron root from ${process.cwd()}`)
}

const APP_ROOT = findAppRoot()

const BROADCAST_DIRS = [
  resolve(APP_ROOT, 'electron/server'),
  resolve(APP_ROOT, 'electron/main/services'),
  resolve(APP_ROOT, 'electron/main/ipc'),
]
const EVENTS_FILE = resolve(APP_ROOT, 'src/lib/electron-api/groups/events.ts')

// Matches getBroadcaster().broadcast('ch' ...), the bare broadcast('ch' ...) helper in
// jensen-handlers.ts, and the notifyRenderer('ch' ...) wrappers in transcription.ts /
// recording-watcher.ts. Only the first string-literal argument (the channel) is captured.
const BROADCAST_RE = /\b(?:broadcast|notifyRenderer)\(\s*['"]([^'"]+)['"]/g
const SUBSCRIBE_RE = /wsClient\.subscribe\(\s*['"]([^'"]+)['"]/g

// Device-pipeline channels: broadcast from ipc/jensen-handlers.ts, consumed via a SEPARATE
// renderer subscription surface (device pipeline), not events.ts. One-directional by design.
const ONE_DIRECTIONAL = new Set<string>([
  'jensen:connect-event',
  'jensen:disconnect-event',
  'jensen:state-changed',
])

// KNOWN, TRACKED DEFECTS: subscribed by the renderer over /ws but NEVER broadcast over /ws.
// Do not "fix" by deleting the subscription without confirming product intent — each is
// pinned by an xfail it.fails() below and called out in the DEFECT REPORT at end of file.
const KNOWN_DEFECTS = new Set<string>([
  'security-warning', // only legacy webContents.send() at electron/main/index.ts:285 — no /ws publisher
  'integrity:progress', // integrity-service.ts emits nothing; route comment at integrity.ts:32 is stale
])

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTsFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

// Strip block and line comments so channel-shaped prose in docs/JSDoc cannot pollute a set.
// The [^:] guard keeps URL schemes (http://) from being treated as line comments.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function extractMatches(text: string, re: RegExp): string[] {
  const found: string[] = []
  for (const m of stripComments(text).matchAll(re)) found.push(m[1])
  return found
}

const broadcastChannels = new Set<string>()
for (const dir of BROADCAST_DIRS) {
  for (const file of collectTsFiles(dir)) {
    for (const ch of extractMatches(readFileSync(file, 'utf8'), BROADCAST_RE)) broadcastChannels.add(ch)
  }
}

const subscribedChannels = new Set<string>(extractMatches(readFileSync(EVENTS_FILE, 'utf8'), SUBSCRIBE_RE))

describe('WS channel contract guard (broadcast <-> subscribe)', () => {
  it('extracted contract sets are non-empty (guard wiring sanity)', () => {
    // Guards against a silent green when a moved/renamed source path makes the scan read nothing.
    expect(broadcastChannels.size, 'no broadcast channels extracted — check BROADCAST_DIRS').toBeGreaterThan(0)
    expect(subscribedChannels.size, 'no subscribed channels extracted — check EVENTS_FILE').toBeGreaterThan(0)
  })

  it('every broadcast channel has a matching renderer subscription (no DEAD channels)', () => {
    const dead = [...broadcastChannels]
      .filter((ch) => !subscribedChannels.has(ch) && !ONE_DIRECTIONAL.has(ch))
      .sort()
    expect(dead, `broadcast over /ws but never subscribed in events.ts: ${dead.join(', ')}`).toEqual([])
  })

  it('every subscribed channel has a matching broadcaster (no NEVER-FIRED channels)', () => {
    const neverFired = [...subscribedChannels]
      .filter((ch) => !broadcastChannels.has(ch) && !KNOWN_DEFECTS.has(ch))
      .sort()
    expect(neverFired, `subscribed in events.ts but never broadcast over /ws: ${neverFired.join(', ')}`).toEqual([])
  })

  it('ONE_DIRECTIONAL allowlist has no stale entries', () => {
    const notBroadcast = [...ONE_DIRECTIONAL].filter((ch) => !broadcastChannels.has(ch)).sort()
    expect(notBroadcast, `one-directional entry no longer broadcast: ${notBroadcast.join(', ')}`).toEqual([])
    const nowSubscribed = [...ONE_DIRECTIONAL].filter((ch) => subscribedChannels.has(ch)).sort()
    expect(nowSubscribed, `one-directional entry now subscribed — drop from allowlist: ${nowSubscribed.join(', ')}`)
      .toEqual([])
  })

  it('KNOWN_DEFECTS allowlist has no stale entries (all still subscribed)', () => {
    const notSubscribed = [...KNOWN_DEFECTS].filter((ch) => !subscribedChannels.has(ch)).sort()
    expect(notSubscribed, `KNOWN_DEFECT no longer subscribed — remove entry: ${notSubscribed.join(', ')}`).toEqual([])
  })

  // ---------------------------------------------------------------------------------------
  // xfail pins for the two real defects. Each is GREEN while the defect exists and FLIPS RED
  // the instant a real /ws broadcaster for the channel is added — your cue to fix the contract,
  // delete the KNOWN_DEFECTS entry, and delete the corresponding it.fails below.
  // ---------------------------------------------------------------------------------------

  it.fails('KNOWN DEFECT: security-warning is subscribed but never broadcast over /ws', () => {
    // TODO(ws-contract): events.ts:105 subscribes 'security-warning' on /ws, but the main process
    // only emits it via legacy Electron IPC webContents.send() (electron/main/index.ts:285), never
    // via getBroadcaster().broadcast(). Under the headless/hosted server the warning never reaches
    // the renderer. Fix: broadcast 'security-warning' over /ws (or remove the dead subscription).
    expect(broadcastChannels.has('security-warning')).toBe(true)
  })

  it.fails('KNOWN DEFECT: integrity:progress is subscribed but never broadcast over /ws', () => {
    // TODO(ws-contract): events.ts:113 subscribes 'integrity:progress' and the route comment at
    // electron/server/routes/integrity.ts:32 claims progress is broadcast over /ws, but
    // integrity-service.ts emits no progress at all — the scan progress bar never advances.
    // Fix: have integrity-service broadcast 'integrity:progress' (or remove the dead subscription).
    expect(broadcastChannels.has('integrity:progress')).toBe(true)
  })
})

/**
 * DEFECT REPORT (tracked here so the suite stays green while the gap stays visible)
 * ================================================================================
 * Two channels the renderer subscribes to over /ws are NEVER broadcast over /ws:
 *
 *   1. security-warning   — subscribed at src/lib/electron-api/groups/events.ts:105.
 *      Only publisher is legacy webContents.send('security-warning', ...) at
 *      electron/main/index.ts:285 (Electron IPC, not the /ws transport). No
 *      getBroadcaster().broadcast('security-warning', ...) exists anywhere, so under the
 *      headless/hosted server the remote-debugging warning never reaches the UI.
 *
 *   2. integrity:progress — subscribed at src/lib/electron-api/groups/events.ts:113.
 *      electron/server/routes/integrity.ts:32 comments "Progress events are broadcast over
 *      /ws as integrity:progress messages", but electron/main/services/integrity-service.ts
 *      emits nothing (no getBroadcaster, no progress callback). The integrity scan progress
 *      bar can never advance.
 *
 * Both are pinned by it.fails() above; fixing either will turn its pin RED as a reminder to
 * remove it from KNOWN_DEFECTS.
 */
