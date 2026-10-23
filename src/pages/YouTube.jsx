import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { Search, Youtube, Clock, Eye, X, History, Filter, ArrowUpDown, Heart } from 'lucide-react'
import VideoPlayer from '../components/VideoPlayer.jsx'
import LazyImage from '../components/LazyImage.jsx'
import { searchYouTubeFull, resolveYouTubeStream, prefetchYouTubeStream, suggestYouTube, dedupeYouTubeItems, getChannelInfo } from '../utils/youtube.js'
import { isAndroidNative, isElectron } from '../utils/platform.js'
import { useStore } from '../store/useStore.js'
import OctoLoader from '../components/OctoLoader.jsx'
import LogoLoader from '../components/LogoLoader.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return 'LIVE'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatViews(views) {
  if (!views || views < 0) return ''
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M vistas`
  if (views >= 1_000) return `${(views / 1_000).toFixed(1)}K vistas`
  return `${views} vistas`
}

// Duration filters (YouTube-style)// Duration filters (YouTube-style)
const DURATION_FILTERS = [
  { id: 'all', label: 'Todos', test: () => true },
  { id: 'short', label: '< 4 min', test: (d) => d > 0 && d < 240 },
  { id: 'long', label: '> 20 min', test: (d) => d > 0 && d >= 1200 },
]

// Sort options
const SORT_OPTIONS = [
  { id: 'relevance', label: 'Relevancia', sort: (a, b) => 0 },
  { id: 'views', label: 'Más vistos', sort: (a, b) => (b.views || 0) - (a.views || 0) },
  { id: 'views_asc', label: 'Menos vistos', sort: (a, b) => (a.views || 0) - (b.views || 0) },
  { id: 'duration', label: 'Más largos', sort: (a, b) => (b.duration || 0) - (a.duration || 0) },
  { id: 'duration_asc', label: 'Más cortos', sort: (a, b) => (a.duration || 0) - (b.duration || 0) },
]

export default function YouTube() {
  const location = useLocation()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [nextPage, setNextPage] = useState(null)
  const [page, setPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [playing, setPlaying] = useState(null)
  const [resolving, setResolving] = useState(null)
  const [channel, setChannel] = useState(null) // vista de canal: {name, url, avatarUrl, bannerUrl}
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const suggestionsRef = useRef(null)
  const [durationFilter, setDurationFilter] = useState('all')
  const [sortBy, setSortBy] = useState('relevance')
  const [showFilters, setShowFilters] = useState(false)
  const suppressSuggestionsRef = useRef(false)
  const abortRef = useRef(null)
  const suggestTimerRef = useRef(null)

  const addToHistory = useStore(s => s.addToHistory)
  const watchHistory = useStore(s => s.watchHistory)
  const updateProgress = useStore(s => s.updateProgress)
  const favorites = useStore(s => s.favorites)
  const toggleFavorite = useStore(s => s.toggleFavorite)
  const youtubeSearchHistory = useStore(s => s.youtubeSearchHistory)
  const addYoutubeSearch = useStore(s => s.addYoutubeSearch)
  const removeYoutubeSearch = useStore(s => s.removeYoutubeSearch)
  const clearYoutubeSearchHistory = useStore(s => s.clearYoutubeSearchHistory)

  // Hidratación diferida de las historias de búsqueda (se cargan lazy, no en arranque)
  useEffect(() => {
    useStore.getState().ensureYoutubeHistory()
  }, [])

  // Index watch history by id so lookups inside render maps are O(1)
  const ytHistoryMap = useMemo(() => {
    const m = new Map()
    for (const h of watchHistory) {
      if (h.type === 'youtube') m.set(h.id, h)
    }
    return m
  }, [watchHistory])

  // Lookup O(1) de favoritos por "type:id" (vídeo yt:url, canal ytchannel:url)
  const favIds = useMemo(() => {
    const s = new Set()
    for (const f of favorites) s.add(`${f.type}:${f.id}`)
    return s
  }, [favorites])

  // Debounced suggestions
  useEffect(() => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    const q = query.trim()
    if (q.length < 2 || suppressSuggestionsRef.current) {
      setSuggestions([])
      setShowSuggestions(false)
      suppressSuggestionsRef.current = false
      return
    }
    suggestTimerRef.current = setTimeout(async () => {
      const sugg = await suggestYouTube(q)
      if (sugg && sugg.length > 0) {
        setSuggestions(sugg)
        setShowSuggestions(true)
      } else {
        setSuggestions([])
        setShowSuggestions(false)
      }
    }, 300)
    return () => { if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current) }
  }, [query])

  // Normaliza cualquier referencia de canal a una URL que getChannel acepte.
  const channelUrl = (ref) => {
    if (!ref || typeof ref !== 'string') return null
    if (ref.startsWith('http')) return ref
    if (ref.startsWith('@')) return `https://www.youtube.com/${ref}`
    if (ref.startsWith('UC')) return `https://www.youtube.com/channel/${ref}`
    return null
  }

  // Carga la vista de un canal (cabecera + vídeos de su pestaña principal).
  const loadChannel = useCallback(async (fav) => {
    const url = channelUrl(fav?.url)
    if (!url) {
      setQuery(fav?.name || '')
      return
    }
    if (abortRef.current) abortRef.current.aborted = true
    const abort = { aborted: false }
    abortRef.current = abort
    setLoading(true)
    setError(null)
    setResults([])
    setNextPage(null)
    setPage(1)
    setChannel(null)
    try {
      const info = await getChannelInfo(url)
      if (abort.aborted) return
      if (info) {
        setChannel({ name: info.name || fav?.name || '', url, avatarUrl: info.avatarUrl || '' })
        setResults(dedupeYouTubeItems(info.items || []))
        if (!info.items?.length) setError('El canal no tiene vídeos')
      } else {
        setError('No se pudo cargar el canal')
      }
    } finally {
      if (!abort.aborted) setLoading(false)
    }
  }, [])

  // Canal favorito abierto desde Favoritos (o desde una tarjeta de resultado).
  // Diferido un tick como el efecto de "Continuar viendo" — loadChannel hace
  // setState y no debe correr síncrono dentro del efecto.
  useEffect(() => {
    const favChannel = location.state?.channel
    if (!favChannel || favChannel.type !== 'youtube_channel') return
    const timer = setTimeout(() => {
      loadChannel(favChannel.url ? favChannel : { ...favChannel, url: favChannel.id?.startsWith('ytchannel:') ? favChannel.id.slice(10) : null })
      window.history.replaceState({}, document.title)
    }, 0)
    return () => clearTimeout(timer)
  }, [location.state, loadChannel])

  // Prefetch de la resolución al mantener el foco en una tarjeta (~400ms):
  // para cuando el usuario pulsa OK el stream ya está en caché y el vídeo
  // arranca sin esperar el resolve de NewPipe.
  const prefetchTimerRef = useRef(null)
  const handleCardFocus = useCallback((url) => {
    if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current)
    prefetchTimerRef.current = setTimeout(() => prefetchYouTubeStream(url), 400)
  }, [])

  // Ref to handlePlayVideo (defined later) for the "Continuar viendo" effect
  const handlePlayVideoRef = useRef(null)

  // Play video from "Continuar viendo" (location.state.video)
  useEffect(() => {
    const video = location.state?.video
    if (!video?.url) return

    // La navegación puede ocurrir antes de que la referencia al handler se
    // haya asignado durante el primer render. Diferirlo un tick evita que el
    // elemento de Continuar viendo se pierda silenciosamente.
    const timer = setTimeout(() => {
      const play = handlePlayVideoRef.current
      if (play) {
        play({
          ...video,
          url: String(video.url).trim(),
          name: video.name || 'YouTube',
        })
        window.history.replaceState({}, document.title)
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [location.state])

  const handleSearch = useCallback(async (e, searchQuery) => {
    e?.preventDefault()
    const q = (searchQuery || query).trim()
    if (!q) return
    setShowSuggestions(false)
    setSuggestions([])
    suppressSuggestionsRef.current = true
    setQuery(q)
    addYoutubeSearch(q)

    if (abortRef.current) abortRef.current.aborted = true
    const abort = { aborted: false }
    abortRef.current = abort

    setLoading(true)
    setError(null)
    setResults([])
    setNextPage(null)
    setPage(1)
    setChannel(null)

    try {
      const res = await searchYouTubeFull(q)
      if (abort.aborted) return
      if (res === null) {
        setError('YouTube search is only available on Android')
      } else if (res.error) {
        setError(`Error en la búsqueda: ${res.error}`)
      } else if (res.items.length === 0) {
        setError('No se encontraron resultados')
      } else {
        setResults(dedupeYouTubeItems(res.items))
        setNextPage(res.nextPage)
      }
    } catch (e) {
      if (!abort.aborted) setError(`Error: ${e?.message || 'desconocido'}`)
    } finally {
      if (!abort.aborted) setLoading(false)
    }
  }, [query, addYoutubeSearch])

  // Load the next page of results (appends to the current list)
  const handleLoadMore = useCallback(async () => {
    if (!nextPage || loadingMore || loading) return
    const q = query.trim()
    if (!q) return

    setLoadingMore(true)
    try {
      // YouTube a veces devuelve continuaciones vacías o solo con items
      // no-vídeo (shelves, canales) que el extractor filtra → items=0.
      // Se consumen hasta 4 continuaciones seguidas antes de rendirse;
      // sin el bucle un solo salto vacío dejaba el botón sin efecto.
      let np = nextPage
      for (let hop = 0; hop < 4 && np; hop++) {
        const res = await searchYouTubeFull(q, np)
        if (res === null || res.error) {
          // Fallo del plugin/extractor: conservar nextPage para poder reintentar.
          setError(`No se pudo cargar la página ${page + 1}${res?.error ? `: ${res.error}` : ''}`)
          return
        }
        if (res.items.length > 0) {
          setError(null)
          setResults(prev => dedupeYouTubeItems([...prev, ...res.items]))
          setNextPage(res.nextPage)
          setPage(p => p + 1)
          return
        }
        np = res.nextPage
      }
      // Continuaciones agotadas o todas vacías
      setNextPage(np)
      if (!np) setError(null)
    } finally {
      setLoadingMore(false)
    }
  }, [nextPage, loadingMore, loading, query, page])

  const handlePlayVideo = async (item) => {
    setResolving(item.url)
    try {
      const stream = await resolveYouTubeStream(item.url)
      if (stream) {
        const videoId = `yt:${item.url}`
        const historyItem = ytHistoryMap.get(videoId)
        const savedTime = Number(item.currentTime || historyItem?.currentTime || 0)
        const startTime = savedTime > 5 ? savedTime : 0
        console.log('[YouTube] Resume check:', videoId, 'currentTime:', historyItem?.currentTime, 'startTime:', startTime)

        addToHistory({
          id: videoId,
          type: 'youtube',
          name: item.name,
          poster: item.thumbnailUrl,
        })

        setPlaying({
          url: stream.url,
          streamType: stream.streamType || 'mp4',
          title: item.name,
          startTime,
          subtitles: stream.subtitles || [],
          direct: stream.direct === true,
          fastStart: true,
          // Si la URL firmada caduca (p.ej. servida desde la caché de
          // resoluciones), el player re-resuelve el watch URL una vez.
          _refreshUrl: async () => {
            const fresh = await resolveYouTubeStream(item.url, { force: true })
            return fresh?.url || null
          },
          meta: { id: videoId, type: 'youtube', name: item.name },
        })
      } else {
        setError('No se pudo resolver el vídeo de YouTube')
      }
    } catch (e) {
      setError(`Error al resolver: ${e?.message || 'desconocido'}`)
    } finally {
      setResolving(null)
    }
  }
  useEffect(() => {
    handlePlayVideoRef.current = handlePlayVideo
  })

  // Apply filters and sort to search results
  const filteredResults = useMemo(() => {
    if (!results.length) return []
    const filter = DURATION_FILTERS.find(f => f.id === durationFilter) || DURATION_FILTERS[0]
    const sortFn = SORT_OPTIONS.find(s => s.id === sortBy)?.sort || (() => 0)
    return results
      .filter(item => filter.test(item.duration))
      .sort(sortFn)
  }, [results, durationFilter, sortBy])

  // En desktop la superficie la da yt-dlp por IPC (electron/youtube.cjs) —
  // misma API que el plugin Android. Solo la web pura no tiene extractor.
  if (!isAndroidNative() && !isElectron()) {
    return (
      <EmptyState icon={Youtube} minH="min-h-[60vh]">
        <p className="text-xl font-bold text-white">YouTube</p>
        <p className="text-dark-400 text-sm max-w-md mt-1">
          La búsqueda y reproducción de YouTube está disponible en la app (Android y escritorio).
        </p>
      </EmptyState>
    )
  }

  return (
    <div className="p-4 pb-8">
      <div className="flex items-center gap-3 mb-6">
        <Youtube size={28} className="text-red-500" />
        <h1 className="text-2xl font-bold text-white">YouTube</h1>
      </div>

      <>
          {/* Search bar */}
          <form onSubmit={handleSearch} className="relative flex gap-2 mb-4">
            <div className="relative flex-1">
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onBlur={() => setTimeout(() => {
                  // No cerrar si el foco se movió a una sugerencia (D-pad down
                  // tras cerrar el teclado); si se cierra, el elemento focuseado
                  // desaparece y el foco se pierde.
                  if (!suggestionsRef.current?.contains(document.activeElement)) {
                    setShowSuggestions(false)
                  }
                }, 250)}
                onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                placeholder="Buscar vídeos en YouTube..."
                className="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-3 text-white placeholder-dark-500 focus:outline-none focus:border-primary-500"
                autoFocus
              />
              {showSuggestions && suggestions.length > 0 && (
                <div ref={suggestionsRef} data-tv-list className="absolute top-full left-0 right-0 mt-1 bg-dark-800 border border-dark-700 rounded-lg shadow-xl z-50 max-h-60 overflow-y-auto">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      type="button"
                      tabIndex={0}
                      data-tv-focus
                      data-tv-item
                      className="w-full text-left px-4 py-2.5 text-sm text-dark-200 hover:bg-dark-700 hover:text-white focus:bg-primary-900/30 focus:text-white transition-colors border-b border-dark-700/50 last:border-0 outline-none"
                      onClick={() => { setQuery(s); setShowSuggestions(false); handleSearch({ preventDefault: () => {} }, s) }}
                      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setQuery(s), setShowSuggestions(false), handleSearch({ preventDefault: () => {} }, s))}
                    >
                      <Search size={14} className="inline mr-2 text-dark-500" />
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="submit" disabled={loading || !query.trim()} className="btn-primary px-6 py-3 flex items-center gap-2">
              {loading ? <OctoLoader size={20} /> : <Search size={20} />}
              <span>Buscar</span>
            </button>
            {results.length > 0 && (
              <button
                type="button"
                data-tv-item
                tabIndex={0}
                onClick={() => setShowFilters(s => !s)}
                className={`px-4 py-3 rounded-lg flex items-center gap-2 transition-colors ${showFilters ? 'bg-primary-600 text-white' : 'bg-dark-800 text-dark-300 hover:bg-dark-700'}`}
                title="Filtros"
              >
                <Filter size={20} />
              </button>
            )}
          </form>

          {/* Filters bar */}
          {showFilters && results.length > 0 && (
            <div className="bg-dark-800 border border-dark-700 rounded-lg p-3 mb-4 space-y-3">
              {/* Duration filter */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-dark-400 font-medium flex items-center gap-1">
                  <Clock size={14} /> Duración:
                </span>
                {DURATION_FILTERS.map(f => (
                  <button
                    key={f.id}
                    data-tv-item
                    tabIndex={0}
                    onClick={() => setDurationFilter(f.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${durationFilter === f.id ? 'bg-primary-600 text-white' : 'bg-dark-700 text-dark-300 hover:bg-dark-600'}`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {/* Sort */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-dark-400 font-medium flex items-center gap-1">
                  <ArrowUpDown size={14} /> Ordenar:
                </span>
                {SORT_OPTIONS.map(s => (
                  <button
                    key={s.id}
                    data-tv-item
                    tabIndex={0}
                    onClick={() => setSortBy(s.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${sortBy === s.id ? 'bg-primary-600 text-white' : 'bg-dark-700 text-dark-300 hover:bg-dark-600'}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {/* Result count */}
              <div className="text-xs text-dark-500">
                {filteredResults.length} de {results.length} resultados
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 mb-6 text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* Channel header (vista de canal abierta desde uploader o favoritos) */}
          {channel && (
            <div className="flex items-center gap-3 mb-4 bg-dark-800 border border-dark-700 rounded-lg p-3">
              {channel.avatarUrl ? (
                <LazyImage src={channel.avatarUrl} alt={channel.name} className="w-12 h-12 rounded-full object-cover" />
              ) : (
                <div className="w-12 h-12 rounded-full bg-dark-700 flex items-center justify-center">
                  <Youtube size={22} className="text-dark-500" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-white font-medium truncate">{channel.name}</p>
                <p className="text-xs text-dark-500">Canal de YouTube</p>
              </div>
              {(() => {
                const favId = `ytchannel:${channel.url}`
                const fav = favIds.has(`youtube_channel:${favId}`)
                return (
                  <button
                    type="button"
                    data-tv-item
                    tabIndex={0}
                    title={fav ? 'Quitar canal de favoritos' : 'Añadir canal a favoritos'}
                    onClick={() => toggleFavorite({ id: favId, type: 'youtube_channel', name: channel.name, poster: channel.avatarUrl })}
                    className="p-2 rounded-full bg-dark-700 hover:bg-dark-600 transition-colors"
                  >
                    <Heart size={18} className={fav ? 'fill-red-500 text-red-500' : 'text-white'} />
                  </button>
                )
              })()}
              <button
                type="button"
                data-tv-item
                tabIndex={0}
                title="Cerrar canal"
                onClick={() => { setChannel(null); setResults([]); setError(null) }}
                className="p-2 rounded-full bg-dark-700 hover:bg-dark-600 transition-colors"
              >
                <X size={18} className="text-dark-300" />
              </button>
            </div>
          )}

          {/* Loading */}
          {loading && !error && (
            <div className="flex items-center justify-center gap-3 py-12 text-primary-400">
              <LogoLoader size={64} />
              <span>Buscando en YouTube...</span>
            </div>
          )}

          {/* Results grid */}
          {!loading && filteredResults.length > 0 && (
            <>
            <div data-tv-grid className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {filteredResults.map((item, i) => {
                const videoId = `yt:${item.url}`
                const historyItem = ytHistoryMap.get(videoId)
                const hasProgress = historyItem && historyItem.progress > 0.05 && historyItem.progress < 0.95
                const isResolving = resolving === item.url
                return (
                  <div
                    key={i}
                    data-tv-card
                    tabIndex={0}
                    role="button"
                    className="bg-dark-800 rounded-lg overflow-hidden border border-dark-700 hover:border-primary-500 transition-colors cursor-pointer"
                    onClick={() => handlePlayVideo(item)}
                    onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), handlePlayVideo(item))}
                    onFocus={() => handleCardFocus(item.url)}
                    onMouseEnter={() => handleCardFocus(item.url)}
                  >
                    <div className="relative aspect-video bg-dark-900">
                      {item.thumbnailUrl ? (
                        <LazyImage src={item.thumbnailUrl} alt={item.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Youtube size={32} className="text-dark-600" />
                        </div>
                      )}
                      {(() => {
                        const fav = favIds.has(`youtube:yt:${item.url}`)
                        const toggle = (e) => {
                          e.stopPropagation()
                          toggleFavorite({ id: `yt:${item.url}`, type: 'youtube', name: item.name, poster: item.thumbnailUrl })
                        }
                        return (
                          <button
                            type="button"
                            data-tv-item
                            tabIndex={0}
                            title={fav ? 'Quitar de favoritos' : 'Añadir a favoritos'}
                            onClick={toggle}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e) } }}
                            className="absolute top-1 right-1 z-10 p-1.5 rounded-full bg-black/70 backdrop-blur transition-colors hover:bg-black/90"
                          >
                            <Heart size={14} className={fav ? 'fill-red-500 text-red-500' : 'text-white'} />
                          </button>
                        )
                      })()}
                      {item.duration > 0 && (
                        <span className="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded">
                          {formatDuration(item.duration)}
                        </span>
                      )}
                      {item.isLive && (
                        <span className="absolute top-1 left-1 bg-red-600 text-white text-xs px-1.5 py-0.5 rounded font-bold">
                          EN VIVO
                        </span>
                      )}
                      {hasProgress && (
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-dark-700">
                          <div className="h-full bg-primary-500" style={{ width: `${(historyItem.progress * 100).toFixed(1)}%` }} />
                        </div>
                      )}
                      {isResolving && (
                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                          <OctoLoader size={24} className="text-primary-400" />
                        </div>
                      )}
                    </div>
                    <div className="p-2">
                      <h3 className="text-xs font-medium text-white line-clamp-2 mb-0.5">{item.name}</h3>
                      {item.uploaderUrl ? (
                        <button
                          type="button"
                          data-tv-item
                          tabIndex={0}
                          title={`Abrir canal de ${item.uploader}`}
                          onClick={e => { e.stopPropagation(); loadChannel({ name: item.uploader, url: item.uploaderUrl }) }}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); loadChannel({ name: item.uploader, url: item.uploaderUrl }) } }}
                          className="text-xs text-dark-400 truncate hover:text-primary-400 transition-colors text-left max-w-full"
                        >
                          {item.uploader}
                        </button>
                      ) : (
                        <p className="text-xs text-dark-400 truncate">{item.uploader}</p>
                      )}
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-dark-500">
                        {item.views > 0 && (
                          <span className="flex items-center gap-1">
                            <Eye size={10} />
                            {formatViews(item.views)}
                          </span>
                        )}
                        {hasProgress && (
                          <span className="flex items-center gap-1 text-primary-400">
                            <Clock size={10} />
                            Continuar
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Load more (next page) */}
            {(nextPage || loadingMore) && (
              <div className="mt-4 flex items-center justify-center gap-3">
                <button
                  type="button"
                  data-tv-item
                  tabIndex={0}
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="px-6 py-2.5 rounded-lg bg-dark-800 text-dark-200 hover:bg-dark-700 hover:text-white text-sm font-medium transition-colors flex items-center gap-2 disabled:opacity-60"
                >
                  {loadingMore ? <OctoLoader size={16} /> : <Search size={16} />}
                  {loadingMore ? 'Cargando...' : `Cargar más (página ${page + 1})`}
                </button>
                <span className="text-xs text-dark-500">{filteredResults.length} resultados</span>
              </div>
            )}
            </>
          )}

          {/* Empty state with search history */}
          {!loading && !error && results.length === 0 && (
            <div className="py-8">
              {youtubeSearchHistory.length > 0 ? (
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="flex items-center gap-2 text-lg font-bold text-white">
                      <History size={20} className="text-primary-500" />
                      Búsquedas recientes
                    </h2>
                    <button onClick={() => clearYoutubeSearchHistory()} className="text-xs text-dark-400 hover:text-red-400 transition-colors">
                      Borrar todo
                    </button>
                  </div>
                  <div data-tv-list className="flex flex-wrap gap-2">
                    {youtubeSearchHistory.map((q, i) => (
                      <div
                        key={i}
                        data-tv-item
                        tabIndex={0}
                        role="button"
                        className="group flex items-center gap-2 bg-dark-800 hover:bg-dark-700 border border-dark-700 rounded-full px-4 py-2 cursor-pointer transition-colors"
                        onClick={() => { setQuery(q); handleSearch({ preventDefault: () => {} }, q) }}
                        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setQuery(q), handleSearch({ preventDefault: () => {} }, q))}
                      >
                        <Clock size={14} className="text-dark-500" />
                        <span className="text-sm text-dark-200">{q}</span>
                        <button onClick={(e) => { e.stopPropagation(); removeYoutubeSearch(q) }} className="text-dark-500 hover:text-red-400 transition-colors">
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <EmptyState icon={Youtube} minH="min-h-[30vh]">Busca vídeos en YouTube</EmptyState>
              )}
            </div>
          )}
        </>

      {/* Player */}
      {playing && (
        <VideoPlayer
          mode="youtube"
          stream={playing}
          title={playing.title}
          meta={playing.meta}
          startTime={playing.startTime}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  )
}
