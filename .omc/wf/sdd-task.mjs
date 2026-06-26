export const meta = {
  name: 'sdd-task',
  description: 'Subagent-driven execution of one plan task: implement (TDD) -> spec-compliance review -> fix -> adversarial quality panel -> fix -> structured report',
  phases: [
    { title: 'Implement' },
    { title: 'Spec review' },
    { title: 'Fix spec' },
    { title: 'Quality review' },
    { title: 'Fix quality' },
  ],
}

// args may arrive as an object (normal) OR as a JSON string (a documented delivery pitfall) — handle both.
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = { __parseError: String(e) } } }
if (!A || typeof A !== 'object') A = {}
const REPO = 'C:/Users/rcox/hidock-tools/hidock-next'
const APP = 'C:/Users/rcox/hidock-tools/hidock-next/apps/electron'

const SHARED = `You are implementing ONE task of the "Voice Library Foundation (Phase 1)" plan for the HiDock Next
Electron app (a universal knowledge hub). This is a real, shipping codebase. You have ZERO prior context;
everything you need is below.

# Where things are
- Git repo root: ${REPO}  (run all git commands from here)
- Electron app: ${APP}  (run all npm/vitest commands from here — \`cd ${APP}\` first; the Bash cwd resets between calls)
- You are ALREADY on branch \`voice-library-foundation\`. DO NOT create/switch branches. DO NOT push. DO NOT merge.

# Hard constraints (violating any of these fails the task)
- TDD, strictly: write the failing test FIRST, run it and SEE it fail for the right reason, then write the
  minimal code, run it and SEE it pass. Do not write production code before its test.
- Follow the task's code EXACTLY as written. It is complete, no-placeholder code. Do not add features,
  options, or "improvements" beyond what the task specifies (YAGNI). Do not refactor unrelated code.
- READ every file before editing it. Match the file's existing style.
- 120-char max line length. Preserve LF line endings — do NOT introduce CRLF (if your editor flips line
  endings, the diff becomes unreviewable). 2-space indent for TS/JS (match surrounding code).
- USB / device SAFETY (critical): NEVER run the app (\`npm run dev\`), NEVER touch USB/device/jensen/transfer
  code, NEVER access real hardware. ALL tests mock the native \`sherpa-onnx-node\` addon, \`child_process\`,
  and \`electron\`. No real hardware. The ONLY permitted network access is the explicit model download in
  Task 1 (if your task body mentions \`models:fetch\`); no other network calls.
- The current speaker model on disk is WeSpeaker; existing voiceprint tests mock sherpa via \`Module._load\`
  so they are model-agnostic and stay green regardless of the model id.

# Per-task quality gate (run before you commit; all must pass)
- The exact \`npx vitest run ...\` command(s) named in your task body (from ${APP}).
- \`cd ${APP} && npm run typecheck:node\`  (main-process type check — must be clean).
- \`cd ${APP} && npx eslint <the files you changed>\`  (must be clean; fix lint you introduced).

# Commit
- Commit with the EXACT message in your task body, and append this trailer (two lines, blank line before it):

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

- Commit only the files your task names. One commit per task (unless the task says otherwise).`

const IMPL_REPORT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'] },
    summary: { type: 'string', description: 'What you implemented, in 2-4 sentences' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    commitSubjects: { type: 'array', items: { type: 'string' }, description: 'Subject line(s) of the commit(s) you made' },
    tddEvidence: { type: 'string', description: 'Proof you saw the test FAIL then PASS (the failure message + the pass result)' },
    gateResults: { type: 'string', description: 'Output/summary of vitest + typecheck:node + eslint runs' },
    deviationsFromPlan: { type: 'array', items: { type: 'string' }, description: 'Anything you had to do differently from the task text, and why' },
    concerns: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'filesChanged', 'commitSubjects', 'tddEvidence', 'gateResults', 'deviationsFromPlan', 'concerns'],
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocking', 'minor'] },
          location: { type: 'string', description: 'file:line or function' },
          description: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['severity', 'location', 'description', 'suggestedFix'],
      },
    },
  },
  required: ['pass', 'summary', 'issues'],
}

