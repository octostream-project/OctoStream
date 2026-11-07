import { describe, it, expect } from 'vitest'
import { poseidonhd2 } from './poseidonhd2.js'
const RUN = process.env.LIVE === '1'
describe.skipIf(!RUN)('live: poseidonhd2 latest', () => {
  it('devuelve últimos episodios', async () => {
    const items = await poseidonhd2.getLatestEpisodes({ limit: 10 })
    console.log('items:', items.length, items.slice(0, 3).map(i => `${i.name} S${i.season}E${i.episode}`))
    expect(items.length).toBeGreaterThan(0)
  }, 60000)
})
