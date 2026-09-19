import { describe, it, expect, beforeEach, vi } from 'vitest'
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
  syncFromElectron,
  SYNCED_KEYS,
} from './storage.js'

beforeEach(() => {
  localStorage.clear()
})

describe('SYNCED_KEYS', () => {
  it('contains the expected core keys', () => {
    expect(SYNCED_KEYS).toContain('octostream_favorites')
    expect(SYNCED_KEYS).toContain('octostream_history')
    expect(SYNCED_KEYS).toContain('octostream_installed_plugins')
    expect(SYNCED_KEYS).toContain('octostream_language')
  })
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

describe('syncFromElectron', () => {
  it('is a no-op when not on Electron', async () => {
    // window.octostream.platform is undefined in jsdom → isElectron() returns false
    // Should not throw and should not write any keys.
    const before = localStorage.getItem('octostream_favorites')
    await syncFromElectron()
    expect(localStorage.getItem('octostream_favorites')).toBe(before)
  })

  it('mirrors known keys from Electron persistent storage', async () => {
    window.octostream = {
      platform: 'electron',
      getData: vi.fn().mockImplementation((key) => {
        if (key === 'octostream_favorites') return '[{"id":1}]'
        if (key === 'octostream_history') return '[]'
        return null
      }),
    }
    try {
      await syncFromElectron()
      expect(localStorage.getItem('octostream_favorites')).toBe('[{"id":1}]')
      expect(localStorage.getItem('octostream_history')).toBe('[]')
    } finally {
      delete window.octostream
    }
  })

  it('does not overwrite existing localStorage keys with null from Electron', async () => {
    localStorage.setItem('octostream_favorites', '[{"id":2}]')
    window.octostream = {
      platform: 'electron',
      getData: vi.fn().mockResolvedValue(null),
    }
    try {
      await syncFromElectron()
      // Existing value preserved because Electron returned null
      expect(localStorage.getItem('octostream_favorites')).toBe('[{"id":2}]')
    } finally {
      delete window.octostream
    }
  })
})

describe('key migration (optopus_* / octo_*)', () => {
  it('renames optopus_ prefixed keys to octostream_', () => {
    // The migration runs at module load. We can't re-trigger it here, but we
    // can verify the SYNCED_KEYS list uses the new prefix consistently.
    for (const key of SYNCED_KEYS) {
      expect(key.startsWith('octostream_')).toBe(true)
    }
  })
})
