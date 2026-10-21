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

export interface HttpDownloadOptions {
  /** URL http(s) directa de un archivo de vídeo (mp4/mkv, debrid, etc.) */
  url: string
  /** Nombre sugerido del archivo (se sanea; la extensión sale de la URL si falta) */
  name?: string
  /** Cabeceras extra (User-Agent/Referer) para CDNs que las exigen */
  headers?: Record<string, string>
}

export interface HttpDownloadResult {
  /** Nombre final del archivo dentro del directorio de descargas */
  name: string
  /** Ruta absoluta (reproducible como file:// con localFile) */
  path: string
  sizeBytes: number
  /** true si el archivo ya estaba completo en disco */
  complete: boolean
}

export interface DownloadDirInfo {
  /** Ruta absoluta actual de descargas */
  path: string
  /** true si es una carpeta elegida por el usuario (no la interna de la app) */
  custom: boolean
  /** Android API 30+: false si falta "Acceso a todos los archivos" */
  allFilesAccess?: boolean
}

export interface PickDownloadDirResult {
  /** Ruta elegida (ausente si needsPermission o cancelado) */
  path?: string
  custom?: boolean
  /** Android: hay que conceder "Acceso a todos los archivos" y reintentar */
  needsPermission?: boolean
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
  /**
   * Descarga directa http(s): baja un archivo de vídeo al directorio de
   * descargas. El progreso llega por 'torrentProgress' (mismo evento que la
   * descarga torrent). No aplica a HLS (m3u8).
   */
  downloadHttp(options: HttpDownloadOptions): Promise<HttpDownloadResult>
  /** Lista los vídeos del directorio de descargas */
  listDownloads(): Promise<{ files: TorrentDownloadEntry[] }>
  /** Borra un archivo del directorio de descargas (path de listDownloads) */
  deleteDownload(options: { path: string }): Promise<{ deleted: boolean }>
  /** Carpeta de descarga actual */
  getDownloadDir(): Promise<DownloadDirInfo>
  /** Selector de carpeta de descargas (SAF en Android, diálogo en Electron) */
  pickDownloadDir(): Promise<PickDownloadDirResult>
  /** Vuelve a la carpeta por defecto */
  resetDownloadDir(): Promise<void>
  stop(): Promise<void>
  status(): Promise<TorrentStatusResult>
  addListener(eventName: 'torrentProgress', listenerFunc: (event: TorrentProgressEvent) => void): Promise<PluginListenerHandle>
}
