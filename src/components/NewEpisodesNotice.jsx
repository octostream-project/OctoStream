import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, X } from 'lucide-react'
import { useStore } from '../store/useStore.js'
import { checkNewEpisodes, markEpisodesSeen } from '../utils/newEpisodes.js'

// Aviso "hay episodios nuevos" de las series de Mi Lista/favoritos.
// Consulta TMDB una vez cada 6h (throttle interno) sobre un máximo de 8
// series; se descarta con la X o al abrir una de las series avisadas.
export default function NewEpisodesNotice() {
  const navigate = useNavigate()
  const favorites = useStore(s => s.favorites)
  const watchlist = useStore(s => s.watchlist)
  const [items, setItems] = useState([])

  useEffect(() => {
    let active = true
    const ctrl = new AbortController()
    const map = new Map()
    for (const it of [...favorites, ...watchlist]) {
      if (it?.type === 'series' && /^tmdb-series-\d+$/.test(it.id || '') && !map.has(it.id)) {
        map.set(it.id, it)
      }
    }
    if (!map.size) return undefined
    checkNewEpisodes([...map.values()], {
      watchedEpisodes: useStore.getState().watchedEpisodes,
      signal: ctrl.signal,
    }).then(list => { if (active && list.length) setItems(list) })
      .catch(() => {})
    return () => { active = false; ctrl.abort() }
    // Solo depende de las listas — el progreso se lee fresco en el efecto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favorites, watchlist])

  if (!items.length) return null

  const dismiss = () => {
    markEpisodesSeen(items)
    setItems([])
  }

  return (
    <section className="mb-8" aria-label="Nuevos episodios">
      <div className="flex items-center gap-2 mb-4">
        <Bell className="text-primary-400" size={20} />
        <h2 className="text-xl font-bold text-white">Nuevos episodios</h2>
        <button
          type="button"
          onClick={dismiss}
          data-tv-card
          aria-label="Descartar avisos"
          className="ml-auto rounded-lg p-1.5 text-dark-400 hover:text-white hover:bg-dark-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
        >
          <X size={16} />
        </button>
      </div>
      <div data-tv-row className="flex gap-4 overflow-x-auto scrollbar-hide pb-2" style={{ scrollbarWidth: 'none' }}>
        {items.map(item => (
          <button
            key={item.id}
            type="button"
            data-tv-card
            onClick={() => {
              markEpisodesSeen([item])
              navigate(`/details/series/${item.id}`)
            }}
            className="card group flex-shrink-0 w-36 sm:w-40 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
          >
            <div className="relative aspect-[2/3] bg-dark-700 overflow-hidden">
              {item.poster ? (
                <img src={item.poster} alt={item.name} loading="lazy"
                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-dark-500 text-2xl font-bold">
                  {item.name?.[0] || '?'}
                </div>
              )}
              <span className="absolute top-2 left-2 rounded bg-primary-600 px-1.5 py-0.5 text-[11px] font-bold text-white shadow-lg">
                T{item.season} E{item.episode}
              </span>
            </div>
            <div className="p-2">
              <h3 className="text-xs font-semibold text-white truncate">{item.name}</h3>
              <p className="text-[11px] text-dark-400 mt-0.5 truncate">
                {item.epName ? `${item.epName} · ` : ''}{item.airDate}
              </p>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}