const DIFF = `Inspect what was implemented with:
  cd ${REPO} && git --no-pager diff ${A.baseRef}..HEAD
  cd ${REPO} && git --no-pager log --oneline ${A.baseRef}..HEAD
Also read the full current content of any changed file (the diff alone can mislead).`

const specPrompt = () => `You are a SPEC-COMPLIANCE reviewer. You did not write this code. Be exact and skeptical.

The implementer just executed this task from the plan:

## TASK (verbatim)
${A.taskBody}

## Spec context
${A.specContext || '(none)'}

## What to do
${DIFF}

Check ONLY spec compliance (NOT general code quality — that is a separate review):
1. Is EVERYTHING the task specifies actually implemented? (every Step, every file, every assertion)
2. Is anything implemented that the task did NOT ask for (scope creep / extra features)?
3. Do the tests assert the behavior the task describes — and were they written test-first (a real failing
   test, not a test retrofitted to pass)?
4. Do the names/signatures/values exactly match the task (e.g. exact model id string, exact CHECK set,
   exact function names)?

A 'blocking' issue = a real deviation from the task (missing requirement, wrong value, extra unrequested
behavior, or test that doesn't actually test the requirement). A 'minor' issue = a nit that doesn't change
spec compliance. Set pass=true ONLY if there are zero blocking issues.`

const qualityPrompt = (lens) => `You are a CODE-QUALITY reviewer with this specific lens: ${lens.name}.
You did not write this code. Spec compliance has already been checked separately — focus on quality.

The implementer just executed this task:

## TASK (verbatim)
${A.taskBody}

## What to do
${DIFF}

Review through your lens ONLY: ${lens.focus}

Report concrete, actionable issues. 'blocking' = a real defect (bug, correctness, safety, broken test,
type hole, resource leak, violates a hard constraint like CRLF/120-col/USB-safety). 'minor' = a nit/style
suggestion. Set pass=true ONLY if there are zero blocking issues. Do NOT invent issues to seem thorough —
if it's clean through your lens, say so and pass.`

const fixPrompt = (kind, issues) => `You are fixing ${kind} review issues on the current task. You are on branch
\`voice-library-foundation\` in ${REPO}. The implementer already committed; you must fix these issues and
commit the fix.

## Original task (for context)
${A.taskBody}

## Blocking issues you MUST fix
${issues.map((i, n) => `${n + 1}. [${i.severity}] ${i.location}: ${i.description}\n   Suggested fix: ${i.suggestedFix}`).join('\n')}

## Rules
- Same hard constraints as the implementer: TDD where you change behavior, 120-col, LF endings, read before
  edit, no scope creep, no USB/device/app-launch, mock everything.
- After fixing, re-run the task's \`npx vitest run ...\` command(s) + \`cd ${APP} && npm run typecheck:node\`
  + eslint on changed files — all must pass.
- Commit with: \`fix(electron): address ${kind} review on <task topic>\` plus the trailer
  \`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\`.
Report what you changed.`

const blocking = (v) => (v && v.issues ? v.issues.filter((i) => i.severity === 'blocking') : [])

// Fail fast (BEFORE dispatching the expensive implementer) if the task body did not arrive.
if (!A.taskBody || A.taskNum == null) {
  return {
    error: 'ARGS_NOT_DELIVERED',
    argsType: typeof args,
    argsIsArray: Array.isArray(args),
    parsedKeys: Object.keys(A),
    rawPreview: String(typeof args === 'string' ? args : JSON.stringify(args ?? null)).slice(0, 400),
  }
}

