// Sonda en vivo para los canales nuevos — no corre en CI (requiere red).
// Uso:  $env:TEMP='.tmpcache'; npx vitest run src/plugins/bundled/plurtasko/_live.test.js
import { describe, it } from 'vitest'
import { pelispanda } from './channels/pelispanda.js'
import { magistv24 } from './channels/magistv24.js'

const RUN = process.env.LIVE === '1'
const log = (...a) => console.log(...a)

describe.skipIf(!RUN)('live: canales nuevos', () => {
  it('pelispanda', async () => {
    const movies = await pelispanda.getCatalog({ id: 'pelispanda-movies', skip: 0, top: 5 })
    log('catalog movies:', movies.length, movies[0]?.name)
    const series = await pelispanda.getCatalog({ id: 'pelispanda-series', skip: 0, top: 5 })
    log('catalog series:', series.length, series[0]?.name)
    const res = await pelispanda.search({ query: 'dune' })
    log('search dune:', res.length)
    res.slice(0, 5).forEach(r => log('  -', r.type, r.name, r.id))
    const movie = res.find(r => r.type === 'movie') || res[0]
    const meta = await pelispanda.getMeta({ id: movie.id })
    log('meta:', meta?.name, 'eps:', meta?.episodes?.length)
    const streams = await pelispanda.getStreams({ id: movie.id })
    log('streams:', streams.length)
    streams.slice(0, 4).forEach(s => log('  -', s.name, s.streamType, s.url?.slice(0, 80)))
    if (meta?.episodes?.length) {
      const ep = meta.episodes[0]
      const ss = await pelispanda.getStreams({ id: ep.id, season: ep.season, episode: ep.episode })
      log('episode streams:', ss.length)
      ss.slice(0, 3).forEach(s => log('  -', s.name, s.streamType))
    }
    const serieItem = series[0]
    const smeta = await pelispanda.getMeta({ id: serieItem.id })
    log('serie meta:', smeta?.name, 'eps:', smeta?.episodes?.length)
    if (smeta?.episodes?.length) {
      const ep = smeta.episodes[0]
      const ss = await pelispanda.getStreams({ id: ep.id, season: ep.season, episode: ep.episode })
      log('serie ep streams:', ss.length)
      ss.slice(0, 3).forEach(s => log('  -', s.name, s.streamType, s.url?.slice(0, 60)))
    }
  }, 120000)

  it('magistv24', async () => {
    const movies = await magistv24.getCatalog({ id: 'magistv24-movies', skip: 0, top: 5 })
    log('catalog movies:', movies.length, movies[0]?.name)
    const res = await magistv24.search({ query: 'dune' })
    log('search dune:', res.length)
    res.slice(0, 5).forEach(r => log('  -', r.type, r.name, r.id))
    const movie = res.find(r => r.type === 'movie') || res[0]
    const meta = await magistv24.getMeta({ id: movie.id })
    log('meta:', meta?.name, 'eps:', meta?.episodes?.length)
    const streams = await magistv24.getStreams({ id: movie.id })
    log('streams:', streams.length)
    streams.slice(0, 6).forEach(s => log('  -', s.name, s.url?.slice(0, 90)))
    const serie = res.find(r => r.type === 'series')
    if (serie) {
      const smeta = await magistv24.getMeta({ id: serie.id })
      log('serie meta:', smeta?.name, 'eps:', smeta?.episodes?.length)
      if (smeta?.episodes?.length) {
        const ss = await magistv24.getStreams({ id: smeta.episodes[0].id })
        log('ep streams:', ss.length)
        ss.slice(0, 4).forEach(s => log('  -', s.name, s.url?.slice(0, 90)))
      }
    }
  }, 120000)
})
