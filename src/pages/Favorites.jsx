import { useStore } from '../store/useStore.js'
import ContentCard from '../components/ContentCard.jsx'
import { Heart } from 'lucide-react'

export default function Favorites() {
  const favorites = useStore(s => s.favorites)

  return (
    <div className="p-4 lg:p-6">
      <h1 className="text-2xl font-bold text-white mb-6">Favoritos</h1>

      {favorites.length === 0 ? (
        <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
          <Heart className="text-dark-600" size={64} />
          <p className="text-dark-400 text-lg">No tienes favoritos todavía</p>
          <p className="text-dark-500 text-sm">Marca contenido con el corazón para guardarlo aquí</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {favorites.map(item => (
            <ContentCard key={`${item.type}-${item.id}`} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
