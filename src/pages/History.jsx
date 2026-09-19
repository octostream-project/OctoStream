import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { Clock, Play, Trash2, X, CheckCircle2 } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { formatDuration } from '../utils/format.js'

export default function History() {
  const watchHistory = useStore(s => s.watchHistory)
  const removeFromHistory = useStore(s => s.removeFromHistory)
  const clearHistory = useStore(s => s.clearHistory)
  const navigate = useNavigate()
  const [confirmClear, setConfirmClear] = useState(false)
  const confirmBtnRef = useRef(null)

  // Al mostrar el confirm, mover el foco a "Sí, borrar" (el botón anterior
  // desaparece del DOM y sin esto el foco salta al nav).
  useEffect(() => {
    if (confirmClear) confirmBtnRef.current?.focus()
  }, [confirmClear])

  return (
    <div className="p-4 lg:p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Historial</h1>
        {watchHistory.length > 0 && (
          confirmClear ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-dark-300">¿Borrar todo?</span>
              <button
                ref={confirmBtnRef}
                onClick={() => { clearHistory(); setConfirmClear(false) }}
                tabIndex={0}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700"
              >
                Sí, borrar
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                tabIndex={0}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-dark-700 text-dark-300 hover:bg-dark-600"
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              tabIndex={0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-dark-800 text-dark-300 hover:bg-dark-700 hover:text-white"
            >
              <Trash2 size={16} />
              Borrar todo
            </button>
          )
        )}
      </div>

      {watchHistory.length === 0 ? (
        <div
          tabIndex={0}
          data-tv-card
          className="flex flex-col items-center justify-center min-h-[50vh] gap-4"
        >
          <Clock className="text-dark-600" size={64} />
          <p className="text-dark-400 text-lg">No has reproducido nada todavía</p>
        </div>
      ) : (
        <div className="space-y-2">
          {watchHistory.map(item => {
            const progress = item.progress || 0
            const isCompleted = progress >= 0.95
            return (
              <div
                key={`${item.type}-${item.id}`}
                data-tv-row
                className="flex items-center gap-3 bg-dark-800 rounded-lg p-3 transition-colors"
              >
                {/* Poster thumbnail - clickable to go to details */}
                <button
                  onClick={() => navigate(`/details/${item.type}/${item.id}`)}
                  tabIndex={0}
                  data-tv-card
                  className="flex-shrink-0"
                  title="Ver detalles"
                >
                  {item.poster ? (
                    <img src={item.poster} alt={item.name} loading="lazy" className="w-12 h-16 object-cover rounded" />
                  ) : (
                    <div className="w-12 h-16 bg-dark-700 rounded flex items-center justify-center">
                      <Play size={16} className="text-dark-500" />
                    </div>
                  )}
                </button>

                {/* Info - clickable to go to details */}
                <button
                  onClick={() => navigate(`/details/${item.type}/${item.id}`)}
                  tabIndex={0}
                  data-tv-card
                  className="tv-no-scale flex-1 min-w-0 text-left"
                >
                  <p className="text-white font-medium truncate">{item.name}</p>
                  <p className="text-xs text-dark-400">
                    {item.watchedAt ? new Date(item.watchedAt).toLocaleDateString('es-ES', {
                      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
                    }) : ''}
                  </p>
                  {progress > 0 && (
                    <div className="mt-1">
                      <div className="h-1 bg-dark-700 rounded-full overflow-hidden w-24">
                        <div
                          className={`h-full rounded-full ${isCompleted ? 'bg-green-500' : 'bg-primary-500'}`}
                          style={{ width: `${Math.min(100, Math.round(progress * 100))}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-dark-500 mt-0.5">
                        {isCompleted ? (
                          <span className="text-green-400 flex items-center gap-1">
                            <CheckCircle2 size={10} /> Completado
                          </span>
                        ) : (
                          `${Math.round(progress * 100)}% · ${formatDuration(item.currentTime)}`
                        )}
                      </p>
                    </div>
                  )}
                </button>

                {/* Play button */}
                <button
                  onClick={() => navigate(`/details/${item.type}/${item.id}`, { state: { autoplay: true } })}
                  tabIndex={0}
                  data-tv-card
                  className="p-2.5 rounded-lg text-primary-400 hover:bg-primary-900/30 transition-colors flex-shrink-0"
                  title="Reproducir"
                >
                  <Play size={20} />
                </button>

                {/* Delete button */}
                <button
                  onClick={() => removeFromHistory(item.id, item.type)}
                  tabIndex={0}
                  data-tv-card
                  className="p-2.5 rounded-lg text-dark-500 hover:text-red-400 hover:bg-dark-600 transition-colors flex-shrink-0"
                  title="Borrar del historial"
                >
                  <X size={18} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
