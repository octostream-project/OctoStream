import { describe, it, expect, vi } from 'vitest'
import { replaceParams, withTimeout } from './utils.js'

describe('replaceParams', () => {
  it('replaces placeholders with encoded values', () => {
    const url = '/catalog/{type}/{id}?skip={skip}'
    expect(replaceParams(url, { type: 'movie', id: 'top', skip: 10 }))
      .toBe('/catalog/movie/top?skip=10')
  })

  it('encodes special characters', () => {
    expect(replaceParams('/search?q={query}', { query: 'hello world' }))
      .toBe('/search?q=hello%20world')
  })
})

describe('withTimeout', () => {
  it('resolves when the promise resolves in time', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000)
    expect(result).toBe('ok')
  })

  it('rejects when the promise takes too long', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'too slow'))
      .rejects.toThrow('too slow')
  })
})
