// AUDIT — real network calls against each channel's live site.
// Skipped by default (hits the network); run explicitly with:
//   AUDIT_LIVE=1 npx vitest run src/plugins/bundled/plurtasko/channels/audit.test.js
import { describe, it } from 'vitest'

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

describe.skipIf(!process.env.AUDIT_LIVE)('AUDIT real sites', () => {
  for (const ch of CHANNELS) {
    it(`${ch.id}`, async () => {
      const report = { id: ch.id, catalog: null, search: null, meta: null, streams: null }
      const query = QUERY_BY_KIND[kindOf(ch)]

      try {
        const catId = ch.catalogs?.[0]?.id
        if (catId) {
          const items = await withTimeout(ch.getCatalog({ id: catId, skip: 0, top: 10 }), 25000)
          report.catalog = `${items?.length ?? 0} items` + (items?.[0] ? ` | first: "${items[0].name}"` : '')
        }
      } catch (e) { report.catalog = `ERR ${e.message}` }

      try {
        const items = await withTimeout(ch.search({ query }), 25000)
        report.search = `${items?.length ?? 0} items` + (items?.[0] ? ` | first: "${items[0].name}" (${items[0].type})` : '')
        if (items?.length) {
          const meta = await withTimeout(ch.getMeta({ id: items[0].id }), 25000).catch(e => ({ err: e.message }))
          report.meta = meta?.err ? `ERR ${meta.err}` : `${meta?.episodes?.length ?? '-'} eps | ${meta?.name ?? 'no-name'}`
          const streamArg = meta?.episodes?.length ? meta.episodes[0] : { id: items[0].id }
          const streams = await withTimeout(
            ch.getStreams({ id: streamArg.id, type: items[0].type }), 30000
          ).catch(e => ({ err: e.message }))
          report.streams = streams?.err
            ? `ERR ${streams.err}`
            : `${streams?.length ?? 0} streams` + (streams?.[0] ? ` | ${streams[0].server || streams[0].name}` : '')
        }
      } catch (e) { report.search = `ERR ${e.message}` }

      console.log(`\n### ${ch.id}\n  catalog: ${report.catalog}\n  search(${query}): ${report.search}\n  meta: ${report.meta}\n  streams: ${report.streams}`)
    }, 120000)
  }
})
