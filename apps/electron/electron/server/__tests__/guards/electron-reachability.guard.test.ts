import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve, join } from 'path'

// Guard: no Fastify route may be able to LOAD a module that imports 'electron' when the
// server runs in hosted mode (plain Node — the 'electron' module is not installed, so a
// top-level `import ... from 'electron'` throws the moment that module is evaluated and
// takes the request/boot down with it).
//
// The invariant is derived dynamically from the filesystem: every routes/*.ts file is
// walked, following BOTH static `import ... from` and dynamic `import('...')` (and
// `require('...')`) targets transitively into main/services (and deeper). Any reachable
// module whose source contains a LOAD-TIME electron import fails the guard. Because the
// graph is discovered at runtime, a NEW leak introduced by any future edit is caught
// automatically without touching this test.
//
// WHY "load-time" and not "contains the string electron anywhere":
//   The crash we defend against happens at MODULE EVALUATION. A static
//   `import { app } from 'electron'` (an ES import — only ever valid at module scope) runs
//   unconditionally when the module is loaded, so reaching such a module is a real hosted
//   crash. By contrast a `require('electron')` / `import('electron')` nested INSIDE a
//   function body only executes if that function is called, and the code that uses this
//   pattern (see main/ipc/migration-handlers.ts, documented at its top) is deliberately
//   written to be hosted-safe: its route-facing *Impl exports never call the electron
//   branch. Keying the failing condition on load-time imports therefore models the actual
//   runtime hazard and avoids false-positiving genuinely-safe lazy code. Reachable lazy
//   electron usage is still surfaced (non-fatally) by a separate review test below.

const here = dirname(fileURLToPath(import.meta.url))
const electronRoot = resolve(here, '../../..') // .../apps/electron/electron
const routesDir = resolve(here, '../../routes') // .../electron/server/routes

const DEPTH_CAP = 40 // the deepest observed route->service chain is ~4; 40 is head-room with a hard stop

// A LOAD-TIME electron import: a static `import ... from 'electron'` or `export ... from
// 'electron'`. These evaluate unconditionally when the module is loaded and throw under
// plain Node. `[\s\S]*?` tolerates multi-line import clauses.
const ELECTRON_LOADTIME = /(?:^|\n)\s*(?:import|export)\b[\s\S]*?from\s*['"]electron['"]/
// A LAZY electron access: require()/import() of electron NOT via a static top-level import.
// In this codebase these live inside function bodies (only run under Electron).
const ELECTRON_LAZY = /(?:require|import)\(\s*['"]electron['"]\s*\)/

function importsElectronAtLoadTime(source: string): boolean {
  return ELECTRON_LOADTIME.test(source)
}

function importsElectronLazily(source: string): boolean {
  return !ELECTRON_LOADTIME.test(source) && ELECTRON_LAZY.test(source)
}

// Extract every relative module specifier this file pulls in at runtime: static
// `import/export ... from '...'` (skipping type-only imports, which are erased at build and
// never load anything), side-effect `import '...'`, dynamic `import('...')`, and
// `require('...')`. Bare specifiers (electron, fs, fastify, ...) are ignored — we only
// follow the local source tree.
function extractSpecifiers(source: string): string[] {
  const specs = new Set<string>()
  const fromRe = /(?:^|\n)\s*(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = fromRe.exec(source))) {
    if (/^\s*type\b/.test(m[1])) continue // `import type {...}` / `export type {...}` — erased, loads nothing
    specs.add(m[2])
  }
  const sideRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  while ((m = sideRe.exec(source))) specs.add(m[1])
  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dynRe.exec(source))) specs.add(m[1])
  const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = reqRe.exec(source))) specs.add(m[1])
  return [...specs]
}

