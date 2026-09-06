import { Play, Info } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export default function Hero({ item }) {
  const navigate = useNavigate()

  if (!item) return null

  return (
    <div className="relative w-full h-[60vh] min-h-[400px] mb-8 overflow-hidden rounded-2xl shadow-2xl">
      {item.poster ? (
        <img
          src={item.poster}
          alt={item.name}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-primary-900 to-dark-900" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-dark-950 via-dark-950/50 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-dark-950 via-dark-950/80 to-transparent" />
      
      <div className="absolute bottom-0 left-0 right-0 p-6 lg:p-10">
        <div className="max-w-3xl">
          <h1 className="text-4xl lg:text-5xl font-bold text-white mb-3 drop-shadow-lg">
            {item.name}
          </h1>
          <p className="text-lg text-dark-200 mb-4 line-clamp-2 drop-shadow">
            {item.description || 'Disfruta del mejor contenido en streaming'}
          </p>
          <div className="flex items-center gap-4 mb-6">
            {item.rating && (
              <div className="flex items-center gap-1 bg-yellow-500/20 backdrop-blur-sm px-3 py-1 rounded-full">
                <span className="text-yellow-400 font-bold">★</span>
                <span className="text-white font-semibold">{Number(item.rating).toFixed(1)}</span>
              </div>
            )}
            {item.year && (
              <span className="text-dark-300 font-medium">{item.year}</span>
            )}
            {item.genres && item.genres.length > 0 && (
              <span className="text-primary-400 font-medium">{item.genres[0]}</span>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => navigate(`/details/${item.type}/${item.id}`)}
              className="btn-primary px-6 py-3 text-lg shadow-xl"
            >
              <Play size={20} className="mr-2" />
              Reproducir
            </button>
            <button
              onClick={() => navigate(`/details/${item.type}/${item.id}`)}
              className="btn-secondary px-6 py-3 text-lg"
            >
              <Info size={20} className="mr-2" />
              Más info
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
