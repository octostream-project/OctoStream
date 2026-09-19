import { useState, useEffect, useMemo, useRef } from 'react'
import { useStore } from '../store/useStore.js'
import { searchMulti } from '../plugins/builtIn/tmdb.js'
import ContentCard from '../components/ContentCard.jsx'
import { Search as SearchIcon, X, Film, Tv, Radio, Layers, Clock, Trash2 } from 'lucide-react'
import { getJsonSync, setJsonSync } from '../utils/storage.js'
import OctoLoader from '../components/OctoLoader.jsx'
import LogoLoader from '../components/LogoLoader.jsx'

const FILTERS = [
  { id: 'all', label: 'Todo', icon: Layers },
  { id: 'movie', label: 'Películas', icon: Film },
  { id: 'series', label: 'Series', icon: Tv },
  { id: 'live', label: 'TV en vivo', icon: Radio },
  { id: 'channel', label: 'Canales', icon: Radio },
]

const RECENT_SEARCHES_KEY = 'octostream_recent_searches'
const MAX_RECENT = 5

function loadRecentSearches() {
  return getJsonSync(RECENT_SEARCHES_KEY, [])
}

function saveRecentSearch(query) {
  const q = query.trim()
  if (!q) return
  let recent = loadRecentSearches()
  recent = recent.filter(s => s.toLowerCase() !== q.toLowerCase())
  recent.unshift(q)
  recent = recent.slice(0, MAX_RECENT)
  setJsonSync(RECENT_SEARCHES_KEY, recent)
}

function clearRecentSearches() {
  setJsonSync(RECENT_SEARCHES_KEY, [])
}

