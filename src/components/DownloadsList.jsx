import { useState, useEffect, useCallback, useRef } from 'react'
import { getTorrentEngine } from '../utils/torrentEngine.js'
import { playLocalFile, pickDownloadFolder } from '../utils/exoPlayer.js'
import { isAndroidNative, isElectron } from '../utils/platform.js'
import { Play, Trash2, Download, FolderOpen, Loader2 } from 'lucide-react'

// Lista de descargas offline (torrent + http): descarga en curso con
// porcentaje, archivos completados (reproducir/borrar) y selector de la
// carpeta destino. Se usa en Mi lista → Descargas y en Añadir Enlace.
export default function DownloadsList() {
  const [downloads, setDownloads] = useState([])
  const [active, setActive] = useState(null)
  const [dirInfo, setDirInfo] = useState(null)
  const [error, setError] = useState('')
  const [pickingDir, setPickingDir] = useState(false)
  const listenerRef = useRef(null)
  const canDownload = isAndroidNative() || isElectron()

  const refresh = useCallback(async () => {
    if (!canDownload) return
    try {
      const engine = await getTorrentEngine()
      const res = await engine?.listDownloads?.()
      setDownloads(res?.files || [])
      const st = await engine?.status?.()
      if (st?.state === 'downloading' && st.fileName) {
        setActive({ name: st.fileName, progress: st.progress || 0 })
      } else {
        setActive(null)
      }
      const dir = await engine?.getDownloadDir?.()
      if (dir?.path) setDirInfo(dir)
    } catch { /* motor no disponible */ }
  }, [canDownload])

  useEffect(() => {
    let alive = true
    const t = setTimeout(() => { refresh() }, 0)
    const sub = (async () => {
      const engine = await getTorrentEngine()
      if (!engine?.addListener || !alive) return
      listenerRef.current = await engine.addListener('torrentProgress', ev => {
        if (ev?.state === 'finished' || ev?.progress >= 1) {
          setActive(null)
          refresh()
        } else if (ev?.fileName || ev?.state === 'downloading') {
          setActive({ name: ev?.fileName || 'Descargando', progress: ev?.progress || 0 })
        }
      })
    })()
    return () => {
      alive = false
      clearTimeout(t)
      try { listenerRef.current?.remove?.() } catch { /* noop */ }
      listenerRef.current = null
    }
  }, [refresh])

  const handlePlay = async (file) => {
    setError('')
    try {
      // URIs SAF (modo carpeta sin all-files) se pasan tal cual — el
      // player las abre por ContentResolver; rutas de archivo van con file://.
      const uri = file.path.startsWith('content://')
        ? file.path
        : (isAndroidNative() ? `file://${file.path}` : file.path)
      await playLocalFile({ uri, title: file.name })
    } catch (e) {
      setError(e?.message || 'No se pudo reproducir la descarga')
    }
  }

  const handleDelete = async (file) => {
    try {
      const engine = await getTorrentEngine()
      await engine?.deleteDownload?.({ path: file.path })
      refresh()
    } catch { /* noop */ }
  }

  const handlePickDir = async () => {
    setError('')
    setPickingDir(true)
    try {
      const engine = await getTorrentEngine()
      let r
      if (isAndroidNative()) {
        // El picker SAF vive en el plugin exoplayer (activity-result probado);
        // torrent-engine solo persiste la URI elegida en sus prefs.
        const picked = await pickDownloadFolder()
        r = picked?.uri ? await engine?.setDownloadDir?.({ treeUri: picked.uri }) : null
      } else {
        r = await engine?.pickDownloadDir?.()
      }
      if (r?.needsPermission) {
        setError('Si tu Android no muestra el ajuste de almacenamiento, pulsa "Carpeta" otra vez: podrás elegir carpeta igualmente.')
        return
      }
      if (r?.path) setDirInfo({ path: r.path, custom: true, treeMode: r.treeMode })
    } catch (e) {
      if (e?.message !== 'cancelled' && !e?.cancelled) {
        setError(e?.message || 'No se pudo elegir la carpeta')
      }
    } finally {
      setPickingDir(false)
    }
  }

  const handleResetDir = async () => {
    try {
      const engine = await getTorrentEngine()
      await engine?.resetDownloadDir?.()
      refresh()
    } catch { /* noop */ }
  }

  if (!canDownload) return null

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex-shrink-0 w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
            <Download className="text-primary-400" size={20} />
          </div>
          <div className="min-w-0">
            <p className="text-white font-medium">Descargas</p>
            <p className="text-xs text-dark-500 truncate">
              {dirInfo?.custom
                ? (dirInfo.treeMode || dirInfo.path.startsWith('content://') ? 'Carpeta elegida' : dirInfo.path)
                : 'Carpeta interna de la app'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {dirInfo?.custom && (
            <button onClick={handleResetDir} className="btn-ghost text-xs" title="Volver a la carpeta por defecto">
              Restablecer
            </button>
          )}
          <button onClick={handlePickDir} disabled={pickingDir} className="btn-secondary flex items-center gap-1.5 text-sm">
            {pickingDir ? <Loader2 size={15} className="animate-spin" /> : <FolderOpen size={15} />}
            Carpeta
          </button>
        </div>
      </div>

      {active && (
        <div className="bg-dark-700/50 rounded-lg p-3 mb-3">
          <div className="flex items-center gap-2 text-sm text-white">
            <Loader2 size={15} className="animate-spin text-primary-400 flex-shrink-0" />
            <span className="truncate flex-1">{active.name}</span>
            <span className="text-primary-400 text-xs flex-shrink-0">{Math.round((active.progress || 0) * 100)}%</span>
          </div>
          <div className="w-full h-1.5 bg-dark-600 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-primary-500 rounded-full transition-all" style={{ width: `${Math.round((active.progress || 0) * 100)}%` }} />
          </div>
        </div>
      )}

      {error && <p className="text-red-400 text-xs mb-3">{error}</p>}

      {downloads.length === 0 && !active ? (
        <p className="text-dark-500 text-sm">Nada descargado todavía. Usa el icono ⬇ en los enlaces de una ficha.</p>
      ) : (
        <div className="space-y-2">
          {downloads.map((f, i) => (
            <div key={f.path || i} className="flex items-center gap-3 bg-dark-700/50 rounded-lg p-3">
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm truncate">{f.name}</p>
                <p className="text-xs text-dark-500">
                  {f.size >= 1e9 ? `${(f.size / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(f.size / 1e6))} MB`}
                </p>
              </div>
              <button onClick={() => handlePlay(f)} className="btn-ghost p-2" title="Reproducir">
                <Play size={18} />
              </button>
              <button onClick={() => handleDelete(f)} className="btn-ghost p-2 text-red-400" title="Borrar">
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
