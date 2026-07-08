/**
 * facade-composition.guard.test.ts — source-level guard for SDK facade composition.
 *
 * INVARIANT: every SDK group factory under ../../groups/ (each file exports a
 * `make<Name>Group` factory) MUST be BOTH imported AND invoked (Object.assign'd /
 * wired) inside `installRestApi()` in ../../index.ts.
 *
 * WHY: index.ts builds the live ElectronAPI facade by calling each group factory and
 * Object.assign-ing the result onto `api`. If a group file exists but its factory is
 * never composed, that group's namespace/methods are `undefined` at runtime — every
 * `window.electronAPI.<group>.<method>(...)` call then throws "cannot read properties
 * of undefined". Enumerating the directory (rather than a hardcoded list) means a NEW
 * group added later is covered automatically: forget to wire it and this guard fails.
 *
 * A source-level assertion is intentional (mirroring device-singleton.guard.test.ts):
 * the factories land on the facade in non-uniform shapes — whole-object namespaces
 * (`api.recordings`), methods merged into a seeded namespace (`api.integrity`),
 * renamed namespaces (appInfo -> `api.app`), and multi-key spreads (device ->
 * `api.jensen` + `api.downloadService`) — so a generic runtime "namespace exists"
 * check would need brittle per-factory knowledge. Verifying that each factory is
 * imported and *called* in index.ts is the precise, maintainable invariant.
 *
 * EXCLUDED per composition design (composed specially, not via the plain
 * make<Name>Group -> Object.assign pattern):
 *   - events.ts (makeEventsGroup): seeds root on* keys + partial namespaces
 *   - device-sync-client.ts (makeDeviceSyncClient): distinct factory name/shape
 * Both are nonetheless invoked in index.ts; they are simply out of scope for the
 * enumerated set below.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// NOTE: resolve paths via a bare `import.meta.url` + path.resolve rather than
// `new URL('<literal>', import.meta.url)` — Vite statically rewrites that asset pattern
// during transform, which mangles the URL scheme and breaks fileURLToPath here.
const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_SRC = resolve(HERE, '../../index.ts')
const GROUPS_DIR = resolve(HERE, '../../groups')
const indexSource = readFileSync(INDEX_SRC, 'utf8')

// Group files composed specially (NOT via the plain make<Name>Group Object.assign pattern).
const EXCLUDED_FILES = new Set(['events.ts', 'device-sync-client.ts'])

interface GroupFactory {
  file: string
  factory: string | null
}

/** Enumerate every group factory: { file, factory } for each groups/*.ts (minus excluded). */
const groupFactories: GroupFactory[] = readdirSync(GROUPS_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !EXCLUDED_FILES.has(f))
  .sort()
  .map((file) => {
    const src = readFileSync(resolve(GROUPS_DIR, file), 'utf8')
    const match = src.match(/export function (make[A-Za-z0-9_]+)\s*\(/)
    return { file, factory: match?.[1] ?? null }
  })

/** True when `factory` appears inside an `import { ... } from ...` statement in index.ts. */
function isImported(factory: string): boolean {
  return new RegExp(`import\\s*\\{[^}]*\\b${factory}\\b[^}]*\\}\\s*from`).test(indexSource)
}

/** True when `factory` is invoked (call expression) somewhere in index.ts. */
function isInvoked(factory: string): boolean {
  return new RegExp(`\\b${factory}\\s*\\(`).test(indexSource)
}

describe('electron-api facade composition guard', () => {
  it('discovers at least one group factory to guard (enumeration sanity)', () => {
    expect(groupFactories.length).toBeGreaterThan(0)
  })

  it('every enumerated group file exports a detectable make<Name>Group factory', () => {
    const undetectable = groupFactories.filter((g) => g.factory === null).map((g) => g.file)
    expect(
      undetectable,
      `group files under groups/ with no detectable "export function make*Group": ${undetectable.join(', ')}`
    ).toEqual([])
  })

  it('imports AND invokes every group factory into the facade (uncomposed = undefined at runtime)', () => {
    const uncomposed = groupFactories
      .filter((g): g is { file: string; factory: string } => g.factory !== null)
      .filter(({ factory }) => !(isImported(factory) && isInvoked(factory)))
      .map((g) => `${g.factory} (${g.file})`)

    expect(
      uncomposed,
      'SDK group factories declared under groups/ but NOT composed into the facade in index.ts.\n' +
        "Each listed group's methods would be undefined at runtime:\n  " +
        uncomposed.join('\n  ')
    ).toEqual([])
  })

  // Per-group granularity so a failure names the exact offending group in its own row.
  const detectable = groupFactories.filter(
    (g): g is { file: string; factory: string } => g.factory !== null
  )
  it.each(detectable.map((g) => [g.factory, g.file]))(
    '%s is imported and Object.assign\'d/wired into the facade',
    (factory, file) => {
      expect(isImported(factory), `${factory} (${file}) is not imported into index.ts`).toBe(true)
      expect(
        isInvoked(factory),
        `${factory} (${file}) is imported but never invoked/composed in installRestApi()`
      ).toBe(true)
    }
  )
})
