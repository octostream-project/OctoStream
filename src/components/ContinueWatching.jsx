import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { Play, Clock, CheckCircle2 } from 'lucide-react'
import { useTranslation } from '../i18n/index.js'
import { formatDuration } from '../utils/format.js'
import { prefetchYouTubeStream } from '../utils/youtube.js'

export default function ContinueWatching() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const watchHistory = useStore(s => s.watchHistory)
  const watchedEpisodes = useStore(s => s.watchedEpisodes)
  // Prefetch YouTube con debounce: moverse rápido por la fila no debe lanzar
  // un resolve de NewPipe por cada tarjeta tocada.
  const prefetchTimer = useRef(null)
  const prefetchYt = (id) => {
    if (prefetchTimer.current) clearTimeout(prefetchTimer.current)
    prefetchTimer.current = setTimeout(() => prefetchYouTubeStream(id), 400)
  }

  // Check if a series is fully watched (all seasons/episodes)
  const isSeriesComplete = (item) => {
    if (!item.seasonsList || item.seasonsList.length === 0) return false
    for (const season of item.seasonsList) {
      for (let ep = 1; ep <= (season.episodeCount || 0); ep++) {
        const key = `${item.id}:S${season.seasonNumber}:E${ep}`
        if (!watchedEpisodes[key] || watchedEpisodes[key].progress < 0.97) return false
      }
    }
    return true
  }

  // Show recently watched items ordered by watched date:
  // newest on the left, oldest on the right.
  // Los directos de deportes (FCTV) no se muestran: no son reanudables.
  const recent = [...watchHistory]
    .filter(item => item.server !== 'FCTV')
    .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0))
    .slice(0, 12)

  if (recent.length === 0) return null

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        <Clock className="text-primary-400" size={20} />
        <h2 className="text-xl font-bold text-white">{t('home.continue')}</h2>
      </div>
      <div
        data-tv-row
        className="flex gap-4 overflow-x-auto scrollbar-hide pb-2"
        style={{ scrollbarWidth: 'none' }}
      >
        {recent.map(item => {
          const isLive = item.type === 'live' || item.type === 'channel'
          const isSeries = item.type === 'series'
          // For movies: completed when progress >= 95%
          // For series: completed only when ALL episodes across ALL seasons are watched
          const isDone = isSeries ? isSeriesComplete(item) : (item.progress && item.progress >= 0.95)
          const hasProgress = item.progress && item.progress > 0.05
          return (
            <div
              key={`${item.type}-${item.id}`}
              onClick={() => {
                if (item.type === 'youtube') {
                  navigate('/youtube', { state: { video: { url: item.id.slice(3), name: item.name, thumbnailUrl: item.poster, currentTime: item.currentTime || 0 } } })
                } else {
                  navigate(`/details/${item.type}/${item.id}`, { state: { autoplay: true } })
                }
              }}
              className="card group cursor-pointer flex-shrink-0 w-28 sm:w-32"
              tabIndex={0}
              data-tv-card
              role="button"
              // YouTube: pre-resolver el stream al enfocar la tarjeta para que
              // reanudar desde aquí no espere el resolve de NewPipe.
              onFocus={() => { if (item.type === 'youtube') prefetchYt(item.id.slice(3)) }}
              onMouseEnter={() => { if (item.type === 'youtube') prefetchYt(item.id.slice(3)) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (item.type === 'youtube') {
                    navigate('/youtube', { state: { video: { url: item.id.slice(3), name: item.name, thumbnailUrl: item.poster, currentTime: item.currentTime || 0 } } })
                  } else {
                    navigate(`/details/${item.type}/${item.id}`, { state: { autoplay: true } })
                  }
                }
              }}
            >
              <div className="relative aspect-[2/3] bg-dark-700 overflow-hidden">
                {item.poster || item.logo ? (
                  <img
                    src={item.poster || item.logo}
                    alt={item.name}
                    loading="lazy"
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Play size={32} className="text-dark-500" />
                  </div>
                )}
                {/* Tick badge for completed items */}
                {isDone && (
                  <div className="absolute top-2 right-2 bg-green-600 rounded-full p-1 shadow-lg">
                    <CheckCircle2 size={16} className="text-white" />
                  </div>
                )}
                {/* Live badge for TV channels */}
                {isLive && !hasProgress && (
                  <div className="absolute top-2 left-2 bg-red-600 rounded px-1.5 py-0.5 text-[10px] text-white font-bold">
                    LIVE
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                <div className="absolute bottom-2 left-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  <div className="flex items-center justify-center bg-primary-600/90 backdrop-blur-sm rounded-lg py-2 text-sm font-medium shadow-lg">
                    <Play size={16} className="mr-1" /> {isDone ? 'Ver de nuevo' : isLive && !hasProgress ? 'Ver' : 'Continuar'}
                  </div>
                </div>
              </div>
              <div className="p-2">
                <h3 className="text-xs font-semibold text-white truncate">{item.name}</h3>
                {hasProgress ? (
                  <div className="mt-1">
                    <div className="h-1 bg-dark-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isDone ? 'bg-green-500' : 'bg-primary-500'}`}
                        style={{ width: `${Math.min(100, Math.round((item.progress || 0) * 100))}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-dark-400 mt-0.5">
                      {isDone ? (
                        <span className="text-green-400 flex items-center gap-1">
                          <CheckCircle2 size={10} /> Completado
                        </span>
                      ) : (
                        `${Math.round((item.progress || 0) * 100)}% · ${formatDuration(item.currentTime)}`
                      )}
                    </p>
                  </div>
                ) : (
                  <p className="text-[10px] text-dark-500 mt-0.5">
                    {isLive ? 'TV en directo' : 'Visto recientemente'}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
