import { describe, it, expect } from 'vitest'
import { validateCustomPluginConfig, validatePluginManifest } from './schemas.js'

describe('plugin schemas', () => {
  const validConfig = {
    id: 'custom-demo',
    name: 'Plugin Demo',
    version: '1.0.0',
    description: 'Test plugin',
    types: ['movie'],
    catalogs: [{ id: 'all', name: 'Todo', type: 'movie' }],
    icon: 'film',
    api: {
      baseUrl: 'https://api.example.com',
      catalog: '/catalog?type={type}&id={id}',
    },
  }

  it('accepts valid custom plugin config', () => {
    const result = validateCustomPluginConfig(validConfig)
    expect(result.success).toBe(true)
  })

  it('rejects config without id', () => {
    const result = validateCustomPluginConfig({ ...validConfig, id: '' })
    expect(result.success).toBe(false)
  })

  it('rejects config with invalid API baseUrl', () => {
    const result = validateCustomPluginConfig({ ...validConfig, api: { baseUrl: 'not-a-url' } })
    expect(result.success).toBe(false)
  })

  it('rejects config with invalid catalog type', () => {
    const result = validateCustomPluginConfig({
      ...validConfig,
      catalogs: [{ id: 'all', name: 'Todo', type: 'invalid' }],
    })
    expect(result.success).toBe(false)
  })
})
