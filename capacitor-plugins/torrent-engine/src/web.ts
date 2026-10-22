import { WebPlugin } from '@capacitor/core'
import type { DownloadDirInfo, DownloadVolume, HttpDownloadOptions, HttpDownloadResult, PickDownloadDirResult, TorrentDownloadResult, TorrentEnginePlugin, TorrentListResult, TorrentStartOptions, TorrentStartResult, TorrentStatusResult } from './definitions'

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

  async downloadHttp(_options: HttpDownloadOptions): Promise<HttpDownloadResult> {
    throw new Error('Descargas solo disponibles en Android/Electron')
  }

  async listDownloads(): Promise<{ files: { name: string; path: string; size: number }[] }> {
    return { files: [] }
  }

  async deleteDownload(_options: { path: string }): Promise<{ deleted: boolean }> {
    return { deleted: false }
  }

  async getDownloadDir(): Promise<DownloadDirInfo> {
    return { path: '', custom: false }
  }

  async pickDownloadDir(): Promise<PickDownloadDirResult> {
    throw new Error('Selector de carpeta solo disponible en Android/Electron')
  }

  async setDownloadDir(_options: { treeUri: string }): Promise<PickDownloadDirResult> {
    throw new Error('Selector de carpeta solo disponible en Android/Electron')
  }

  async downloadVolumes(): Promise<{ volumes: DownloadVolume[] }> {
    return { volumes: [] }
  }

  async setDownloadDirPath(_options: { path: string }): Promise<PickDownloadDirResult> {
    throw new Error('Selector de carpeta solo disponible en Android/Electron')
  }

  async requestStorageAccess(): Promise<{ granted: boolean }> {
    return { granted: false }
  }

  async resetDownloadDir(): Promise<void> {}

  async stop(): Promise<void> {}

  async status(): Promise<TorrentStatusResult> {
    throw new Error('Torrent streaming is only available on Android')
  }
}
