import { useState, useEffect, useCallback } from 'react'
import {
  isAlldebridEnabled,
  listMagnets,
  deleteMagnet,
} from '../plugins/bundled/alldebrid.js'
import { resolveDebridJob, subscribeDebridJobs } from '../utils/debridJobs.js'
import { playStream } from '../utils/exoPlayer.js'
import { toast } from './ui/Toast.jsx'
import OctoLoader from './OctoLoader.jsx'
import { Play, Trash2, CloudDownload, Zap, Hourglass, AlertCircle } from 'lucide-react'

// Estado de un magnet según statusCode de AllDebrid /magnet/status:
// 0 en cola, 1 descargando, 2 comprimiendo/moviendo, 3 subiendo a hosts,
// 4 listo, >=5 error.
const STATUS_LABEL = {
  0: 'En cola',
  1: 'Descargando',
  2: 'Procesando',
  3: 'Subiendo',
}

function magnetProgress(m) {
  if (m.statusCode === 4) return 100
  if (typeof m.processingPerc === 'number') return m.processingPerc
  if (m.size > 0) return Math.min(99, Math.round((m.downloaded || 0) * 100 / m.size))
  return 0
}

const fmtSize = (bytes) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round((bytes || 0) / 1e6))} MB`

// Cola de caché de AllDebrid: los magnets "descargando" (subidos desde la
// app o por la instancia AIOStreams) con su progreso real, reproducir
// cuando statusCode=4 y borrar de la cola. Se muestra en Mi lista → Debrid.
export default function DebridJobsList() {
  const [magnets, setMagnets] = useState(null)
  const [busy, setBusy] = useState(null)

  const refresh = useCallback(async () => {
    if (!isAlldebridEnabled()) return
    const list = await listMagnets()
    setMagnets(list)
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => { if (alive) await refresh() }
    load()
    // Repintado inmediato cuando un job local cambia + re-poll de la cola.
    const unsub = subscribeDebridJobs(load)
    const timer = setInterval(load, 10000)
    return () => { alive = false; unsub(); clearInterval(timer) }
  }, [refresh])

  const handlePlay = async (m) => {
    setBusy(`play-${m.id}`)
    try {
      const url = await resolveDebridJob({ id: m.id, links: null })
      if (!url) {
        toast.error('Listo pero no se pudo desbloquear el enlace')
        return
      }
      await playStream({ url, title: m.filename || 'Debrid', streamType: 'mp4', vps: true })
    } catch (e) {
      toast.error(e?.message || 'No se pudo reproducir')
    } finally {
      setBusy(null)
    }
  }

  const handleDelete = async (m) => {
    setBusy(`del-${m.id}`)
    try {
      await deleteMagnet(m.id)
      setMagnets(prev => (prev || []).filter(x => x.id !== m.id))
      toast('Magnet eliminado de la cola')
    } finally {
      setBusy(null)
    }
  }

  if (!isAlldebridEnabled()) return null

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-shrink-0 w-10 h-10 bg-amber-600/20 rounded-lg flex items-center justify-center">
          <CloudDownload className="text-amber-400" size={20} />
        </div>
        <div className="min-w-0">
          <p className="text-white font-medium">Cacheando en debrid</p>
          <p className="text-xs text-dark-500 truncate">Cola de magnets de tu cuenta AllDebrid</p>
        </div>
      </div>

      {magnets === null ? (
        <div className="flex items-center gap-2 text-dark-500 text-sm py-4">
          <OctoLoader size={15} className="text-amber-400" /> Consultando la cola…
        </div>
      ) : magnets.length === 0 ? (
        <p className="text-dark-500 text-sm">
          Nada en cola. Los magnets que mandes a descargar desde una ficha aparecen aquí.
        </p>
      ) : (
        <div className="space-y-2">
          {magnets.map((m) => {
            const ready = m.statusCode === 4
            const failed = m.statusCode >= 5
            const pct = magnetProgress(m)
            const label = ready ? 'Listo' : failed ? 'Error' : (STATUS_LABEL[m.statusCode] || 'Procesando')
            return (
              <div key={m.id} className="bg-dark-700/50 rounded-lg p-3">
                <div className="flex items-center gap-3">
                  <span className={`flex-shrink-0 ${ready ? 'text-emerald-400' : failed ? 'text-red-400' : 'text-amber-400'}`}>
                    {ready ? <Zap size={16} /> : failed ? <AlertCircle size={16} /> : <Hourglass size={16} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm truncate">{m.filename || m.hash || `Magnet ${m.id}`}</p>
                    <p className={`text-xs ${ready ? 'text-emerald-400' : failed ? 'text-red-400' : 'text-amber-400/80'}`}>
                      {label}
                      {m.size > 0 ? ` · ${fmtSize(m.size)}` : ''}
                      {!ready && !failed ? ` · ${pct}%` : ''}
                    </p>
                  </div>
                  {ready && (
                    <button
                      onClick={() => handlePlay(m)}
                      disabled={busy === `play-${m.id}`}
                      className="btn-ghost p-2 text-emerald-400"
                      title="Reproducir"
                      aria-label={`Reproducir ${m.filename || 'magnet'}`}
                    >
                      {busy === `play-${m.id}` ? <OctoLoader size={16} /> : <Play size={18} />}
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(m)}
                    disabled={busy === `del-${m.id}`}
                    className="btn-ghost p-2 text-red-400"
                    title="Quitar de la cola"
                    aria-label="Quitar magnet de la cola"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
                {!ready && !failed && (
                  <div className="h-1.5 mt-2 rounded-full bg-dark-600 overflow-hidden">
                    <div className="h-full bg-amber-400 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
