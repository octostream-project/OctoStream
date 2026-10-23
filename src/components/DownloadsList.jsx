import { useState, useEffect, useCallback, useRef } from 'react'
import { getTorrentEngine } from '../utils/torrentEngine.js'
import { playLocalFile, pickDownloadFolder } from '../utils/exoPlayer.js'
import { isAndroidNative, isElectron } from '../utils/platform.js'
import { toast } from './ui/Toast.jsx'
import Modal from './ui/Modal.jsx'
import OctoLoader from './OctoLoader.jsx'
import { Play, Trash2, Download, FolderOpen, HardDrive, Usb, FolderSearch } from 'lucide-react'

// Una llamada nativa que nunca resuelve no puede dejar la UI girando.
const withTimeout = (p, ms) => Promise.race([
  Promise.resolve(p),
  new Promise(r => setTimeout(() => r(null), ms)),
])

// Lista de descargas offline (torrent + http): descarga en curso con
// porcentaje, archivos completados (reproducir/borrar) y selector de la
// carpeta destino. Se usa en Mi lista → Descargas y en Añadir Enlace.
export default function DownloadsList() {
  const [downloads, setDownloads] = useState([])
  const [active, setActive] = useState(null)
  const [dirInfo, setDirInfo] = useState(null)
  const [pickingDir, setPickingDir] = useState(false)
  const [dirPickerOpen, setDirPickerOpen] = useState(false)
  const [dirPickerMessage, setDirPickerMessage] = useState('')
  const [volumes, setVolumes] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const listenerRef = useRef(null)
  const canDownload = isAndroidNative() || isElectron()

  const refresh = useCallback(async () => {
    if (!canDownload) return
    try {
      const engine = await getTorrentEngine()
      const res = await engine?.listDownloads?.()
      if (res?.error) toast(res.error, 5000)
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
          if (ev?.fileName) toast.success(`Descarga completada: ${ev.fileName}`)
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
    try {
      // URIs SAF (modo carpeta sin all-files) se pasan tal cual — el
      // player las abre por ContentResolver; rutas de archivo van con file://.
      const uri = file.path.startsWith('content://')
        ? file.path
        : (isAndroidNative() ? `file://${file.path}` : file.path)
      await playLocalFile({ uri, title: file.name })
    } catch (e) {
      toast.error(e?.message || 'No se pudo reproducir la descarga')
    }
  }

  const handleDelete = async (file) => {
    try {
      const engine = await getTorrentEngine()
      await engine?.deleteDownload?.({ path: file.path })
      toast('Descarga eliminada')
      refresh()
    } catch (e) {
      toast.error(e?.message || 'No se pudo borrar la descarga')
    }
  }

  // Android: modal con volúmenes escribibles sin permisos (interno/SD/USB)
  // + opción SAF para otra carpeta. En algunas ROMs el tree picker no
  // existe, y el sistema rechaza elegir la raíz o Descargas raíz — los
  // volúmenes de la app funcionan siempre.
  const handlePickDir = async () => {
    if (!isAndroidNative()) {
      setPickingDir(true)
      try {
        const engine = await getTorrentEngine()
        const r = await engine?.pickDownloadDir?.()
        if (r?.path) {
          setDirInfo({ path: r.path, custom: true, treeMode: r.treeMode })
          toast.success('Carpeta de descargas guardada')
        }
      } catch (e) {
        if (e?.message !== 'cancelled' && !e?.cancelled) {
          toast.error(e?.message || 'No se pudo elegir la carpeta')
        }
      } finally {
        setPickingDir(false)
      }
      return
    }
    setVolumes(null)
    setDirPickerOpen(true)
    try {
      const engine = await getTorrentEngine()
      // Si un volumen montado cuelga el listado nativo, no dejar el
      // spinner para siempre: a los 6s se muestra la lista vacía.
      const res = await Promise.race([
        engine?.downloadVolumes?.(),
        new Promise(r => setTimeout(() => r(null), 6000)),
      ])
      setVolumes(res?.volumes || [])
    } catch {
      setVolumes([])
    }
  }

  const handleVolumePick = async (vol) => {
    setPickingDir(true)
    try {
      const engine = await getTorrentEngine()
      const r = await withTimeout(engine?.setDownloadDirPath?.({ path: vol.path }), 8000)
      if (!r) toast.error('El almacenamiento no respondió — prueba con otro volumen')
      if (r?.path) {
        setDirInfo({ path: r.path, custom: true, treeMode: false })
        toast.success('Carpeta de descargas guardada')
        setDirPickerOpen(false)
      }
    } catch (e) {
      toast.error(e?.message || 'No se pudo usar esa carpeta')
    } finally {
      setPickingDir(false)
    }
  }

  // Re-comprueba el permiso all-files (al volver de la pantalla de ajustes)
  // y recarga los volúmenes: con acceso aparece "Descargas del sistema".
  const recheckStorageAccess = useCallback(async () => {
    try {
      const engine = await getTorrentEngine()
      const dir = await withTimeout(engine?.getDownloadDir?.(), 4000)
      if (!dir) return false
      setDirInfo(dir)
      if (dir.allFilesAccess) {
        const res = await withTimeout(engine?.downloadVolumes?.(), 6000)
        setVolumes(res?.volumes || [])
      }
      return !!dir.allFilesAccess
    } catch { return false }
  }, [])

  const awaitingGrantRef = useRef(false)
  useEffect(() => {
    if (!isAndroidNative()) return
    let handle
    import('@capacitor/app').then(({ App }) => App.addListener('appStateChange', async ({ isActive }) => {
      if (!isActive || !awaitingGrantRef.current) return
      awaitingGrantRef.current = false
      const ok = await recheckStorageAccess()
      if (ok) toast.success('Acceso al almacenamiento concedido')
      else toast('No se concedió el acceso — puedes usar las carpetas de la app o el selector del sistema', 6000)
    })).then(h => { handle = h }).catch(() => {})
    return () => { try { handle?.remove?.() } catch { /* noop */ } }
  }, [recheckStorageAccess])

  const handleGrantStorage = async () => {
    setPickingDir(true)
    try {
      const engine = await getTorrentEngine()
      // El nativo muestra el diálogo runtime y luego abre los ajustes —
      // puede tardar lo que tarde el usuario en responder; el timeout solo
      // cubre una llamada que nunca vuelva.
      const r = await withTimeout(engine?.requestStorageAccess?.(), 120000)
      if (r?.granted) {
        await recheckStorageAccess()
        toast.success('Acceso al almacenamiento concedido')
      } else if (r?.opened) {
        awaitingGrantRef.current = true
        setDirPickerMessage('Activa "Permitir acceso a todos los archivos" para OctoStream y vuelve a la app.')
      } else {
        toast('No se pudo abrir la pantalla de permisos — usa las carpetas de la app o el selector del sistema', 6000)
      }
    } catch (e) {
      toast.error(e?.message || 'No se pudo pedir el permiso')
    } finally {
      setPickingDir(false)
    }
  }

  const handleSafPick = () => {
    setPickingDir(true)
    setDirPickerMessage('')
    // Si el DocumentsUI del sistema no llega a abrir (algunas ROMs), la
    // promesa queda pendiente para siempre — liberamos el spinner a los
    // 4s y avisamos a los 8s; si el picker abre tarde, la selección se
    // aplica igualmente al resolver.
    let settled = false
    const unstick = setTimeout(() => {
      if (!settled) {
        setPickingDir(false)
        setDirPickerMessage('Si el selector del sistema está abierto, termina allí la selección. Si no llegó a abrirse, prueba un volumen de la lista o vuelve a intentar.')
      }
    }, 4000)
    const watchdog = setTimeout(() => {
      if (!settled) {
        setDirPickerMessage('El selector del sistema aún no devolvió una carpeta. Vuelve a OctoStream y prueba un volumen de la lista o permite el acceso al almacenamiento.')
        toast('El selector de carpetas del sistema no respondió — elige un volumen de la lista o permite el acceso al almacenamiento', 7000)
      }
    }, 8000)
    ;(async () => {
      try {
        const engine = await getTorrentEngine()
        const picked = await pickDownloadFolder()
        const r = picked?.uri ? await engine?.setDownloadDir?.({ treeUri: picked.uri }) : null
        if (r?.path) {
          setDirInfo({ path: r.path, custom: true, treeMode: r.treeMode })
          setDirPickerMessage('')
          toast.success('Carpeta de descargas guardada')
          setDirPickerOpen(false)
        }
      } catch (e) {
        if (e?.message === 'cancelled' || e?.cancelled) {
          // Android no deja conceder la raíz del almacenamiento ni la raíz
          // de Descargas — hay que elegir/crear una subcarpeta dentro.
          toast('Para elegir carpeta con el selector del sistema, entra en Descargas (o SD/USB) y selecciona o crea una subcarpeta — la raíz no está permitida por Android.', 6000)
        } else {
          toast.error(e?.message || 'No se pudo elegir la carpeta')
        }
      } finally {
        settled = true
        clearTimeout(unstick)
        clearTimeout(watchdog)
        setPickingDir(false)
      }
    })()
  }

  const handleResetDir = async () => {
    try {
      const engine = await getTorrentEngine()
      await engine?.resetDownloadDir?.()
      toast('Carpeta restablecida a la interna')
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
            {pickingDir ? <OctoLoader size={15} className="text-primary-400" /> : <FolderOpen size={15} />}
            Carpeta
          </button>
        </div>
      </div>

      {active && (
        <div className="bg-dark-700/50 rounded-lg p-3 mb-3">
          <div className="flex items-center gap-2 text-sm text-white">
            <OctoLoader size={15} className="text-primary-400 flex-shrink-0" />
            <span className="truncate flex-1">{active.name}</span>
            <span className="text-primary-400 text-xs flex-shrink-0">{Math.round((active.progress || 0) * 100)}%</span>
          </div>
          <div className="w-full h-1.5 bg-dark-600 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-primary-500 rounded-full transition-all" style={{ width: `${Math.round((active.progress || 0) * 100)}%` }} />
          </div>
        </div>
      )}

      {downloads.length === 0 && !active ? (
        <p className="text-dark-500 text-sm flex items-center gap-1">
          Nada descargado todavía. Usa el icono <Download size={13} className="inline-block" /> en los enlaces de una ficha.
        </p>
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
              <button onClick={() => handlePlay(f)} className="btn-ghost p-2" title="Reproducir" aria-label={`Reproducir ${f.name}`}>
                <Play size={18} />
              </button>
              <button onClick={() => setConfirmDelete(f)} className="btn-ghost p-2 text-red-400" title="Borrar" aria-label={`Borrar ${f.name}`}>
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </div>
      )}

      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(null)} labelledBy="dl-del-title">
          <h3 id="dl-del-title" className="text-white font-semibold mb-2">Borrar descarga</h3>
          <p className="text-dark-400 text-sm mb-5 break-all">
            Se eliminará «{confirmDelete.name}» del dispositivo. Esta acción no se puede deshacer.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmDelete(null)} className="btn-ghost text-sm">
              Cancelar
            </button>
            <button
              onClick={() => { const f = confirmDelete; setConfirmDelete(null); handleDelete(f) }}
              className="btn-primary text-sm bg-red-600 hover:bg-red-500"
            >
              Borrar
            </button>
          </div>
        </Modal>
      )}

      {dirPickerOpen && (
        <Modal onClose={() => setDirPickerOpen(false)} labelledBy="dl-dir-title">
          <h3 id="dl-dir-title" className="text-white font-semibold mb-1">Carpeta de descargas</h3>
          <p className="text-dark-500 text-xs mb-4">
            Las opciones de la app funcionan sin permisos en cualquier Android.
          </p>
          {volumes === null ? (
            <div className="flex items-center gap-2 text-dark-500 text-sm py-4">
              <OctoLoader size={15} className="text-primary-400" /> Buscando almacenamiento…
            </div>
          ) : (
            <div className="space-y-2 mb-4">
              {volumes.length === 0 && (
                <p className="text-dark-500 text-sm py-2">
                  No se detectó almacenamiento — prueba con el selector del sistema.
                </p>
              )}
              {volumes.map((v) => {
                const Icon = v.removable ? Usb : HardDrive
                const root = v.path.replace(/\/Android\/data\/.*$/, '')
                return (
                  <button
                    key={v.path}
                    onClick={() => handleVolumePick(v)}
                    disabled={!v.writable || pickingDir}
                    className="w-full flex items-center gap-3 bg-dark-700/60 hover:bg-dark-600/60 rounded-lg p-3 text-left disabled:opacity-40"
                  >
                    <Icon size={18} className="text-primary-400 flex-shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-white text-sm truncate">{v.label}</span>
                      <span className="block text-xs text-dark-500 truncate">{root}</span>
                    </span>
                    {v.freeBytes > 0 && (
                      <span className="text-xs text-dark-500 flex-shrink-0">
                        {v.freeBytes >= 1e9 ? `${(v.freeBytes / 1e9).toFixed(1)} GB` : `${Math.round(v.freeBytes / 1e6)} MB`} libres
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          {dirPickerMessage && (
            <p role="status" className="text-amber-300 text-sm mb-3" aria-live="polite">
              {dirPickerMessage}
            </p>
          )}
          {!dirInfo?.allFilesAccess && isAndroidNative() && (
            <button onClick={handleGrantStorage} disabled={pickingDir} className="btn-secondary w-full flex items-center justify-center gap-2 text-sm mb-2">
              <HardDrive size={15} />
              Permitir acceso a todo el almacenamiento
            </button>
          )}
          <button onClick={handleSafPick} disabled={pickingDir} className="btn-secondary w-full flex items-center justify-center gap-2 text-sm">
            {pickingDir ? <OctoLoader size={15} className="text-primary-400" /> : <FolderSearch size={15} />}
            Otra carpeta (selector del sistema)
          </button>
        </Modal>
      )}
    </div>
  )
}
