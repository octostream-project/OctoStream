import { describe, it, expect } from 'vitest'
import { poseidonhd2 } from './poseidonhd2.js'
import { jkanime } from './jkanime.js'
const RUN = process.env.LIVE === '1'
describe.skipIf(!RUN)('live: latest click path', () => {
  it('poseidonhd2 latest → getMeta(parent) → episodes', async () => {
    const latest = await poseidonhd2.getLatestEpisodes({ limit: 3 })
    console.log('phd ids:', latest.map(i => i.id))
    for (const it_ of latest.slice(0, 2)) {
      const meta = await poseidonhd2.getMeta({ id: it_.id })
      console.log('phd meta:', meta?.name, 'type:', meta?.type, 'eps:', meta?.episodes?.length, 'seasonsList:', meta?.seasonsList?.length)
      if (meta?.episodes?.[0]) {
        const st = await poseidonhd2.getStreams({ id: meta.episodes[0].id })
        console.log('phd streams ep1:', st.length)
      }
    }
  }, 120000)
  it('jkanime latest → getMeta → episode streams', async () => {
    const latest = await jkanime.getLatestEpisodes({ limit: 2 })
    for (const it_ of latest.slice(0, 1)) {
      const meta = await jkanime.getMeta({ id: it_.id })
      console.log('jk meta:', meta?.name, 'eps:', meta?.episodes?.length)
      const ep = meta?.episodes?.[meta.episodes.length - 1]
      if (ep) {
        const st = await jkanime.getStreams({ id: ep.id })
        console.log('jk streams last ep:', st.length, st.slice(0, 2).map(s => s.server))
      }
    }
  }, 120000)
})
