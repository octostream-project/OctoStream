// AUDIT — real network calls against each channel's live site.
// Skipped by default (hits the network); run explicitly with:
//   AUDIT_LIVE=1 npx vitest run src/plugins/bundled/plurtasko/channels/audit.test.js
import { describe, it } from 'vitest'
import { config } from 'dotenv'
config() // carga .env (VITE_HDFULL_USERNAME/PASSWORD)

import { animeflvone } from './animeflvone.js'
import { animeyt } from './animeyt.js'
import { monoschinos } from './monoschinos.js'
import { pelispedia } from './pelispedia.js'
import { pelisplushd } from './pelisplushd.js'
import { repelishd } from './repelishd.js'
import { animeav1 } from './animeav1.js'
import { hdfull } from './hdfull.js'
import { entrepeliculasyseries } from './entrepeliculasyseries.js'
import { serieskao } from './serieskao.js'
import { flizzmovies } from './flizzmovies.js'
import { pelisgratishd } from './pelisgratishd.js'
import { gnulatv } from './gnulatv.js'
import { seriesyonkissx } from './seriesyonkissx.js'
import { doramaexpress } from './doramaexpress.js'
import { doramasyt } from './doramasyt.js'
import { tioanime } from './tioanime.js'
import { jkanime } from './jkanime.js'
import { dontorrent } from './dontorrent.js'
import { grantorrent } from './grantorrent.js'
import { subtorrents } from './subtorrents.js'

const CHANNELS = [
  animeflvone, animeyt, monoschinos, pelispedia, pelisplushd, repelishd,
  animeav1, hdfull, entrepeliculasyseries, serieskao, flizzmovies,
  pelisgratishd, gnulatv, seriesyonkissx, doramaexpress, doramasyt,
  tioanime, jkanime, dontorrent, grantorrent, subtorrents,
]

const QUERY_BY_KIND = {
  anime: 'naruto',
  dorama: 'squid game',
  default: 'matrix',
}
const kindOf = (ch) =>
  ch.id.match(/anime|jkanime|monoschinos|tioanime/) ? 'anime'
    : ch.id.match(/dorama/) ? 'dorama' : 'default'

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`timeout ${ms}ms`)), ms))])

// Resumen compacto de un stream: server · lang · quality · streamType
const streamInfo = (s) =>
  `${s.server || s.name || '?'} [${s.lang || '-'}|${s.quality || '-'}|${s.streamType || '-'}]`

// Cuántos streams llevan los campos que la UI muestra (server, lang, quality)
const fieldCoverage = (streams) => {
  const n = streams.length
  const cov = (f) => streams.filter(s => s[f] && String(s[f]).trim()).length
  return `${n} total | server:${cov('server')} lang:${cov('lang')} quality:${cov('quality')}`
}

describe.skipIf(!process.env.AUDIT_LIVE)('AUDIT real sites', () => {
  for (const ch of CHANNELS) {
    it(`${ch.id}`, async () => {
      const query = QUERY_BY_KIND[kindOf(ch)]
      const lines = [`\n### ${ch.id}`]

      try {
        const catId = ch.catalogs?.[0]?.id
        if (catId) {
          const items = await withTimeout(ch.getCatalog({ id: catId, skip: 0, top: 10 }), 25000)
          lines.push(`  catalog: ${items?.length ?? 0} items` + (items?.[0] ? ` | first: "${items[0].name}"` : ''))
        }
      } catch (e) { lines.push(`  catalog: ERR ${e.message}`) }

      try {
        const items = await withTimeout(ch.search({ query }), 25000)
        lines.push(`  search(${query}): ${items?.length ?? 0} items`)
        // Probar hasta 2 resultados distintos por canal
        for (const item of (items || []).slice(0, 2)) {
          lines.push(`  ▸ "${item.name}" (${item.type})`)
          const meta = await withTimeout(ch.getMeta({ id: item.id }), 25000).catch(e => ({ err: e.message }))
          if (meta?.err) { lines.push(`    meta: ERR ${meta.err}`); continue }
          lines.push(`    meta: ${meta?.episodes?.length ?? '-'} eps`)
          const ep = meta?.episodes?.length ? meta.episodes[0] : { id: item.id }
          const streams = await withTimeout(
            ch.getStreams({ id: ep.id, type: item.type, name: meta?.name || item.name, season: ep.season, episode: ep.episode }),
            35000
          ).catch(e => ({ err: e.message }))
          if (streams?.err) { lines.push(`    streams: ERR ${streams.err}`); continue }
          lines.push(`    streams: ${fieldCoverage(streams || [])}`)
          for (const s of (streams || []).slice(0, 4)) lines.push(`      - ${streamInfo(s)}`)
          const torrents = (streams || []).filter(s => s.streamType === 'torrent' || /magnet:|\.torrent/i.test(String(s.url)))
          if (torrents.length) lines.push(`      ⛓ ${torrents.length} torrent/magnet`)
        }
      } catch (e) { lines.push(`  search(${query}): ERR ${e.message}`) }

      console.log(lines.join('\n'))
    }, 180000)
  }
})
