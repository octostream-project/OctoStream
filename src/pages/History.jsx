import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { Clock, Play, Trash2, X } from 'lucide-react'
import { useState } from 'react'

export default function History() {
  const watchHistory = useStore(s => s.watchHistory)
  const removeFromHistory = useStore(s => s.removeFromHistory)
  const clearHistory = useStore(s => s.clearHistory)
  const navigate = useNavigate()
  const [confirmClear, setConfirmClear] = useState(false)

  return (
    <div className="p-4 lg:p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Historial</h1>
        {watchHistory.length > 0 && (
          confirmClear ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-dark-300">¿Borrar todo?</span>
              <button
                onClick={() => { clearHistory(); setConfirmClear(false) }}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700"
              >
                Sí, borrar
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-dark-700 text-dark-300 hover:bg-dark-600"
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-dark-800 text-dark-300 hover:bg-dark-700 hover:text-white"
            >
              <Trash2 size={16} />
              Borrar todo
            </button>
          )
        )}
      </div>

      {watchHistory.length === 0 ? (
        <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
          <Clock className="text-dark-600" size={64} />
          <p className="text-dark-400 text-lg">No has reproducido nada todavía</p>
        </div>
      ) : (
        <div className="space-y-2">
          {watchHistory.map(item => (
            <div
              key={`${item.type}-${item.id}`}
              className="flex items-center gap-4 bg-dark-800 rounded-lg p-3 hover:bg-dark-700 transition-colors cursor-pointer group"
              onClick={() => navigate(`/details/${item.type}/${item.id}`)}
            >
              {item.poster ? (
                <img src={item.poster} alt={item.name} className="w-12 h-16 object-cover rounded" />
              ) : (
                <div className="w-12 h-16 bg-dark-700 rounded flex items-center justify-center">
                  <Play size={16} className="text-dark-500" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-white font-medium truncate">{item.name}</p>
                <p className="text-xs text-dark-400">
                  {item.watchedAt ? new Date(item.watchedAt).toLocaleDateString('es-ES', {
                    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
                  }) : ''}
                </p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); removeFromHistory(item.id, item.type) }}
                className="p-2 rounded-lg text-dark-500 hover:text-red-400 hover:bg-dark-600 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Borrar del historial"
              >
                <X size={18} />
              </button>
              <Play size={20} className="text-dark-400" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
