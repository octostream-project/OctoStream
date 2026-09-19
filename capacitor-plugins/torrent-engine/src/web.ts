import { WebPlugin } from '@capacitor/core'
import type { TorrentEnginePlugin, TorrentStartOptions, TorrentStartResult, TorrentStatusResult } from './definitions'

export class TorrentEngineWeb extends WebPlugin implements TorrentEnginePlugin {
  async start(_options: TorrentStartOptions): Promise<TorrentStartResult> {
    throw new Error('Torrent streaming is only available on Android')
  }

  async stop(): Promise<void> {}

  async status(): Promise<TorrentStatusResult> {
    throw new Error('Torrent streaming is only available on Android')
  }
}
