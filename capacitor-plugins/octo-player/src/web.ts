import type { OctoPlayerPlugin } from './definitions'

export class OctoPlayerWeb implements OctoPlayerPlugin {
  async playExoPlayer(): Promise<void> {
    throw new Error('ExoPlayer is only available on Android')
  }

  async playVlc(): Promise<void> {
    throw new Error('VLC is only available on Android')
  }
}
