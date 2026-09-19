import { registerPlugin } from '@capacitor/core'
import type { CloudProxyPlugin } from './definitions'

const CloudProxy = registerPlugin<CloudProxyPlugin>('CloudProxy', {
  web: () => import('./web').then(m => new m.CloudProxyWeb()),
})

export * from './definitions'
export { CloudProxy }
