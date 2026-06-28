/**
 * build-server.mjs — bundle the headless Fastify server for plain Node.
 *
 * Entry: electron/server/index.ts (startServer + direct-invoke guard).
 * Output: out/server/index.js (ESM).
 *
 * Native modules and 'electron' are marked EXTERNAL: they are resolved from
 * node_modules at runtime (the native-deps stage installs the native ones with
 * the correct Node ABI). 'electron' is external so any residual import resolves
 * at runtime rather than being inlined — but note: under plain Node, electron is
 * NOT installed, so any server-reachable `import … from 'electron'` will throw
 * MODULE_NOT_FOUND at load. The build prints a metafile-based audit of which
 * 'electron' imports survived into the bundle so leaks are caught pre-ship.
 */
import { build } from 'esbuild'
import { writeFileSync } from 'fs'

const result = await build({
  entryPoints: ['electron/server/index.ts'],
  // outdir + splitting (not a single outfile): modules pulled in only via a
  // dynamic import() (e.g. the voiceprint subtree in the speakers route) land in
  // their own lazy chunk instead of being inlined+hoisted into index.js. That
  // keeps their transitive `electron` imports OFF the boot path under plain Node.
  // The entry stays out/server/index.js (entryNames '[name]'), so the invoke
  // guard (process.argv[1].endsWith('index.js')) and `node out/server/index.js`
  // both still work.
  outdir: 'out/server',
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  metafile: true,
  // Keep native + electron out of the bundle; resolved from node_modules at runtime.
  external: [
    'better-sqlite3',
    'sodium-native',
    'ffmpeg-static',
    'sherpa-onnx-node',
    'usb',
    'electron',
    // Fastify + plugins are pure JS and CAN be bundled, but leaving the heavy
    // ones external keeps the bundle small and avoids ESM/CJS interop surprises.
    'fastify',
    '@fastify/secure-session',
    '@fastify/websocket',
    '@fastify/multipart',
    '@fastify/static'
  ],
  // ESM output needs a shim for __dirname/require used by some deps.
  banner: {
    js: [
      "import { createRequire as __cr } from 'module';",
      'const require = __cr(import.meta.url);',
      "import { fileURLToPath as __f } from 'url';",
      "import { dirname as __d } from 'path';",
      'const __filename = __f(import.meta.url);',
      'const __dirname = __d(__filename);'
    ].join('\n')
  },
  logLevel: 'info'
})

writeFileSync('out/server/meta.json', JSON.stringify(result.metafile))

// Scope ESM to the server bundle dir only. The bundle is ESM (format:'esm') but
// the root package.json is CJS (Electron's main needs CJS), so node would reparse
// index.js as ESM with a perf-warning. A package.json here marks the whole
// out/server tree (entry + chunks) as ESM unambiguously, with no warning.
writeFileSync('out/server/package.json', JSON.stringify({ type: 'module' }) + '\n')

// Boot-safety audit. A STATIC `import … from 'electron'` executes at module load
// and crashes under plain Node (electron isn't installed in the server image) —
// BUT only if that module is on the BOOT path. With code splitting, a module
// reached solely through a dynamic import() lives in a lazy chunk that loads only
// when invoked, so its electron import is NOT a boot crash. We therefore trace
// the OUTPUT graph from the entry (index.js) over static ('import-statement')
// chunk edges to find boot-loaded chunks, then flag electron-importing source
// inputs only within those chunks. Lazy-chunk + require-call refs are listed
// informationally (run only when their feature is invoked).
const { inputs, outputs } = result.metafile
const entryOut = Object.keys(outputs).find((o) => outputs[o].entryPoint === 'electron/server/index.ts')

const bootChunks = new Set([entryOut])
const stack = [entryOut]
while (stack.length) {
  const cur = stack.pop()
  for (const edge of outputs[cur]?.imports || []) {
    if (edge.kind === 'import-statement' && outputs[edge.path] && !bootChunks.has(edge.path)) {
      bootChunks.add(edge.path)
      stack.push(edge.path)
    }
  }
}
const bootInputs = new Set()
for (const chunk of bootChunks) {
  for (const src of Object.keys(outputs[chunk]?.inputs || {})) bootInputs.add(src)
}

const staticEdge = (src) => (inputs[src]?.imports || []).some((i) => i.path === 'electron' && i.kind === 'import-statement')
const bootLeaks = [...bootInputs].filter(staticEdge)
const lazyElectron = Object.keys(inputs)
  .filter((src) => !bootInputs.has(src) && (inputs[src]?.imports || []).some((i) => i.path === 'electron'))

if (bootLeaks.length > 0) {
  console.warn('\n[build-server] ⚠️  STATIC "electron" imports on the BOOT path (WILL crash boot under plain Node):')
  for (const f of bootLeaks) console.warn('  - ' + f)
  process.exitCode = 1
} else {
  console.log('[build-server] ✅ no boot-path "electron" imports (boot-safe under plain Node)')
}
if (lazyElectron.length > 0) {
  console.log('[build-server] (electron refs in lazy chunks — load only when their feature is invoked, e.g. voiceprint):')
  for (const f of lazyElectron) console.log('  - ' + f)
}
console.log('[build-server] wrote out/server/index.js')
