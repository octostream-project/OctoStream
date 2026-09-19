import { registerPlugin } from '@capacitor/core'
import type { YoutubePlugin } from './definitions'

const Youtube = registerPlugin<YoutubePlugin>('Youtube', {
  web: () => import('./web').then(m => new m.YoutubeWeb()),
})

export * from './definitions'
export { Youtube }
