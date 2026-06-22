import { randomUUID } from 'crypto'
import { run, queryOne, queryAll } from './database'

export const INSTRUCTIONS_MAX = 2000
export const NAME_MAX = 80
export const DESCRIPTION_MAX = 300
export const TRIGGERS_MAX_COUNT = 12
export const TRIGGER_MAX_LEN = 80
export const BUILTIN_DEFAULT_ID = 'builtin-default'

export interface SummarizationTemplate {
  id: string
  name: string
  description: string
  instructions: string
  exampleTriggers: string[]
  isDefault: boolean
  isBuiltin: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface TemplateInput {
  name: string
  description?: string
  instructions: string
  exampleTriggers?: string[]
  isDefault?: boolean
  enabled?: boolean
}

interface Row {
  id: string; name: string; description: string; instructions: string
  example_triggers: string | null; is_default: number; is_builtin: number
  enabled: number; created_at: string; updated_at: string
}

function scrub(s: string): string {
  return s
    .replace(/<<<+/g, ' ')
    .replace(/>>>+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
}

function mapRow(r: Row): SummarizationTemplate {
  return {
    id: r.id, name: r.name, description: r.description, instructions: r.instructions,
    exampleTriggers: r.example_triggers ? (JSON.parse(r.example_triggers) as string[]) : [],
    isDefault: r.is_default === 1, isBuiltin: r.is_builtin === 1, enabled: r.enabled === 1,
    createdAt: r.created_at, updatedAt: r.updated_at
  }
}

export interface SanitizedTemplate {
  name: string
  description: string
  instructions: string
  exampleTriggers: string[]
  isDefault: boolean
  enabled: boolean
}

export function sanitizeTemplateInput(input: TemplateInput, opts?: { existingNames?: string[] }): SanitizedTemplate {
  // MINOR: scrub the name like description/instructions/triggers so the four
  // user-supplied fields are uniformly stripped of <<< / >>> delimiter runs and
  // control chars (latent today since both prompt sinks re-sanitize, but consistent).
  const name = scrub((input.name ?? '').trim())
  const rawInstructions = scrub((input.instructions ?? '').trim())
  if (!name) throw new Error('Template name is required')
  if (!rawInstructions) throw new Error('Template instructions are required')
  if (name.length > NAME_MAX) throw new Error(`Template name exceeds ${NAME_MAX} chars`)
  if (rawInstructions.length > INSTRUCTIONS_MAX) throw new Error(`Template instructions exceed ${INSTRUCTIONS_MAX} chars`)
  const description = scrub((input.description ?? '').trim())
  if (description.length > DESCRIPTION_MAX) throw new Error(`Template description exceeds ${DESCRIPTION_MAX} chars`)
  const triggers = (input.exampleTriggers ?? []).map((t) => scrub(t.trim())).filter((t) => t.length > 0)
  if (triggers.length > TRIGGERS_MAX_COUNT) throw new Error(`Too many example triggers (max ${TRIGGERS_MAX_COUNT})`)
  for (const t of triggers) if (t.length > TRIGGER_MAX_LEN) throw new Error(`Example trigger exceeds ${TRIGGER_MAX_LEN} chars`)
  if (opts?.existingNames?.some((n) => n.toLowerCase() === name.toLowerCase())) {
    throw new Error(`A template named "${name}" already exists`)
  }
  // is_builtin is intentionally NOT read from input — server-set only.
  return {
    name,
    description,
    instructions: rawInstructions,
    exampleTriggers: triggers,
    isDefault: input.isDefault === true,
    enabled: input.enabled !== false
  }
}

export function listTemplates(): SummarizationTemplate[] {
  return queryAll<Row>('SELECT * FROM summarization_templates ORDER BY is_builtin DESC, name ASC').map(mapRow)
}

export function userTemplates(): SummarizationTemplate[] {
  return queryAll<Row>(
    'SELECT * FROM summarization_templates WHERE is_builtin=0 AND enabled=1 ORDER BY name ASC'
  ).map(mapRow)
}

export function getTemplateById(id: string): SummarizationTemplate | null {
  const r = queryOne<Row>('SELECT * FROM summarization_templates WHERE id = ?', [id])
  return r ? mapRow(r) : null
}

function existingUserNames(excludeId?: string): string[] {
  return queryAll<{ name: string }>(
    'SELECT name FROM summarization_templates WHERE is_builtin=0' + (excludeId ? ' AND id != ?' : ''),
    excludeId ? [excludeId] : []
  ).map((r) => r.name)
}

/**
 * Mutual-exclusivity helper (FIX 1): clear is_default on every OTHER user row so
 * no two user templates can hold is_default=1 at once. Built-in rows are never
 * default and are excluded by is_builtin=0. Each run() auto-saves the DB image.
 * Pass the row being promoted as `keepId` so it is not cleared.
 */
function clearOtherDefaults(keepId: string): void {
  run(
    'UPDATE summarization_templates SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE id != ? AND is_builtin = 0 AND is_default = 1',
    [keepId]
  )
}

export function createTemplate(input: TemplateInput): SummarizationTemplate {
  const s = sanitizeTemplateInput(input, { existingNames: existingUserNames() })
  const id = `summtpl_${randomUUID()}`
  run(
    `INSERT INTO summarization_templates
       (id, name, description, instructions, example_triggers, is_default, is_builtin, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    [id, s.name, s.description, s.instructions, JSON.stringify(s.exampleTriggers), s.isDefault ? 1 : 0, s.enabled ? 1 : 0]
  )
  // Enforce single-default invariant when creating a row already marked default.
  if (s.isDefault) clearOtherDefaults(id)
  return getTemplateById(id)!
}

function assertNotBuiltin(id: string, action: string): SummarizationTemplate {
  const existing = getTemplateById(id)
  if (!existing) throw new Error(`Template not found: ${id}`)
  if (existing.isBuiltin) throw new Error(`Cannot ${action} the built-in Default template`)
  return existing
}

export function updateTemplate(id: string, patch: Partial<TemplateInput>): SummarizationTemplate {
  const existing = assertNotBuiltin(id, 'edit')
  const merged: TemplateInput = {
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    instructions: patch.instructions ?? existing.instructions,
    exampleTriggers: patch.exampleTriggers ?? existing.exampleTriggers,
    isDefault: patch.isDefault ?? existing.isDefault,
    enabled: patch.enabled ?? existing.enabled
  }
  const s = sanitizeTemplateInput(merged, { existingNames: existingUserNames(id) })
  run(
    `UPDATE summarization_templates
     SET name=?, description=?, instructions=?, example_triggers=?,
         is_default=?, enabled=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`,
    [s.name, s.description, s.instructions, JSON.stringify(s.exampleTriggers), s.isDefault ? 1 : 0, s.enabled ? 1 : 0, id]
  )
  // Mutual exclusivity (FIX 1): when this row is (now) the default, demote every
  // other user row in the same operation so only one user template is default.
  if (s.isDefault) clearOtherDefaults(id)
  return getTemplateById(id)!
}

export function setEnabled(id: string, enabled: boolean): void {
  assertNotBuiltin(id, 'disable')
  run('UPDATE summarization_templates SET enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [enabled ? 1 : 0, id])
}

export function deleteTemplate(id: string): void {
  assertNotBuiltin(id, 'delete')
  run('DELETE FROM summarization_templates WHERE id=?', [id])
}
