import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore.js'
import ContentCard from '../components/ContentCard.jsx'
import { Search as SearchIcon, Loader2, X } from 'lucide-react'

export default function SearchPage() {
  const { searchQuery, searchResults, loading, search } = useStore()
  const [input, setInput] = useState(searchQuery)

  useEffect(() => {
    const timer = setTimeout(() => {
      if (input.trim()) {
        search(input.trim())
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [input])

  return (
    <div className="p-4 lg:p-6">
      <h1 className="text-2xl font-bold text-white mb-6">Buscar</h1>

      <div className="relative mb-6">
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

      {!loading && searchResults.length > 0 && (
        <>
          <p className="text-dark-400 text-sm mb-4">
            {searchResults.length} resultado{searchResults.length !== 1 ? 's' : ''}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {searchResults.map(item => (
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
