import { useMemo, useState } from 'react'
import { useStore } from '../store/useStore.js'
import ContentCard from '../components/ContentCard.jsx'
import { Bookmark, CheckCircle2, Clock } from 'lucide-react'

// Mi lista solo recoge contenido con principio y fin — la TV en directo y
// canales no se pueden "terminar" y ensucian Pendientes sin sentido.
const LIST_TYPES = new Set(['movie', 'series', 'anime', 'dorama'])
const isListable = (item) => LIST_TYPES.has(item?.type)

function isComplete(item, watchedEpisodes) {
  if (item?.type === 'series') {
    const seasons = Array.isArray(item.seasonsList) ? item.seasonsList : []
    if (!seasons.length) return false
    return seasons.every(season => {
      const count = Number(season.episodeCount) || 0
      if (!count) return false
      for (let ep = 1; ep <= count; ep++) {
        const state = watchedEpisodes[`${item.id}:S${season.seasonNumber}:E${ep}`]
        if (!state || state.progress < 0.97) return false
      }
      return true
    })
  }
  return Number(item?.progress) >= 0.95
}

export default function Favorites() {
  const favorites = useStore(s => s.favorites)
  const history = useStore(s => s.watchHistory)
  const watchedEpisodes = useStore(s => s.watchedEpisodes)
  const [category, setCategory] = useState('pending')

  const { pending, completed } = useMemo(() => {
    const keyOf = item => `${item.type}:${item.id}`
    const completedItems = history.filter(item => isListable(item) && isComplete(item, watchedEpisodes))
    const completedKeys = new Set(completedItems.map(keyOf))
    const pendingByKey = new Map()
    for (const item of [...history, ...favorites]) {
      if (isListable(item) && !isComplete(item, watchedEpisodes) && !completedKeys.has(keyOf(item))) {
        pendingByKey.set(keyOf(item), item)
      }
    }
    return {
      pending: [...pendingByKey.values()],
      completed: completedItems,
    }
  }, [favorites, history, watchedEpisodes])

  const items = category === 'pending' ? pending : completed
  const empty = category === 'pending'
    ? 'No tienes contenido pendiente. Añade títulos a Favoritos o empieza a ver algo.'
    : 'Los títulos aparecerán aquí cuando termines de verlos.'

  return (
    <div className="p-4 lg:p-6">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-400">Tu biblioteca</p>
        <h1 className="mt-1 text-3xl font-bold text-white">Mi lista</h1>
        <p className="mt-2 text-sm text-dark-400">Pendientes reúne favoritos y reproducciones incompletas; Vistos solo incluye contenido terminado.</p>
      </header>

      <div className="mb-6 flex flex-wrap gap-2" role="tablist" aria-label="Categorías de Mi lista">
        <button
          type="button"
          role="tab"
          aria-selected={category === 'pending'}
          onClick={() => setCategory('pending')}
          className={`flex items-center gap-2 rounded-xl border px-4 py-3 font-medium transition-colors ${category === 'pending' ? 'border-primary-500 bg-primary-600/20 text-white' : 'border-dark-700 bg-dark-800 text-dark-300 hover:text-white'}`}
        >
          <Clock size={18} /> Pendientes <span className="rounded-full bg-black/20 px-2 py-0.5 text-xs">{pending.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={category === 'completed'}
          onClick={() => setCategory('completed')}
          className={`flex items-center gap-2 rounded-xl border px-4 py-3 font-medium transition-colors ${category === 'completed' ? 'border-green-500 bg-green-600/15 text-white' : 'border-dark-700 bg-dark-800 text-dark-300 hover:text-white'}`}
        >
          <CheckCircle2 size={18} /> Vistos <span className="rounded-full bg-black/20 px-2 py-0.5 text-xs">{completed.length}</span>
        </button>
      </div>

      {items.length === 0 ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 rounded-2xl border border-dark-800 bg-dark-900/50 px-6 text-center">
          {category === 'pending' ? <Bookmark className="text-dark-600" size={56} /> : <CheckCircle2 className="text-dark-600" size={56} />}
          <p className="max-w-lg text-dark-300">{empty}</p>
        </div>
      ) : (
        <div data-tv-grid className="media-card-grid grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map(item => <ContentCard key={`${item.type}-${item.id}`} item={item} />)}
        </div>
      )}
    </div>
  )
}
