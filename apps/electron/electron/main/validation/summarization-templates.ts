import { z } from 'zod'

export const TemplateInputSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  instructions: z.string().min(1).max(2000),
  exampleTriggers: z.array(z.string().max(80)).max(12).optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional()
})

export const TemplatePatchSchema = TemplateInputSchema.partial()

export const TemplateIdSchema = z.object({ id: z.string().min(1) })

export const SetEnabledSchema = z.object({ id: z.string().min(1), enabled: z.boolean() })
