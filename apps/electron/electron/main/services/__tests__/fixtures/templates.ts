import type { SummarizationTemplate } from '../../summarization-templates'

export const sermonTemplate: SummarizationTemplate = {
  id: 'tpl-sermon',
  name: 'Church Sermon',
  description: 'Sermon summarization',
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
