import { useEffect, useState } from 'react'
import { pluginManager } from '../plugins/manager.js'
import ContentRow from '../components/ContentRow.jsx'
import { Loader2, Clapperboard } from 'lucide-react'

export default function Home() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadContent = async () => {
      setLoading(true)
      const catalogs = pluginManager.getAllCatalogs()
      // Split: movies/series first (fast), TV/live later (slow)
      const movieCatalogs = catalogs.filter(c => c.type === 'movie' || c.type === 'series')
      const tvCatalogs = catalogs.filter(c => c.type !== 'movie' && c.type !== 'series')

      // Load movies/series first and show immediately
      const fastRows = []
      for (const cat of movieCatalogs) {
        try {
          const items = await pluginManager.getCatalogContent(cat.pluginId, cat.id, cat.type, 0, 20)
          if (items && items.length > 0) {
            fastRows.push({ title: cat.name, items })
          }
        } catch (e) { /* skip */ }
      }
      setRows(fastRows)
      setLoading(false)

      // Load TV/live in background and append
      const tvRows = []
      for (const cat of tvCatalogs) {
        try {
          const items = await pluginManager.getCatalogContent(cat.pluginId, cat.id, cat.type, 0, 20)
          if (items && items.length > 0) {
            tvRows.push({ title: cat.name, items })
          }
        } catch (e) { /* skip */ }
      }
      if (tvRows.length > 0) {
        setRows(prev => [...prev, ...tvRows])
      }
    }
    loadContent()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-primary-500" size={48} />
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Clapperboard className="text-dark-600" size={64} />
        <p className="text-dark-400 text-lg">No hay contenido disponible</p>
        <p className="text-dark-500 text-sm">Instala plugins desde la sección de Plugins</p>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6">
      <h1 className="text-2xl font-bold text-white mb-6">Inicio</h1>
      {rows.map((row, i) => (
        <ContentRow key={i} title={row.title} items={row.items} />
      ))}
    </div>
  )
}
