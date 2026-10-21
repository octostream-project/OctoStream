import { useMemo, useState } from 'react'
import { useStore } from '../store/useStore.js'
import ContentCard from '../components/ContentCard.jsx'
import DownloadsList from '../components/DownloadsList.jsx'
import { isAndroidNative, isElectron } from '../utils/platform.js'
import { Bookmark, CheckCircle2, Clock, Heart, Download } from 'lucide-react'

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
  const watchlist = useStore(s => s.watchlist)
  const history = useStore(s => s.watchHistory)
  const watchedEpisodes = useStore(s => s.watchedEpisodes)
  const [category, setCategory] = useState('pending')

  const { pending, completed } = useMemo(() => {
    const keyOf = item => `${item.type}:${item.id}`
    const completedItems = history.filter(item => isListable(item) && isComplete(item, watchedEpisodes))
    const completedKeys = new Set(completedItems.map(keyOf))
    // Pendientes = watchlist explícita + reproducciones a medias, dedup por
    // clave y fuera lo ya finalizado. Favoritos ya no entran aquí — tienen
    // su propia pestaña.
    const pendingByKey = new Map()
    for (const item of [...watchlist, ...history]) {
      if (isListable(item) && !isComplete(item, watchedEpisodes) && !completedKeys.has(keyOf(item))) {
        pendingByKey.set(keyOf(item), item)
      }
    }
    return {
      pending: [...pendingByKey.values()],
      completed: completedItems,
    }
  }, [watchlist, history, watchedEpisodes])

  const items = category === 'pending' ? pending : category === 'favorites' ? favorites : completed
  const empty = category === 'pending'
    ? 'No tienes nada pendiente. Marca títulos con el icono de marcador en su ficha o empieza a ver algo.'
    : category === 'favorites'
      ? 'No tienes favoritos. Pulsa el corazón en la ficha de una película o serie.'
      : 'Los títulos aparecerán aquí cuando termines de verlos.'

  const canDownload = isAndroidNative() || isElectron()
  const tabs = [
    { key: 'pending', label: 'Pendientes', icon: Clock, count: pending.length, active: 'border-primary-500 bg-primary-600/20' },
    { key: 'favorites', label: 'Favoritos', icon: Heart, count: favorites.length, active: 'border-red-500 bg-red-600/15' },
    { key: 'completed', label: 'Finalizadas', icon: CheckCircle2, count: completed.length, active: 'border-green-500 bg-green-600/15' },
    ...(canDownload ? [{ key: 'downloads', label: 'Descargas', icon: Download, count: null, active: 'border-sky-500 bg-sky-600/15' }] : []),
  ]

  return (
    <div className="p-4 lg:p-6">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-400">Tu biblioteca</p>
        <h1 className="mt-1 text-3xl font-bold text-white">Mi lista</h1>
        <p className="mt-2 text-sm text-dark-400">Pendientes recoge lo marcado con el marcador y lo que estás viendo; Finalizadas solo incluye contenido terminado.</p>
      </header>

      <div className="mb-6 flex flex-wrap gap-2" role="tablist" aria-label="Categorías de Mi lista">
        {tabs.map(({ key, label, icon: Icon, count, active }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={category === key}
            onClick={() => setCategory(key)}
            className={`flex items-center gap-2 rounded-xl border px-4 py-3 font-medium transition-colors ${category === key ? `${active} text-white` : 'border-dark-700 bg-dark-800 text-dark-300 hover:text-white'}`}
          >
            <Icon size={18} /> {label} {count != null && <span className="rounded-full bg-black/20 px-2 py-0.5 text-xs">{count}</span>}
          </button>
        ))}
      </div>

      {category === 'downloads' ? (
        <div className="rounded-2xl border border-dark-800 bg-dark-900/50 p-5">
          <DownloadsList />
        </div>
      ) : items.length === 0 ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 rounded-2xl border border-dark-800 bg-dark-900/50 px-6 text-center">
          {category === 'completed' ? <CheckCircle2 className="text-dark-600" size={56} /> : <Bookmark className="text-dark-600" size={56} />}
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