// Autocompletado desde TMDB — va por tmdbFetch (caché LRU + dedup inflight):
// si la búsqueda principal lanza la misma query, comparten una sola petición.
async function fetchSuggestions(query, signal) {
  try {
    const results = await searchMulti(query, signal)
    return results.slice(0, 8).map(item => ({
      name: item.name,
      type: item.type === 'movie' ? 'movie' : 'series',
      year: (item.year || item.releaseDate || '').toString().slice(0, 4),
      // Miniatura de 32×48: w92 basta (el w342 por defecto es ~4× más pesado)
      poster: (item.poster || '').replace(/\/t\/p\/w\d+\//, '/t/p/w92/'),
      id: item.id,
    }))
  } catch {
    return []
  }
}

export default function SearchPage() {
  const { searchQuery, searchResults, loading, search, clearSearch } = useStore()
  const [input, setInput] = useState(searchQuery)
  const [activeFilter, setActiveFilter] = useState('all')
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [recentSearches, setRecentSearches] = useState(loadRecentSearches())
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1)
  const abortRef = useRef(null)
  const suggestAbortRef = useRef(null)

  // Búsqueda principal (debounce 400ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      const q = input.trim()
      if (q.length >= 3) {
        if (abortRef.current) abortRef.current.abort()
        const controller = new AbortController()
        abortRef.current = controller
        search(q, controller.signal).catch(() => {})
        // Cerrar el autocompletado cuando se ejecuta la búsqueda principal.
        // Los resultados ya aparecen debajo; no necesita el dropdown abierto.
        setShowSuggestions(false)
        // Guardar en búsquedas recientes.
        saveRecentSearch(q)
        setRecentSearches(loadRecentSearches())
      }
    }, 400)
    if (input.trim().length < 3) clearSearch()
    return () => clearTimeout(timer)
  }, [input, clearSearch])

  // Autocompletado (debounce 200ms, solo si hay 3+ caracteres)
  useEffect(() => {
    const q = input.trim()
    if (q.length < 3) {
      setSuggestions([])
      return
    }
    const timer = setTimeout(() => {
      if (suggestAbortRef.current) suggestAbortRef.current.abort()
      const controller = new AbortController()
      suggestAbortRef.current = controller
      fetchSuggestions(q, controller.signal).then(setSuggestions)
    }, 200)
    return () => clearTimeout(timer)
  }, [input])

  // Abort in-flight search/suggestion requests on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      suggestAbortRef.current?.abort()
    }
  }, [])

  // Group results by type for categorized display
  const grouped = useMemo(() => {
    const groups = {}
    for (const item of searchResults) {
      const type = item.type || 'other'
      if (!groups[type]) groups[type] = []
      groups[type].push(item)
    }
    return groups
  }, [searchResults])

  const filteredResults = useMemo(() => {
    if (activeFilter === 'all') return searchResults
    return searchResults.filter(item => item.type === activeFilter)
  }, [searchResults, activeFilter])

  // Count per filter
  const filterCounts = useMemo(() => {
    const counts = { all: searchResults.length }
    for (const item of searchResults) {
      const type = item.type || 'other'
      counts[type] = (counts[type] || 0) + 1
    }
    return counts
  }, [searchResults])

  const availableFilters = FILTERS.filter(f => f.id === 'all' || (filterCounts[f.id] || 0) > 0)

  // Order for categorized view
  const typeOrder = ['movie', 'series', 'channel', 'live', 'other']
  const typeLabels = {
    movie: 'Películas',
    series: 'Series',
    channel: 'Canales',
    live: 'TV en vivo',
    other: 'Otros',
  }
  const typeIcons = {
    movie: Film,
    series: Tv,
    channel: Radio,
    live: Radio,
    other: Layers,
  }

  const handleSuggestionClick = (suggestion) => {
    const query = suggestion.name
    setInput(query)
    setShowSuggestions(false)
    saveRecentSearch(query)
    setRecentSearches(loadRecentSearches())
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller
    search(query, controller.signal).catch(() => {})
  }

  const handleRecentClick = (query) => {
    setInput(query)
    saveRecentSearch(query)
    setRecentSearches(loadRecentSearches())
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller
    search(query, controller.signal).catch(() => {})
  }

  const handleClearRecent = () => {
    clearRecentSearches()
    setRecentSearches([])
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      // Cerrar autocomplete y ejecutar búsqueda al pulsar Enter
      setShowSuggestions(false)
      setSelectedSuggestion(-1)
      const q = input.trim()
      if (q.length >= 3) {
        if (abortRef.current) abortRef.current.abort()
        const controller = new AbortController()
        abortRef.current = controller
        search(q, controller.signal).catch(() => {})
        saveRecentSearch(q)
        setRecentSearches(loadRecentSearches())
      }
      return
    }
    if (!showSuggestions || !suggestions.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedSuggestion(prev => Math.min(prev + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedSuggestion(prev => Math.max(prev - 1, -1))
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
      setSelectedSuggestion(-1)
    }
  }

  const showSuggestList = showSuggestions && suggestions.length > 0 && input.trim().length >= 3 && !loading && searchResults.length === 0

  return (
    <div className="p-4 lg:p-6">
      <h1 className="text-2xl font-bold text-white mb-6">Buscar</h1>

      <div className="relative mb-4">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-500" size={20} />
        <input
          type="text"
          value={input}
          onChange={e => {
            setInput(e.target.value)
            setShowSuggestions(true)
            setSelectedSuggestion(-1)
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          placeholder="Buscar películas, series, canales, programas U7D..."
          className="input w-full pl-10 pr-10 text-lg"
          autoFocus
        />
        {input && (
          <button
            onClick={() => { setInput(''); setSuggestions([]) }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-500 hover:text-white"
          >
            <X size={20} />
          </button>
        )}

        {/* Dropdown de autocompletado */}
        {showSuggestList && (
          <div className="absolute z-50 left-0 right-0 mt-1 bg-dark-800 border border-dark-700 rounded-lg shadow-xl overflow-hidden max-h-80 overflow-y-auto">
            {suggestions.map((s, i) => (
              <button
                key={`${s.type}-${s.id}`}
                data-focusable
                onClick={() => handleSuggestionClick(s)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSuggestionClick(s) } }}
                onMouseEnter={() => setSelectedSuggestion(i)}
                className={`flex items-center gap-3 w-full px-3 py-2 text-left transition-colors ${
                  i === selectedSuggestion ? 'bg-primary-600 text-white' : 'text-dark-200 hover:bg-dark-700'
                }`}
              >
                {s.poster ? (
                  <img src={s.poster} alt="" className="w-8 h-12 object-cover rounded flex-shrink-0" />
                ) : (
                  <div className="w-8 h-12 bg-dark-700 rounded flex-shrink-0 flex items-center justify-center">
                    {s.type === 'movie' ? <Film size={14} /> : <Tv size={14} />}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{s.name}</p>
                  <p className="text-xs text-dark-400">
                    {s.type === 'movie' ? 'Película' : 'Serie'}{s.year ? ` · ${s.year}` : ''}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Búsquedas recientes (cuando no hay input ni resultados) */}
      {!input && recentSearches.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-dark-300 flex items-center gap-2">
              <Clock size={16} /> Búsquedas recientes
            </h2>
            <button
              onClick={handleClearRecent}
              className="text-dark-500 hover:text-red-400 text-xs flex items-center gap-1"
            >
              <Trash2 size={14} /> Limpiar
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recentSearches.map((q, i) => (
              <button
                key={i}
                onClick={() => handleRecentClick(q)}
                className="px-3 py-1.5 rounded-lg bg-dark-800 text-dark-200 hover:bg-dark-700 hover:text-white text-sm transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filter tabs */}
      {searchResults.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {availableFilters.map(f => {
            const Icon = f.icon
            const count = filterCounts[f.id] || 0
            const isActive = activeFilter === f.id
            return (
              <button
                key={f.id}
                onClick={() => setActiveFilter(f.id)}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-primary-600 text-white'
                    : 'bg-dark-800 text-dark-300 hover:bg-dark-700 hover:text-white'
                }`}
              >
                <Icon size={16} />
                {f.label}
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${isActive ? 'bg-primary-700' : 'bg-dark-700'}`}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {loading && searchResults.length === 0 && (
        <div className="flex items-center justify-center py-20">
          <LogoLoader size={64} />
        </div>
      )}

      {!loading && input && searchResults.length === 0 && (
        <div className="text-center py-20">
          <p className="text-dark-400 text-lg">No se encontraron resultados para "{input}"</p>
        </div>
      )}

      {searchResults.length > 0 && activeFilter === 'all' && (
        <div className="space-y-8">
          {typeOrder.map(type => {
            const items = grouped[type]
            if (!items || items.length === 0) return null
            const Icon = typeIcons[type] || Layers
            return (
              <div key={type}>
                <div className="flex items-center gap-2 mb-4">
                  <Icon className="text-primary-400" size={20} />
                  <h2 className="text-lg font-bold text-white">{typeLabels[type] || type}</h2>
                  <span className="text-xs text-dark-500 bg-dark-800 px-2 py-0.5 rounded-full">{items.length}</span>
                </div>
                <div data-tv-grid className="media-card-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                  {items.map(item => (
                    <ContentCard key={`${item.type}-${item.id}`} item={item} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {searchResults.length > 0 && activeFilter !== 'all' && (
        <>
          <p className="text-dark-400 text-sm mb-4">
            {filteredResults.length} resultado{filteredResults.length !== 1 ? 's' : ''}
          </p>
          <div data-tv-grid className="media-card-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {filteredResults.map(item => (
              <ContentCard key={`${item.type}-${item.id}`} item={item} />
            ))}
          </div>
        </>
      )}

      {!loading && !input && !recentSearches.length && (
        <div className="text-center py-20">
          <SearchIcon className="mx-auto text-dark-600 mb-4" size={48} />
          <p className="text-dark-400 text-lg">Escribe para buscar contenido</p>
        </div>
      )}
    </div>
  )
}
