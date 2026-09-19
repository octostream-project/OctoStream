import { describe, it, expect } from 'vitest'
import { validatePluginManifest } from './schemas.js'

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

  it('accepts a valid plugin manifest', () => {
    const result = validatePluginManifest(validConfig)
    expect(result.success).toBe(true)
  })

  it('rejects manifest without id', () => {
    const result = validatePluginManifest({ ...validConfig, id: '' })
    expect(result.success).toBe(false)
  })

  it('rejects manifest with invalid API baseUrl', () => {
    const result = validatePluginManifest({ ...validConfig, api: { baseUrl: 'not-a-url' } })
    expect(result.success).toBe(false)
  })

  it('rejects manifest with invalid catalog type', () => {
    const result = validatePluginManifest({
      ...validConfig,
      catalogs: [{ id: 'all', name: 'Todo', type: 'invalid' }],
    })
    expect(result.success).toBe(false)
  })
})
