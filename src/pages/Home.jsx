import { useEffect, useState, useRef } from 'react'
import { pluginManager } from '../plugins/manager.js'
import ContentRow from '../components/ContentRow.jsx'
import ContentCard from '../components/ContentCard.jsx'
import ContinueWatching from '../components/ContinueWatching.jsx'
import { Clapperboard, Film, Tv, PlayCircle, Globe } from 'lucide-react'
import Chip from '../components/ui/Chip.jsx'
import MediaGrid from '../components/ui/MediaGrid.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { SkeletonGrid, SkeletonRow } from '../components/ui/SkeletonCard.jsx'
import { waitForWarp } from '../utils/warpStatus.js'

// Only TMDB catalogs are shown on the Home page.
// Plurtasko channels are accessible from the Search and Details pages.
const MOVIE_CATS = [
  { id: 'movie-popular', name: 'Populares' },
  { id: 'movie-top-rated', name: 'Mejor Valoradas' },
  { id: 'movie-action', name: 'Acción' },
  { id: 'movie-comedy', name: 'Comedia' },
  { id: 'movie-horror', name: 'Terror' },
  { id: 'movie-scifi', name: 'Ciencia Ficción' },
  { id: 'movie-drama', name: 'Drama' },
  { id: 'movie-animation', name: 'Animación' },
  { id: 'movie-thriller', name: 'Suspense' },
  { id: 'movie-romance', name: 'Romance' },
  { id: 'movie-crime', name: 'Crimen' },
  { id: 'movie-fantasy', name: 'Fantasía' },
  { id: 'movie-2025', name: 'Estrenos 2025' },
  { id: 'movie-2024', name: 'Estrenos 2024' },
]

const SERIES_CATS = [
  { id: 'tv-popular', name: 'Populares' },
  { id: 'tv-top-rated', name: 'Mejores Series' },
  { id: 'tv-on-air', name: 'En Emisión' },
  { id: 'tv-airing-today', name: 'Emisión Hoy' },
  { id: 'tv-action', name: 'Acción' },
  { id: 'tv-comedy', name: 'Comedia' },
  { id: 'tv-drama', name: 'Drama' },
  { id: 'tv-animation', name: 'Anime/Animación' },
  { id: 'tv-crime', name: 'Crimen' },
  { id: 'tv-documentary', name: 'Documentales' },
  { id: 'tv-reality', name: 'Reality Shows' },
  { id: 'tv-scifi', name: 'Ciencia Ficción' },
  { id: 'tv-family', name: 'Familia' },
  { id: 'tv-mystery', name: 'Misterio' },
  { id: 'tv-2025', name: 'Series 2025' },
  { id: 'tv-2024', name: 'Series 2024' },
]

const ANIME_CATS = [
  { id: 'anime-popular', name: 'Anime Popular' },
  { id: 'anime-trending', name: 'Tendencias' },
  { id: 'anime-top-rated', name: 'Mejor Valorado' },
  { id: 'anime-seasonal', name: 'Esta Temporada' },
  { id: 'anime-favorites', name: 'Favoritos' },
  { id: 'anime-newest', name: 'Más Recientes' },
  { id: 'anime-action', name: 'Acción' },
  { id: 'anime-comedy', name: 'Comedia' },
  { id: 'anime-drama', name: 'Drama' },
  { id: 'anime-fantasy', name: 'Fantasía' },
  { id: 'anime-romance', name: 'Romance' },
  { id: 'anime-scifi', name: 'Ciencia Ficción' },
  { id: 'anime-horror', name: 'Terror' },
  { id: 'anime-slice-of-life', name: 'Recuentos de la vida' },
  { id: 'anime-mystery', name: 'Misterio' },
  { id: 'anime-thriller', name: 'Suspense' },
  { id: 'anime-supernatural', name: 'Sobrenatural' },
  { id: 'anime-psychological', name: 'Psicológico' },
  { id: 'anime-movie', name: 'Películas Anime' },
  { id: 'anime-tv', name: 'Series Anime' },
  { id: 'anime-ona', name: 'ONA (Net/Web)' },
]

const DORAMA_CATS = [
  { id: 'tv-dorama-kr', name: 'Doramas Coreanos' },
  { id: 'tv-dorama-jp', name: 'Doramas Japoneses' },
  { id: 'tv-dorama-cn', name: 'Doramas Chinos' },
]

// Map tab → TMDB type used in getCatalogContent
const TAB_TYPE = {
  movie: 'movie',
  series: 'series',
  anime: 'anime',
  dorama: 'series',
}

// Map tab → plugin id (AniList for anime, TMDB for the rest)
const TAB_PLUGIN = {
  movie: 'tmdb',
  series: 'tmdb',
  anime: 'anilist',
  dorama: 'tmdb',
}

