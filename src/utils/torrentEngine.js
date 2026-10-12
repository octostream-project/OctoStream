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
    return TorrentEngine
  } catch (e) {
    console.warn('[Torrent] motor no disponible:', e?.message)
    return null
  }
}
