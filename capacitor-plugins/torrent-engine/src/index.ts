import { registerPlugin } from '@capacitor/core'
import type { TorrentEnginePlugin } from './definitions'

const TorrentEngine = registerPlugin<TorrentEnginePlugin>('TorrentEngine', {
  web: () => import('./web').then(m => new m.TorrentEngineWeb()),
})

export * from './definitions'
export { TorrentEngine }
