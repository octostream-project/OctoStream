// Sonda en vivo — requiere red: $env:LIVE='1'; npx vitest run .../repelis28.live.test.js
import { describe, it, expect } from 'vitest'
import { repelis28 } from './repelis28.js'

const RUN = process.env.LIVE === '1'

describe.skipIf(!RUN)('live: repelis28', () => {
  it('serie: meta episodios + streams via /api/episodio', async () => {
    const res = await repelis28.search({ query: 'breaking bad' })
    const serie = res.find(r => r.type === 'series')
    console.log('serie:', serie?.name, serie?.id)
    expect(serie).toBeTruthy()
    const meta = await repelis28.getMeta({ id: serie.id })
    console.log('meta:', meta?.name, 'eps:', meta?.episodes?.length, meta?.episodes?.slice(0, 3))
    expect(meta?.episodes?.length).toBeGreaterThan(0)
    const ep = meta.episodes[0]
    const streams = await repelis28.getStreams({ id: ep.id, season: ep.season, episode: ep.episode })
    console.log('streams:', streams.length, streams.slice(0, 4).map(s => `${s.server} [${s.lang}]`))
    expect(streams.length).toBeGreaterThan(0)
  }, 90000)
})
