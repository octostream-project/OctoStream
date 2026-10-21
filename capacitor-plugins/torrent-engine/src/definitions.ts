import type { PluginListenerHandle } from '@capacitor/core'

export interface TorrentStartOptions {
  /** magnet: URI or http(s) URL of a .torrent file */
  url: string
  /** Season/episode for picking the right file inside season packs */
  season?: number
  episode?: number
  /** Fuerza un índice de archivo concreto (elegido vía listFiles) */
  fileIndex?: number
  title?: string
}

export interface TorrentFileEntry {
  /** Índice del archivo dentro del torrent */
  index: number
  /** Ruta/nombre dentro del torrent (incluye carpetas del pack) */
  name: string
  size: number
}

export interface TorrentListResult {
  files: TorrentFileEntry[]
  infoHash: string
  numFiles: number
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

export interface TorrentDownloadResult {
  name: string
  path: string
  sizeBytes: number
  infoHash: string
  fileIndex: number
  /** true si el archivo ya estaba completo en disco */
  complete: boolean
}

export interface TorrentDownloadEntry {
  /** Ruta relativa dentro del directorio de descargas */
  name: string
  /** Ruta absoluta (reproducible como file:// con localFile) */
  path: string
  size: number
}

export interface TorrentEnginePlugin {
  start(options: TorrentStartOptions): Promise<TorrentStartResult>
  /** Lista los archivos de vídeo del torrent (solo metadatos) para picker UI */
  listFiles(options: { url: string }): Promise<TorrentListResult>
  /**
   * Descarga offline: baja el archivo elegido al directorio persistente de
   * descargas. El progreso llega por 'torrentProgress'; complete=true si ya
   * estaba en disco. Comparte el slot del motor con start().
   */
  download(options: TorrentStartOptions): Promise<TorrentDownloadResult>
  /** Lista los vídeos del directorio de descargas */
  listDownloads(): Promise<{ files: TorrentDownloadEntry[] }>
  /** Borra un archivo del directorio de descargas (path de listDownloads) */
  deleteDownload(options: { path: string }): Promise<{ deleted: boolean }>
  stop(): Promise<void>
  status(): Promise<TorrentStatusResult>
  addListener(eventName: 'torrentProgress', listenerFunc: (event: TorrentProgressEvent) => void): Promise<PluginListenerHandle>
}
