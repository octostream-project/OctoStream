import { useNavigate } from 'react-router-dom'
import { Star, Play } from 'lucide-react'

export default function ContentCard({ item }) {
  const navigate = useNavigate()

  const handleClick = () => {
    navigate(`/details/${item.type}/${item.id}`)
  }

  return (
    <div className="card group" onClick={handleClick}>
      <div className="relative aspect-[2/3] bg-dark-700 overflow-hidden">
        {item.poster ? (
          <img
            src={item.poster}
            alt={item.name}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Play size={32} className="text-dark-500" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        <div className="absolute bottom-2 left-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          <div className="flex items-center justify-center bg-primary-600 rounded-lg py-2 text-sm font-medium">
            <Play size={16} className="mr-1" /> Ver ahora
          </div>
        </div>
        {item.rating && (
          <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/70 backdrop-blur px-2 py-1 rounded-lg text-xs">
            <Star size={12} className="text-yellow-400 fill-yellow-400" />
            <span className="text-white font-medium">{item.rating.toFixed(1)}</span>
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="text-sm font-medium text-white truncate">{item.name}</h3>
        <div className="flex items-center justify-between mt-1">
          <span className="text-xs text-dark-400">{item.year || ''}</span>
          {item.genres && item.genres.length > 0 && (
            <span className="text-xs text-dark-500 truncate ml-2">{item.genres[0]}</span>
          )}
        </div>
      </div>
    </div>
  )
}