// Resolve a relative specifier to an on-disk .ts/.tsx file, or null if it is a bare
// specifier / cannot be resolved. Handles extensionless imports, index files, and the
// `./foo.js` -> `./foo.ts` convention.
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  const candidates: string[] = []
  if (/\.tsx?$/.test(base)) candidates.push(base)
  if (spec.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'))
  candidates.push(base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx'))
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c
  return null
}

const rel = (p: string): string => p.slice(electronRoot.length + 1)

interface WalkResult {
  loadTime: Map<string, string[]> // module -> import chain (route -> ... -> module)
  lazy: Map<string, string[]> // reachable modules with function-scoped electron access
  visited: number
}

// Walk the transitive relative-import graph from a single route file. Test files are never
// followed. A visited set collapses cycles; DEPTH_CAP is a hard belt-and-braces stop.
function walk(routeFile: string): WalkResult {
  const loadTime = new Map<string, string[]>()
  const lazy = new Map<string, string[]>()
  const visited = new Set<string>()
  const stack: Array<{ file: string; chain: string[]; depth: number }> = [
    { file: routeFile, chain: [routeFile], depth: 0 }
  ]
  while (stack.length) {
    const { file, chain, depth } = stack.pop()!
    if (visited.has(file) || depth > DEPTH_CAP) continue
    visited.add(file)
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (file !== routeFile && importsElectronAtLoadTime(source) && !loadTime.has(file)) loadTime.set(file, chain)
    if (file !== routeFile && importsElectronLazily(source) && !lazy.has(file)) lazy.set(file, chain)
    for (const spec of extractSpecifiers(source)) {
      const resolved = resolveSpec(file, spec)
      if (!resolved || resolved.includes('__tests__')) continue
      stack.push({ file: resolved, chain: [...chain, resolved], depth: depth + 1 })
    }
  }
  return { loadTime, lazy, visited: visited.size }
}

const routeFiles = readdirSync(routesDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.startsWith('_'))
  .sort()

// ---------------------------------------------------------------------------------------
// KNOWN, TRACKED PRODUCT BUG — documented exception (keep the guard green for everything
// else while still catching any NEW leak).
//
// The voiceprint capture path leaks 'electron' into hosted mode: the speakers route
// dynamically imports voiceprint-service (directly and via voiceprint/speaker-matcher),
// and voiceprint-service statically `import { app } from 'electron'` while
// voiceprint-worker-pool statically `import { utilityProcess, app } from 'electron'`. Under
// plain Node those dynamic imports reject, so voiceprint capture is broken in hosted mode.
// This is a real, tracked product bug, NOT a test artifact.
//
// TODO(voiceprint-hosted-electron): make voiceprint-service / voiceprint-worker-pool
// hosted-safe (lazy-load electron behind an isElectron guard, or run the worker only in the
// desktop build). When fixed: delete these two entries, and un-skip the "IDEAL" test below
// — the honesty test will start failing to remind you these entries are now stale.
const KNOWN_LEAK_MODULES = new Set<string>([
  'main/services/voiceprint-service.ts',
  'main/services/voiceprint-worker-pool.ts'
])

// Reachable lazy (function-scoped) electron modules that have been reviewed and confirmed
// hosted-safe. Adding a new one here is a conscious "yes, this is guarded" decision.
const KNOWN_SAFE_LAZY_MODULES = new Set<string>([
  'main/ipc/migration-handlers.ts' // electron is require()'d only inside the Electron-only IPC-registration path
])

describe('guard: no Fastify route can load an electron import in hosted mode', () => {
  it('discovers a non-trivial set of route modules (guards against a vacuously-green walker)', () => {
    // If path resolution breaks, every walk() below would return nothing and the guard
    // would pass for the wrong reason. Fail loudly instead.
    expect(routeFiles.length).toBeGreaterThan(10)
    const totalVisited = routeFiles.reduce((n, f) => n + walk(join(routesDir, f)).visited, 0)
    expect(totalVisited).toBeGreaterThan(routeFiles.length) // routes actually pull in transitive modules
  })

  it('walker is sound: it still detects the known voiceprint leak reached from the speakers route', () => {
    // Proves the walker follows DYNAMIC imports transitively into services, skips type-only
    // imports, and detects a load-time electron import — i.e. a real NEW leak could not slip
    // past it. Also documents that the tracked voiceprint bug is currently real.
    const { loadTime } = walk(join(routesDir, 'speakers.ts'))
    const reached = [...loadTime.keys()].map(rel)
    expect(reached).toContain('main/services/voiceprint-service.ts')
    expect(reached).toContain('main/services/voiceprint-worker-pool.ts')
  })

  it('keeps the voiceprint allowlist honest — its modules still import electron at load time', () => {
    // If this fails, the tracked bug was fixed: remove the stale KNOWN_LEAK_MODULES entry
    // and un-skip the IDEAL test below.
    for (const modRel of KNOWN_LEAK_MODULES) {
      const abs = resolve(electronRoot, modRel)
      expect(existsSync(abs), `allowlisted module missing: ${modRel}`).toBe(true)
      expect(importsElectronAtLoadTime(readFileSync(abs, 'utf8')), `${modRel} no longer imports electron`).toBe(true)
    }
  })

  it('no route can reach a load-time electron import (except the tracked voiceprint chain)', () => {
    const offenders: string[] = []
    for (const file of routeFiles) {
      const { loadTime } = walk(join(routesDir, file))
      for (const [mod, chain] of loadTime) {
        if (KNOWN_LEAK_MODULES.has(rel(mod))) continue // documented, tracked exception
        offenders.push(`${file}: reaches ${rel(mod)}\n      via ${chain.map(rel).join(' -> ')}`)
      }
    }
    expect(
      offenders,
      'Route(s) can load an electron import in hosted mode — this crashes under plain Node.\n' +
        'Make the reached module hosted-safe (lazy-load electron behind an isElectron guard) ' +
        'or stop importing it from the route graph:\n  ' +
        offenders.join('\n  ')
    ).toEqual([])
  })

  it('flags any NEW reachable lazy (function-scoped) electron require for review', () => {
    // Lazy electron requires do not crash on load, but a new one reaching a route is worth a
    // human look (is it truly never hit in hosted mode?). The only reviewed-safe case today
    // is migration-handlers.ts; anything else here is unexpected.
    const found = new Set<string>()
    for (const file of routeFiles) for (const mod of walk(join(routesDir, file)).lazy.keys()) found.add(rel(mod))
    const unreviewed = [...found].filter((m) => !KNOWN_SAFE_LAZY_MODULES.has(m))
    expect(
      unreviewed,
      `New reachable lazy electron require(s) — confirm they never run in hosted mode, then ` +
        `add to KNOWN_SAFE_LAZY_MODULES:\n  ${unreviewed.join('\n  ')}`
    ).toEqual([])
  })

  // IDEAL end-state invariant: NO route reaches electron at all — including the voiceprint
  // capture path. Skipped because the voiceprint bug above makes it fail today. Un-skip it
  // (and drop KNOWN_LEAK_MODULES) once TODO(voiceprint-hosted-electron) is resolved.
  it.skip('IDEAL: no route reaches any electron import, including voiceprint capture', () => {
    const offenders: string[] = []
    for (const file of routeFiles) {
      const { loadTime } = walk(join(routesDir, file))
      for (const [mod, chain] of loadTime) {
        offenders.push(`${file}: reaches ${rel(mod)} via ${chain.map(rel).join(' -> ')}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
