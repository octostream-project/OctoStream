import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { Clock, Play } from 'lucide-react'

export default function History() {
  const watchHistory = useStore(s => s.watchHistory)
  const navigate = useNavigate()

  return (
    <div className="p-4 lg:p-6">
      <h1 className="text-2xl font-bold text-white mb-6">Historial</h1>

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
              className="flex items-center gap-4 bg-dark-800 rounded-lg p-3 hover:bg-dark-700 transition-colors cursor-pointer"
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
              <Play size={20} className="text-dark-400" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
