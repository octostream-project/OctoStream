// Sonda en vivo de getLatestEpisodes — requiere red:
//   $env:LIVE='1'; npx vitest run src/plugins/bundled/plurtasko/channels/latestEpisodes.test.js
import { describe, it, expect } from 'vitest'
import { jkanime } from './jkanime.js'
import { animeav1 } from './animeav1.js'
import { latanime } from './latanime.js'

const RUN = process.env.LIVE === '1'

describe.skipIf(!RUN)('live: getLatestEpisodes', () => {
  for (const ch of [jkanime, animeav1, latanime]) {
    it(ch.id, async () => {
      const items = await ch.getLatestEpisodes({ top: 10 })
      console.log(`### ${ch.id}: ${items.length} items`)
      for (const it of items.slice(0, 5)) {
        console.log(`  - "${it.name}" ep:${it.episode} poster:${!!it.poster} id:${it.id.slice(0, 80)}`)
      }
      expect(items.length).toBeGreaterThan(0)
      // La ficha madre debe resolverse por getMeta
      const meta = await ch.getMeta({ id: items[0].id })
      console.log(`  meta: ${meta?.name} eps:${meta?.episodes?.length}`)
      expect(meta).toBeTruthy()
    }, 60000)
  }
})
