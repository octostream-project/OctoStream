// Fachada multiplataforma del motor P2P de torrents.
//   Android  → plugin Capacitor @octostream/torrent-engine (jlibtorrent)
//   Electron → WebTorrent en el proceso principal, vía window.octostream.torrent
//   Web      → no disponible (null)
// Misma superficie: start({url, season, episode, title}) → {url, fileName,
// sizeBytes, infoHash, fileIndex, numFiles}, stop(), status(),
// addListener('torrentProgress', cb).

import { isAndroidNative, isElectron } from './platform.js'

export async function getTorrentEngine() {
  if (isElectron() && window.octostream?.torrent) {
    const t = window.octostream.torrent
    return {
      start: (o) => t.start(o),
      listFiles: (o) => t.listFiles(o),
      download: (o) => t.download(o),
      downloadHttp: (o) => t.downloadHttp(o),
      listDownloads: () => t.listDownloads(),
      deleteDownload: (o) => t.deleteDownload(o),
      getDownloadDir: () => t.getDownloadDir(),
      pickDownloadDir: () => t.pickDownloadDir(),
      setDownloadDirPath: (o) => t.setDownloadDirPath ? t.setDownloadDirPath(o) : t.pickDownloadDir(o),
      downloadVolumes: () => t.downloadVolumes ? t.downloadVolumes() : Promise.resolve({ volumes: [] }),
      requestStorageAccess: () => t.requestStorageAccess ? t.requestStorageAccess() : Promise.resolve({ granted: false }),
      resetDownloadDir: () => t.resetDownloadDir(),
      stop: () => t.stop(),
      status: () => t.status(),
      addListener: (name, cb) => {
        const off = t.on((ev) => { if (ev?.name === name) cb(ev.data ?? {}) })
        return Promise.resolve({ remove: off })
      },
    }
  }
  if (!isAndroidNative()) return null
  try {
    const { TorrentEngine } = await import('@octostream/torrent-engine')
    // El proxy de registerPlugin intercepta TODOS los nombres de método —
    // incluido `then`. Devolverlo crudo hace que `await getTorrentEngine()`
    // lo trate como thenable: el resolver llama proxy.then() → la llamada
    // nativa "TorrentEngine.then()" rechaza ("not implemented") y la
    // promesa exterior queda pendiente para siempre ("Buscando metadatos…"
    // infinito, sin una sola llamada nativa). Se envuelve en un objeto
    // plano: las arrow functions no son thenables.
    const t = TorrentEngine
    return {
      start: (o) => t.start(o),
      listFiles: (o) => t.listFiles(o),
      download: (o) => t.download(o),
      downloadHttp: (o) => t.downloadHttp(o),
      listDownloads: () => t.listDownloads(),
      deleteDownload: (o) => t.deleteDownload(o),
      getDownloadDir: () => t.getDownloadDir(),
      getStorageAccess: () => t.getStorageAccess(),
      pickDownloadDir: () => t.pickDownloadDir(),
      setDownloadDir: (o) => t.setDownloadDir(o),
      setDownloadDirPath: (o) => t.setDownloadDirPath(o),
      downloadVolumes: () => t.downloadVolumes(),
      requestStorageAccess: () => t.requestStorageAccess(),
      resetDownloadDir: () => t.resetDownloadDir(),
      stop: () => t.stop(),
      status: () => t.status(),
      addListener: (name, cb) => t.addListener(name, cb),
    }
  } catch (e) {
    console.warn('[Torrent] motor no disponible:', e?.message)
    return null
  }
}
