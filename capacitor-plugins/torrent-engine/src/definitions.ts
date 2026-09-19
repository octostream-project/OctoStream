import type { PluginListenerHandle } from '@capacitor/core'

export interface TorrentStartOptions {
  /** magnet: URI or http(s) URL of a .torrent file */
  url: string
  /** Season/episode for picking the right file inside season packs */
  season?: number
  episode?: number
  title?: string
}

export interface TorrentStartResult {
  /** Local streaming endpoint for ExoPlayer, e.g. http://127.0.0.1:PORT/ */
  url: string
  fileName: string
  sizeBytes: number
  infoHash: string
  fileIndex: number
  numFiles: number
}

export interface TorrentStatusResult {
  state: string
  progress: number
  downloadRate: number
  uploadRate: number
  peers: number
  seeds: number
  totalDone: number
  totalSize: number
  fileName: string
}

export interface TorrentProgressEvent {
  state: string
  progress: number
  downloadRate: number
  uploadRate: number
  peers: number
  seeds: number
  totalDone: number
  totalSize: number
  fileName: string
}

export interface TorrentEnginePlugin {
  start(options: TorrentStartOptions): Promise<TorrentStartResult>
  stop(): Promise<void>
  status(): Promise<TorrentStatusResult>
  addListener(eventName: 'torrentProgress', listenerFunc: (event: TorrentProgressEvent) => void): Promise<PluginListenerHandle>
}