// ---- Implement ----
phase('Implement')
const impl = await agent(`${SHARED}\n\n## YOUR TASK (verbatim from the plan — execute every step)\n${A.taskBody}\n\n${A.implExtra || ''}\n\nWork through the steps in order (TDD). Then fill the report. \`status\` must be DONE only if the named\nvitest command + typecheck:node + eslint are all green and you committed. Use BLOCKED if you cannot proceed\n(explain why in concerns); use NEEDS_CONTEXT if the task references something you cannot find.`,
  { schema: IMPL_REPORT, label: `impl:T${A.taskNum}` })

if (!impl || impl.status === 'BLOCKED' || impl.status === 'NEEDS_CONTEXT') {
  return { task: A.taskNum, implReport: impl, specVerdict: null, qualityVerdicts: [], halted: true, reason: 'implementer did not complete' }
}

// ---- Spec review (gate) ----
phase('Spec review')
let specVerdict = await agent(specPrompt(), { schema: VERDICT, label: `spec:T${A.taskNum}` })
let specRounds = 0
while (specVerdict && blocking(specVerdict).length && specRounds < 2) {
  specRounds++
  phase('Fix spec')
  await agent(fixPrompt('spec', blocking(specVerdict)), { label: `fix-spec:T${A.taskNum}.${specRounds}` })
  phase('Spec review')
  specVerdict = await agent(specPrompt(), { schema: VERDICT, label: `spec:T${A.taskNum}.re${specRounds}` })
}

// ---- Quality panel (only after spec is clean, per SDD order) ----
const lenses = [
  { name: 'correctness & safety', focus: 'Logic bugs, edge cases, error handling, resource leaks (unclosed streams/children), async/promise hazards, off-by-one, null/undefined, data integrity. For DB: migration idempotency, transaction/save correctness, SQL injection via string-built SQL, CHECK/constraint correctness. Verify the USB/device-safety + no-network constraints are not violated.' },
  { name: 'Electron + sql.js + TypeScript idiom', focus: 'Does it match this codebase\'s established patterns (sql.js run/saveDatabase, runInTransaction/runNoSave, migration table-rebuild pattern, utilityProcess/parentPort usage, electron-vite bundling, config shape)? Type safety (no unsound any leaking into public API, correct exported types). CJS/ESM correctness for the main-process bundle. 120-col / LF.' },
  { name: 'test design & TDD fidelity', focus: 'Do the tests test REAL behavior (not mock behavior)? Are they minimal and clear? Do they cover the edge cases the task implies (skip-short-label, disabled-excluded-from-active, CHECK-rejects-bad-value, singleton-self)? Are mocks set up correctly and not over-mocked? Would these tests actually catch a regression?' },
]
phase('Quality review')
let quality = (await parallel(lenses.map((l) => () =>
  agent(qualityPrompt(l), { schema: VERDICT, phase: 'Quality review', label: `q-${l.name.split(' ')[0]}:T${A.taskNum}` })))).filter(Boolean)
let qRounds = 0
let qBlocking = quality.flatMap(blocking)
while (qBlocking.length && qRounds < 2) {
  qRounds++
  phase('Fix quality')
  await agent(fixPrompt('quality', qBlocking), { label: `fix-q:T${A.taskNum}.${qRounds}` })
  phase('Quality review')
  quality = (await parallel(lenses.map((l) => () =>
    agent(qualityPrompt(l), { schema: VERDICT, phase: 'Quality review', label: `q-${l.name.split(' ')[0]}:T${A.taskNum}.re${qRounds}` })))).filter(Boolean)
  qBlocking = quality.flatMap(blocking)
}

return {
  task: A.taskNum,
  title: A.taskTitle,
  implReport: impl,
  specVerdict,
  specRounds,
  qualityVerdicts: quality,
  qRounds,
  outstandingBlocking: [...blocking(specVerdict), ...qBlocking],
  finalStatus: (specVerdict && specVerdict.pass && qBlocking.length === 0) ? 'CLEAN' : 'HAS_OUTSTANDING_ISSUES',
}
