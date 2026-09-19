import { registerPlugin } from '@capacitor/core'
import type { ExoPlayerPlugin } from './definitions'

const ExoPlayer = registerPlugin<ExoPlayerPlugin>('ExoPlayer', {
  web: () => import('./web').then(m => new m.ExoPlayerWeb()),
})

export * from './definitions'
export { ExoPlayer }
