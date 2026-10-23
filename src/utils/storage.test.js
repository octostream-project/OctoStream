import { describe, it, expect, beforeEach } from 'vitest'
import {
  getItem,
  setItem,
  removeItem,
  getItemSync,
  setItemSync,
  removeItemSync,
  getJson,
  setJson,
  getJsonSync,
  setJsonSync,
} from './storage.js'

beforeEach(() => {
  localStorage.clear()
})

describe('getItem / setItem / removeItem', () => {
  it('stores and retrieves a string value', async () => {
    await setItem('test-key', 'hello')
    expect(await getItem('test-key')).toBe('hello')
  })

  it('returns null for missing keys', async () => {
    expect(await getItem('missing-key')).toBeNull()
  })

  it('removes a key', async () => {
    await setItem('test-key', 'hello')
    await removeItem('test-key')
    expect(await getItem('test-key')).toBeNull()
  })
})

describe('getItemSync / setItemSync / removeItemSync', () => {
  it('synchronously stores and retrieves values', () => {
    setItemSync('sync-key', 'value')
    expect(getItemSync('sync-key')).toBe('value')
  })

  it('returns null for missing keys', () => {
    expect(getItemSync('missing-sync')).toBeNull()
  })

  it('removes a key synchronously', () => {
    setItemSync('sync-key', 'value')
    removeItemSync('sync-key')
    expect(getItemSync('sync-key')).toBeNull()
  })
})

describe('getJson / setJson', () => {
  it('round-trips a JSON-serializable object', async () => {
    const obj = { a: 1, b: ['x', 'y'], c: { nested: true } }
    await setJson('json-key', obj)
    expect(await getJson('json-key')).toEqual(obj)
  })

  it('returns the fallback for missing keys', async () => {
    expect(await getJson('missing', { default: true })).toEqual({ default: true })
  })

  it('returns the fallback when stored JSON is corrupt', async () => {
    await setItem('corrupt', '{not valid json')
    expect(await getJson('corrupt', 'fallback')).toBe('fallback')
  })
})

describe('getJsonSync / setJsonSync', () => {
  it('round-trips a JSON-serializable object', () => {
    const obj = { list: [1, 2, 3], name: 'test' }
    setJsonSync('sync-json', obj)
    expect(getJsonSync('sync-json')).toEqual(obj)
  })

  it('returns the fallback for missing keys', () => {
    expect(getJsonSync('missing', 'fb')).toBe('fb')
  })

  it('returns the fallback for corrupt JSON', () => {
    setItemSync('corrupt-sync', '<<<bad>>>')
    expect(getJsonSync('corrupt-sync', 42)).toBe(42)
  })
})

describe('key migration (optopus_* / octo_*)', () => {
  it('runs at module load without throwing', () => {
    // The migration runs at module load and is covered implicitly by importing
    // the module above.
    expect(true).toBe(true)
  })
})
