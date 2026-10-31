import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({ value: {} }))
vi.mock('./storage.js', () => ({
  getJsonSync: vi.fn(() => storage.value),
  setJsonSync: vi.fn((_key, value) => { storage.value = value }),
}))

import {
  compareStreamsByReliability,
  getStreamLatency,
  getStreamReliability,
  recordStreamOutcome,
  subscribeStreamReliability,
} from './streamReliability.js'

describe('stream reliability', () => {
  beforeEach(() => {
    storage.value = {}
  })

  it('records one outcome with latency and orders by language, cache, then reliability', () => {
    const good = { pluginId: 'provider-good', server: 'mirror', seeds: 1 }
    const bad = { pluginId: 'provider-bad', server: 'mirror', seeds: 500 }
    let notifications = 0
    const unsubscribe = subscribeStreamReliability(() => { notifications += 1 })

    recordStreamOutcome(good, true, 1200)
    recordStreamOutcome(bad, false, 400)

    expect(getStreamReliability(good)).toBeGreaterThan(getStreamReliability(bad))
    expect(getStreamLatency(good)).toBe(1200)
    expect(notifications).toBe(2)

    const rank = stream => stream.langRank
    expect(compareStreamsByReliability(
      { ...bad, langRank: 0 },
      { ...good, langRank: 1 },
      rank,
    )).toBeLessThan(0)
    expect(compareStreamsByReliability(
      { ...bad, langRank: 0, cached: true },
      { ...good, langRank: 0, cached: false },
      rank,
    )).toBeLessThan(0)
    expect(compareStreamsByReliability(
      { ...good, langRank: 0 },
      { ...bad, langRank: 0 },
      rank,
    )).toBeLessThan(0)
    unsubscribe()
  })
})
