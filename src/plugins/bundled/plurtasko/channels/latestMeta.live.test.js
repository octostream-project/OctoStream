import { describe, it, expect } from 'vitest'
import { jkanime } from './jkanime.js'
import { animeav1 } from './animeav1.js'
import { latanime } from './latanime.js'
const RUN = process.env.LIVE === '1'
describe.skipIf(!RUN)('live: latest-episodes parent meta', () => {
  it('jkanime parent url (trailing slash) → meta+episodes', async () => {
    const latest = await jkanime.getLatestEpisodes({ limit: 3 })
    console.log('latest ids:', latest.map(i => i.id))
    for (const it_ of latest.slice(0, 2)) {
      const meta = await jkanime.getMeta({ id: it_.id })
      console.log('meta:', meta?.name, 'eps:', meta?.episodes?.length)
    }
  }, 90000)
  it('animeav1 parent url → meta+episodes', async () => {
    const latest = await animeav1.getLatestEpisodes({ limit: 3 })
    for (const it_ of latest.slice(0, 2)) {
      const meta = await animeav1.getMeta({ id: it_.id })
      console.log('av1 meta:', meta?.name, 'eps:', meta?.episodes?.length)
    }
  }, 90000)
  it('latanime parent url → meta+episodes', async () => {
    const latest = await latanime.getLatestEpisodes({ limit: 3 })
    for (const it_ of latest.slice(0, 2)) {
      const meta = await latanime.getMeta({ id: it_.id })
      console.log('lat meta:', meta?.name, 'eps:', meta?.episodes?.length)
    }
  }, 90000)
})
