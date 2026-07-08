import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// Guard: every route module that exports a register* function MUST be imported and
// called in app.ts. A route file that ships a registerFoo() but is never wired into
// buildApp() silently 404s all of its endpoints — this test makes that regression loud.
//
// The invariant is derived dynamically from the filesystem so that a NEW routes/*.ts
// file is covered automatically the moment it lands, without editing this test.

const here = dirname(fileURLToPath(import.meta.url))
const routesDir = resolve(here, '../../routes')
const appPath = resolve(here, '../../app.ts')

// Files that are not route modules: the shared error-handler helper, plus any future
// pure-helper file that exports no register* function (handled generically below).
const NON_ROUTE_FILES = new Set(['_errors.ts'])

// Matches `export function registerFoo`, `export async function registerFoo`, and
// `export const registerFoo =`. Global so a file with multiple register* exports is
// fully covered.
const REGISTER_EXPORT = /export\s+(?:async\s+)?(?:function\s+|const\s+)(register[A-Za-z0-9_]*)/g

function registerExportsOf(source: string): string[] {
  const names: string[] = []
  for (const m of source.matchAll(REGISTER_EXPORT)) names.push(m[1])
  return names
}

interface RouteModule {
  file: string // basename, e.g. 'recordings.ts'
  moduleSpecifier: string // how app.ts would import it, e.g. './routes/recordings'
  registers: string[] // register* function names exported by the file
}

function discoverRouteModules(): RouteModule[] {
  const modules: RouteModule[] = []
  for (const file of readdirSync(routesDir).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue
    if (NON_ROUTE_FILES.has(file)) continue
    const source = readFileSync(resolve(routesDir, file), 'utf8')
    const registers = registerExportsOf(source)
    // Pure-helper file with no register* export — not a route module, skip it.
    if (registers.length === 0) continue
    modules.push({ file, moduleSpecifier: `./routes/${file.replace(/\.ts$/, '')}`, registers })
  }
  return modules
}

const routeModules = discoverRouteModules()
const appSource = readFileSync(appPath, 'utf8')

// Import of the module, tolerant of single/double quotes and surrounding whitespace,
// e.g. `await import('./routes/recordings')`.
function isModuleImported(spec: string): boolean {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`import\\(\\s*['"]${escaped}['"]\\s*\\)`).test(appSource)
}

// The register function is actually invoked, e.g. `await registerRecordings(app)`.
function isRegisterCalled(name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\s*\\(`).test(appSource)
}

describe('server route registration guard', () => {
  it('discovers the route modules from the filesystem', () => {
    // Sanity check: if this ever hits zero, the path resolution broke and every other
    // assertion below would vacuously pass. Fail loudly instead.
    expect(routeModules.length).toBeGreaterThan(0)
  })

  it('imports and calls every route module register function in app.ts', () => {
    const unregistered: string[] = []
    for (const mod of routeModules) {
      if (!isModuleImported(mod.moduleSpecifier)) {
        unregistered.push(`${mod.file}: never imported in app.ts (import('${mod.moduleSpecifier}'))`)
      }
      for (const register of mod.registers) {
        if (!isRegisterCalled(register)) {
          unregistered.push(`${mod.file}: ${register}() is never called in app.ts — its endpoints would 404`)
        }
      }
    }

    expect(
      unregistered,
      `Unregistered route module(s) detected — wire these into buildApp() in app.ts:\n  ${unregistered.join('\n  ')}`
    ).toEqual([])
  })
})
