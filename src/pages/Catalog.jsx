import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { pluginManager } from '../plugins/manager.js'
import ContentCard from '../components/ContentCard.jsx'
import { Loader2 } from 'lucide-react'

export default function Catalog() {
  const { pluginId, catalogId, type } = useParams()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [skip, setSkip] = useState(0)
  const [hasMore, setHasMore] = useState(true)

  useEffect(() => {
    setItems([])
    setSkip(0)
    setHasMore(true)
    setLoading(true)
    loadContent(0, true)
  }, [pluginId, catalogId, type])

  const loadContent = async (offset, reset = false) => {
    setLoading(true)
    try {
      const newItems = await pluginManager.getCatalogContent(pluginId, catalogId, type, offset, 50)
      if (reset) {
        setItems(newItems)
      } else {
        setItems(prev => [...prev, ...newItems])
      }
      setHasMore(newItems.length === 50)
    } catch (e) {
      setHasMore(false)
    }
    setLoading(false)
  }

  const loadMore = () => {
    const newSkip = skip + 50
    setSkip(newSkip)
    loadContent(newSkip)
  }

  if (loading && items.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-primary-500" size={48} />
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6">
      <h1 className="text-2xl font-bold text-white mb-6">
        {items.length > 0 ? '' : 'Catálogo'}
      </h1>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {items.map(item => (
          <ContentCard key={`${item.type}-${item.id}`} item={item} />
        ))}
      </div>
      {hasMore && (
        <div className="flex justify-center mt-8">
          <button
            onClick={loadMore}
            disabled={loading}
            className="btn-secondary"
          >
            {loading ? <Loader2 className="animate-spin" size={20} /> : 'Cargar más'}
          </button>
        </div>
      )}
    </div>
  )
}
