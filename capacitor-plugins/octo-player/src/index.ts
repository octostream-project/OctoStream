import { registerPlugin } from '@capacitor/core'
import type { OctoPlayerPlugin } from './definitions'

const OctoPlayer = registerPlugin<OctoPlayerPlugin>('OctoPlayer', {
  web: () => import('./web').then(m => new m.OctoPlayerWeb()),
})

export * from './definitions'
export { OctoPlayer }
