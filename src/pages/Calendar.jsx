import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Calendar as CalendarIcon, Tv, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react'
import { useStore } from '../store/useStore.js'
import { getSeriesUpcoming } from '../plugins/builtIn/tmdb.js'
import OctoLoader from '../components/OctoLoader.jsx'

function formatDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
  } catch {
    return iso
  }
}

function daysUntil(iso) {
  if (!iso) return null
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const d = new Date(iso)
  d.setHours(0, 0, 0, 0)
  return Math.round((d - now) / 86400000)
}

export default function Calendar() {
  const navigate = useNavigate()
  const favorites = useStore(s => s.favorites)
  const watchHistory = useStore(s => s.watchHistory)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all') // 'all' | 'favorites' | 'started'

  // Combine favorites and watch history, deduplicated, series only
  const seriesList = useMemo(() => {
    const seen = new Set()
    const list = []
    const add = (item) => {
      if (!item || item.type !== 'series') return
      if (!item.id?.startsWith('tmdb-')) return
      const key = `${item.id}`
      if (seen.has(key)) return
      seen.add(key)
      list.push(item)
    }
    favorites.forEach(add)
    watchHistory.forEach(add)
    return list
  }, [favorites, watchHistory])

  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()
    setLoading(true)
    setItems([])
    ;(async () => {
      // Concurrencia limitada: un usuario con muchas series favoritas lanzaría
      // decenas de peticiones TMDB a la vez. En lotes de 8 evitamos la ráfaga
      // (y el posible rate-limit) sin alargar apenas la carga.
      const BATCH = 8
      const results = []
      for (let i = 0; i < seriesList.length; i += BATCH) {
        const batch = await Promise.all(
          seriesList.slice(i, i + BATCH).map(async (s) => {
            try {
              const data = await getSeriesUpcoming(s.id, ctrl.signal)
              if (!data) return null
              return {
                id: s.id,
                name: s.name,
                poster: s.poster,
                nextEpisode: data.nextEpisode,
                lastEpisode: data.lastEpisode,
              }
            } catch {
              return null
            }
          })
        )
        results.push(...batch)
      }
      if (cancelled) return
      const filtered = results.filter(Boolean)
      // Sort: upcoming first (by air date asc), then past (by air date desc)
      filtered.sort((a, b) => {
        const aNext = a.nextEpisode?.airDate
        const bNext = b.nextEpisode?.airDate
        if (aNext && bNext) return aNext.localeCompare(bNext)
        if (aNext) return -1
        if (bNext) return 1
        const aLast = a.lastEpisode?.airDate || ''
        const bLast = b.lastEpisode?.airDate || ''
        return bLast.localeCompare(aLast)
      })
      setItems(filtered)
      setLoading(false)
    })()
    return () => { cancelled = true; ctrl.abort() }
  }, [seriesList])

  const filteredItems = useMemo(() => {
    if (filter === 'favorites') {
      const favIds = new Set(favorites.filter(f => f.type === 'series').map(f => f.id))
      return items.filter(i => favIds.has(i.id))
    }
    if (filter === 'started') {
      const histIds = new Set(watchHistory.filter(h => h.type === 'series').map(h => h.id))
      return items.filter(i => histIds.has(i.id))
    }
    return items
  }, [items, filter, favorites, watchHistory])

  // Group: upcoming (future or today), recently aired (past)
  const { upcoming, recent } = useMemo(() => {
    const upcoming = []
    const recent = []
    for (const item of filteredItems) {
      const ep = item.nextEpisode
      if (ep?.airDate) {
        const d = daysUntil(ep.airDate)
        if (d !== null && d >= 0) {
          upcoming.push({ ...item, episode: ep, daysUntil: d, status: 'upcoming' })
        } else {
          recent.push({ ...item, episode: ep, daysUntil: d, status: 'recent' })
        }
      } else if (item.lastEpisode?.airDate) {
        recent.push({ ...item, episode: item.lastEpisode, daysUntil: daysUntil(item.lastEpisode.airDate), status: 'recent' })
      }
    }
    return { upcoming, recent }
  }, [filteredItems])

  return (
    <div className="p-4 lg:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <CalendarIcon size={28} className="text-primary-400" />
        <h1 className="text-2xl font-bold text-white">Calendario de series</h1>
      </div>

      {/* Filter tabs */}
      <div data-tv-row className="flex items-center gap-2">
        {[
          { id: 'all', label: 'Todas' },
          { id: 'favorites', label: 'Favoritas' },
          { id: 'started', label: 'Empezadas' },
        ].map(f => (
          <button
            key={f.id}
            data-tv-card
            tabIndex={0}
            onClick={() => setFilter(f.id)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click() } }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === f.id ? 'bg-primary-600 text-white' : 'bg-dark-800 text-dark-300 hover:text-white'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {seriesList.length === 0 ? (
        <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
          <Tv className="text-dark-600" size={64} />
          <p className="text-dark-400 text-lg">No tienes series en favoritos ni en historial</p>
          <p className="text-dark-500 text-sm">Marca series con el corazón o empieza a verlas para ver aquí los próximos estrenos</p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <OctoLoader size={48} />
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4">
          <AlertCircle className="text-dark-600" size={48} />
          <p className="text-dark-400">No hay episodios programados</p>
        </div>
      ) : (
        <>
          {/* Upcoming episodes */}
          {upcoming.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <ChevronRight size={20} className="text-primary-400" />
                Próximos episodios
              </h2>
              <div data-tv-grid className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {upcoming.map(item => (
                  <CalendarCard key={item.id} item={item} navigate={navigate} />
                ))}
              </div>
            </div>
          )}

          {/* Recently aired */}
          {recent.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <ChevronLeft size={20} className="text-dark-400" />
                Emitados recientemente
              </h2>
              <div data-tv-grid className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {recent.map(item => (
                  <CalendarCard key={item.id} item={item} navigate={navigate} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function CalendarCard({ item, navigate }) {
  const ep = item.episode
  if (!ep) return null
  const days = item.daysUntil
  let badge = ''
  let badgeClass = ''
  if (days === 0) { badge = 'Hoy'; badgeClass = 'bg-red-500 text-white' }
  else if (days === 1) { badge = 'Mañana'; badgeClass = 'bg-orange-500 text-white' }
  else if (days > 0 && days <= 7) { badge = `En ${days} días`; badgeClass = 'bg-primary-600 text-white' }
  else if (days > 7) { badge = `En ${Math.ceil(days / 7)} sem`; badgeClass = 'bg-dark-600 text-dark-200' }
  else if (days < 0 && days >= -7) { badge = `Hace ${Math.abs(days)} días`; badgeClass = 'bg-dark-700 text-dark-300' }
  else { badge = formatDate(ep.airDate); badgeClass = 'bg-dark-700 text-dark-400' }

  return (
    <div
      data-tv-card
      tabIndex={0}
      role="button"
      onClick={() => navigate(`/details/series/${item.id}`)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click() } }}
      className="card group p-3 flex gap-3 cursor-pointer"
    >
      <div className="flex-shrink-0 w-16 h-24 rounded-lg overflow-hidden bg-dark-700">
        {item.poster ? (
          <img src={item.poster} alt={item.name} loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Tv size={20} className="text-dark-500" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-white truncate">{item.name}</h3>
          <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${badgeClass}`}>{badge}</span>
        </div>
        <p className="text-xs text-primary-300 font-medium">
          T{ep.season} · E{ep.episode}
        </p>
        {ep.name && <p className="text-xs text-dark-300 truncate">{ep.name}</p>}
        <p className="text-xs text-dark-500 mt-auto">{formatDate(ep.airDate)}</p>
      </div>
    </div>
  )
}