// Map tab → category list
const TAB_CATS = {
  movie: MOVIE_CATS,
  series: SERIES_CATS,
  anime: ANIME_CATS,
  dorama: DORAMA_CATS,
}

export default function Home() {
  const [rows, setRows] = useState([])
  const [gridItems, setGridItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('movie') // 'movie' | 'series' | 'anime' | 'dorama'
  const [selectedCat, setSelectedCat] = useState(null) // null = all categories (rows), else grid
  const reqIdRef = useRef(0)

  useEffect(() => {
    const myReqId = ++reqIdRef.current
    const loadContent = async () => {
      setLoading(true)
      setRows([])
      setGridItems([])

      // Wait for WARP to be ready before loading any catalog.
      // This prevents IP leaks: if WARP auto-connect is on, requests
      // would go direct (real IP) during the ~2s Aether startup window.
      // If WARP is off/disabled, waitForWarp resolves immediately.
      await waitForWarp()

      const cats = TAB_CATS[tab] || MOVIE_CATS
      const type = TAB_TYPE[tab] || 'movie'
      const pluginId = TAB_PLUGIN[tab] || 'tmdb'

      // If a specific category is selected, load it as a full-screen grid
      if (selectedCat) {
        try {
          const items = await pluginManager.getCatalogContent(pluginId, selectedCat, type, 0, 60)
          // Ignore if a newer request was started
          if (myReqId !== reqIdRef.current) return
          setGridItems(items || [])
        } catch (e) { /* skip */ }
        if (myReqId === reqIdRef.current) setLoading(false)
        return
      }

      // "Todas": load only the first four rows; the category selector loads
      // any other catalog explicitly, avoiding off-screen background traffic.
      const INITIAL_COUNT = 4
      const initial = cats.slice(0, INITIAL_COUNT)

      const loadOne = async (cat) => {
        try {
          const items = await pluginManager.getCatalogContent(pluginId, cat.id, type, 0, 20)
          if (myReqId !== reqIdRef.current) return
          if (items && items.length > 0) {
            setRows(prev => [...prev, { title: cat.name, items, key: cat.id }])
          }
        } catch (e) { /* skip */ }
      }

      // Load first 4 in parallel and show immediately
      await Promise.allSettled(initial.map(loadOne))
      if (myReqId === reqIdRef.current) setLoading(false)

    }
    loadContent()
  }, [tab, selectedCat])

  const cats = TAB_CATS[tab] || MOVIE_CATS

  return (
    <div className="p-4 lg:p-6">
      <h1 className="text-2xl font-bold text-white mb-4">Inicio</h1>

      <ContinueWatching />

      {/* Tab selector: Películas / Series / Anime / Dorama */}
      <div className="flex gap-2 mb-4 mt-6 flex-wrap" data-tv-row>
        <Chip active={tab === 'movie'} icon={Film} onClick={() => { setTab('movie'); setSelectedCat(null) }}>Películas</Chip>
        <Chip active={tab === 'series'} icon={Tv} onClick={() => { setTab('series'); setSelectedCat(null) }}>Series</Chip>
        <Chip active={tab === 'anime'} icon={PlayCircle} onClick={() => { setTab('anime'); setSelectedCat(null) }}>Anime</Chip>
        <Chip active={tab === 'dorama'} icon={Globe} onClick={() => { setTab('dorama'); setSelectedCat(null) }}>Dorama</Chip>
      </div>

      {/* Category selector */}
      <div className="flex flex-wrap gap-2 mb-6" data-tv-row>
        <Chip size="sm" active={selectedCat === null} onClick={() => setSelectedCat(null)}>Todas</Chip>
        {cats.map(cat => (
          <Chip key={cat.id} size="sm" active={selectedCat === cat.id} onClick={() => setSelectedCat(cat.id)}>
            {cat.name}
          </Chip>
        ))}
      </div>

      {loading ? (
        selectedCat
          ? <SkeletonGrid />
          : <div className="space-y-8"><SkeletonRow /><SkeletonRow /><SkeletonRow /></div>
      ) : selectedCat ? (
        // Single category: full-screen grid
        gridItems.length === 0 ? (
          <EmptyState icon={Clapperboard}>No hay contenido disponible</EmptyState>
        ) : (
          <MediaGrid>
            {gridItems.map(item => (
              <ContentCard key={`${item.type}-${item.id}`} item={item} />
            ))}
          </MediaGrid>
        )
      ) : (
        // "Todas": horizontal rows
        rows.length === 0 ? (
          <EmptyState icon={Clapperboard}>No hay contenido disponible</EmptyState>
        ) : (
          rows.map((row) => (
            <ContentRow key={row.key} title={row.title} items={row.items} />
          ))
        )
      )}
    </div>
  )
}
