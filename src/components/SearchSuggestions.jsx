import { useNavigate } from 'react-router-dom'
import { Search, Loader2 } from 'lucide-react'

export default function SearchSuggestions({ suggestions, loading, onSelect, onClose }) {
  const navigate = useNavigate()

  if (!suggestions || suggestions.length === 0) return null

  const handleSelect = (item) => {
    onSelect(item.name)
    navigate(`/details/${item.type}/${item.id}`)
    onClose()
  }

  return (
    <div className="absolute top-full left-0 right-0 mt-2 bg-dark-800/95 backdrop-blur-md rounded-xl shadow-2xl border border-dark-700 overflow-hidden z-50">
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="animate-spin text-primary-500" size={24} />
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          {suggestions.map((item, index) => (
            <button
              key={`${item.type}-${item.id}-${index}`}
              onClick={() => handleSelect(item)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-dark-700/50 transition-colors text-left focus:outline-none focus:bg-dark-700/50"
            >
              {item.poster ? (
                <img
                  src={item.poster}
                  alt={item.name}
                  className="w-10 h-14 object-cover rounded"
                />
              ) : (
                <div className="w-10 h-14 bg-dark-700 rounded flex items-center justify-center">
                  <Search size={16} className="text-dark-500" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-white font-medium truncate">{item.name}</p>
                <p className="text-dark-400 text-sm truncate">
                  {item.year || ''} {item.genres && item.genres.length > 0 ? `• ${item.genres[0]}` : ''}
                </p>
              </div>
              {item.rating && (
                <div className="text-yellow-400 text-sm font-bold">
                  ★ {Number(item.rating).toFixed(1)}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
