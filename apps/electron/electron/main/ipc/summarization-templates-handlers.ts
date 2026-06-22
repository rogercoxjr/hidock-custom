/**
 * Summarization Templates IPC Handlers
 *
 * CRUD over IPC for summarization templates (Phase 2 of summarization-templates plan).
 * Selection/preview/resummarize are deferred to Phases 3-4.
 */

import { ipcMain } from 'electron'
import { success, error, Result } from '../types/api'
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  setEnabled,
  deleteTemplate,
  type SummarizationTemplate
} from '../services/summarization-templates'
import {
  TemplateInputSchema,
  TemplatePatchSchema,
  TemplateIdSchema,
  SetEnabledSchema
} from '../validation/summarization-templates'

export function registerSummarizationTemplatesHandlers(): void {
  ipcMain.handle(
    'summarizationTemplates:list',
    async (): Promise<Result<SummarizationTemplate[]>> => {
      try {
        return success(listTemplates())
      } catch (err) {
        return error('INTERNAL_ERROR', 'Failed to list templates', err)
      }
    }
  )

  ipcMain.handle(
    'summarizationTemplates:create',
    async (_, payload: unknown): Promise<Result<SummarizationTemplate>> => {
      const parsed = TemplateInputSchema.safeParse(payload)
      if (!parsed.success) {
        return error('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid template', parsed.error.format())
      }
      try {
        return success(createTemplate(parsed.data))
      } catch (err) {
        return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'Create failed', err)
      }
    }
  )

  ipcMain.handle(
    'summarizationTemplates:update',
    async (_, id: unknown, patch: unknown): Promise<Result<SummarizationTemplate>> => {
      const idP = TemplateIdSchema.safeParse({ id })
      const patchP = TemplatePatchSchema.safeParse(patch)
      if (!idP.success || !patchP.success) {
        return error('VALIDATION_ERROR', 'Invalid update', null)
      }
      try {
        return success(updateTemplate(idP.data.id, patchP.data))
      } catch (err) {
        return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'Update failed', err)
      }
    }
  )

  ipcMain.handle(
    'summarizationTemplates:setEnabled',
    async (_, payload: unknown): Promise<Result<true>> => {
      const parsed = SetEnabledSchema.safeParse(payload)
      if (!parsed.success) {
        return error('VALIDATION_ERROR', 'Invalid request', null)
      }
      try {
        setEnabled(parsed.data.id, parsed.data.enabled)
        return success(true as const)
      } catch (err) {
        return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'Failed', err)
      }
    }
  )

  ipcMain.handle(
    'summarizationTemplates:delete',
    async (_, payload: unknown): Promise<Result<true>> => {
      const parsed = TemplateIdSchema.safeParse(payload)
      if (!parsed.success) {
        return error('VALIDATION_ERROR', 'Invalid request', null)
      }
      try {
        deleteTemplate(parsed.data.id)
        return success(true as const)
      } catch (err) {
        return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'Failed', err)
      }
    }
  )
}
