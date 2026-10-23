import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { pluginManager } from '../plugins/manager.js'
import ContentCard from '../components/ContentCard.jsx'
import OctoLoader from '../components/OctoLoader.jsx'
import MediaGrid from '../components/ui/MediaGrid.jsx'
import { SkeletonGrid } from '../components/ui/SkeletonCard.jsx'

export default function Catalog() {
  const { pluginId, catalogId, type } = useParams()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [skip, setSkip] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [catalogName, setCatalogName] = useState('')

  useEffect(() => {
    setItems([])
    setSkip(0)
    setHasMore(true)
    setLoading(true)
    setCatalogName('')
    loadContent(0, true)
    pluginManager.getAllCatalogs().then(cats => {
      const cat = cats.find(c => c.pluginId === pluginId && c.id === catalogId)
      if (cat) setCatalogName(cat.name || cat.pluginName || '')
    }).catch(() => {})
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
      <div className="p-4 lg:p-6">
        <SkeletonGrid />
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6">
      <h1 className="text-2xl font-bold text-white mb-6">
        {catalogName || 'Catálogo'}
      </h1>
      <MediaGrid>
        {items.map(item => (
          <ContentCard key={`${item.type}-${item.id}`} item={item} />
        ))}
      </MediaGrid>
      {hasMore && (
        <div className="flex justify-center mt-8">
          <button
            onClick={loadMore}
            disabled={loading}
            className="btn-secondary"
          >
            {loading ? <OctoLoader size={20} /> : 'Cargar más'}
          </button>
        </div>
      )}
    </div>
  )
}
