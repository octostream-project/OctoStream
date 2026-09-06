import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { Play, Clock } from 'lucide-react'
import { useTranslation } from '../i18n/index.js'

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return ''
  const mins = Math.floor(seconds / 60)
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  if (hours > 0) return `${hours}h ${remainingMins}m`
  return `${mins}m`
}

export default function ContinueWatching() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const watchHistory = useStore(s => s.watchHistory)

  const inProgress = watchHistory.filter(h => h.progress && h.progress > 0.05 && h.progress < 0.95)

  if (inProgress.length === 0) return null

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        <Clock className="text-primary-400" size={20} />
        <h2 className="text-xl font-bold text-white">{t('home.continue')}</h2>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {inProgress.slice(0, 6).map(item => (
          <div
            key={`${item.type}-${item.id}`}
            onClick={() => navigate(`/details/${item.type}/${item.id}`)}
            className="card group cursor-pointer"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                navigate(`/details/${item.type}/${item.id}`)
              }
            }}
          >
            <div className="relative aspect-[2/3] bg-dark-700 overflow-hidden">
              {item.poster ? (
                <img
                  src={item.poster}
                  alt={item.name}
                  loading="lazy"
                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Play size={32} className="text-dark-500" />
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              <div className="absolute bottom-2 left-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <div className="flex items-center justify-center bg-primary-600/90 backdrop-blur-sm rounded-lg py-2 text-sm font-medium shadow-lg">
                  <Play size={16} className="mr-1" /> Continuar
                </div>
              </div>
            </div>
            <div className="p-3">
              <h3 className="text-sm font-semibold text-white truncate">{item.name}</h3>
              <div className="mt-2">
                <div className="h-1 bg-dark-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary-500 rounded-full"
                    style={{ width: `${Math.round((item.progress || 0) * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-dark-400 mt-1">
                  {Math.round((item.progress || 0) * 100)}% · {formatDuration(item.currentTime)} / {formatDuration(item.duration)}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
