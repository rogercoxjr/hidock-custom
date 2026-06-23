import type { SummarizationTemplate } from '../../summarization-templates'

export const sermonTemplate: SummarizationTemplate = {
  id: 'tpl-sermon',
  name: 'Church Sermon',
  description: 'Sermon summarization',
  // Any non-empty `instructions` value drives the template path in buildAnalysisPrompt
  // (emits the SUMMARY & EMPHASIS INSTRUCTIONS frame); the exact text is not asserted.
  instructions: 'sermon guidance',
  exampleTriggers: ['sermon'],
  isDefault: false,
  isBuiltin: false,
  enabled: true,
  createdAt: '',
  updatedAt: '',
}

export const salesTemplate: SummarizationTemplate = {
  id: 'tpl-sales',
  name: 'Sales Call',
  description: 'Sales summarization',
  instructions: 'sales guidance',
  exampleTriggers: ['pricing'],
  isDefault: false,
  isBuiltin: false,
  enabled: true,
  createdAt: '',
  updatedAt: '',
}
