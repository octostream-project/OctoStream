import { useState, useEffect, useMemo } from 'react'
import { useStore } from '../store/useStore.js'
import ContentCard from '../components/ContentCard.jsx'
import { Search as SearchIcon, Loader2, X, Film, Tv, Radio, Layers } from 'lucide-react'

const FILTERS = [
  { id: 'all', label: 'Todo', icon: Layers },
  { id: 'movie', label: 'Películas', icon: Film },
  { id: 'series', label: 'Series', icon: Tv },
  { id: 'live', label: 'TV en vivo', icon: Radio },
  { id: 'channel', label: 'Canales', icon: Radio },
]

export default function SearchPage() {
  const { searchQuery, searchResults, loading, search } = useStore()
  const [input, setInput] = useState(searchQuery)
  const [activeFilter, setActiveFilter] = useState('all')

  useEffect(() => {
    const timer = setTimeout(() => {
      if (input.trim()) {
        search(input.trim())
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [input])

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

  return (
    <div className="p-4 lg:p-6">
      <h1 className="text-2xl font-bold text-white mb-6">Buscar</h1>

      <div className="relative mb-4">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-500" size={20} />
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Buscar películas, series, canales..."
          className="input w-full pl-10 pr-10 text-lg"
          autoFocus
        />
        {input && (
          <button
            onClick={() => setInput('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-500 hover:text-white"
          >
            <X size={20} />
          </button>
        )}
      </div>

      {/* Filter tabs */}
      {!loading && searchResults.length > 0 && (
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

      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="animate-spin text-primary-500" size={32} />
        </div>
      )}

      {!loading && input && searchResults.length === 0 && (
        <div className="text-center py-20">
          <p className="text-dark-400 text-lg">No se encontraron resultados para "{input}"</p>
        </div>
      )}

      {!loading && searchResults.length > 0 && activeFilter === 'all' && (
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
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                  {items.map(item => (
                    <ContentCard key={`${item.type}-${item.id}`} item={item} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!loading && searchResults.length > 0 && activeFilter !== 'all' && (
        <>
          <p className="text-dark-400 text-sm mb-4">
            {filteredResults.length} resultado{filteredResults.length !== 1 ? 's' : ''}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {filteredResults.map(item => (
              <ContentCard key={`${item.type}-${item.id}`} item={item} />
            ))}
          </div>
        </>
      )}

      {!loading && !input && (
        <div className="text-center py-20">
          <SearchIcon className="mx-auto text-dark-600 mb-4" size={48} />
          <p className="text-dark-400 text-lg">Escribe para buscar contenido</p>
        </div>
      )}
    </div>
  )
}
