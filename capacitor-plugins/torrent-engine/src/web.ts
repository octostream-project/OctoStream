import { WebPlugin } from '@capacitor/core'
import type { TorrentDownloadResult, TorrentEnginePlugin, TorrentListResult, TorrentStartOptions, TorrentStartResult, TorrentStatusResult } from './definitions'

export class TorrentEngineWeb extends WebPlugin implements TorrentEnginePlugin {
  async start(_options: TorrentStartOptions): Promise<TorrentStartResult> {
    throw new Error('Torrent streaming is only available on Android')
  }

  async listFiles(_options: { url: string }): Promise<TorrentListResult> {
    throw new Error('Torrent streaming is only available on Android')
  }

  async download(_options: TorrentStartOptions): Promise<TorrentDownloadResult> {
    throw new Error('Torrent streaming is only available on Android')
  }

  async listDownloads(): Promise<{ files: { name: string; path: string; size: number }[] }> {
    return { files: [] }
  }

  async deleteDownload(_options: { path: string }): Promise<{ deleted: boolean }> {
    return { deleted: false }
  }

  async stop(): Promise<void> {}

  async status(): Promise<TorrentStatusResult> {
    throw new Error('Torrent streaming is only available on Android')
  }
}
