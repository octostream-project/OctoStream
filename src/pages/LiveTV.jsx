import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { pluginManager } from '../plugins/manager.js'
import { CONTENT_TYPES } from '../plugins/base.js'
import EpgGrid from '../components/EpgGrid.jsx'
import { useTranslation } from '../i18n/index.js'
import { Loader2, Tv, Play, AlertCircle, LayoutGrid, Calendar, Clock } from 'lucide-react'

export default function LiveTV() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [channels, setChannels] = useState([])
  const [tvCatalogs, setTvCatalogs] = useState([])
  const [activeCat, setActiveCat] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tvPlugins, setTvPlugins] = useState([])
  const [viewMode, setViewMode] = useState('grid')
  const [programs, setPrograms] = useState([])
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [allChannels, setAllChannels] = useState([])
  const [u7dCatalogs, setU7dCatalogs] = useState([])
  const [u7dItems, setU7dItems] = useState([])
  const [activeU7dCat, setActiveU7dCat] = useState(null)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const installed = pluginManager.getInstalledPlugins()
        const allCatalogs = await pluginManager.getAllCatalogs()
        const channelCatalogs = allCatalogs.filter(c => (c.type === CONTENT_TYPES.CHANNEL || c.type === CONTENT_TYPES.LIVE) && !c.id?.startsWith('u7d-'))
        const u7dCatalogs = allCatalogs.filter(c => c.id?.startsWith('u7d-'))
        setTvCatalogs(channelCatalogs)
        setU7dCatalogs(u7dCatalogs)
        setTvPlugins(installed.filter(p => p.manifest.types?.includes(CONTENT_TYPES.CHANNEL) || p.manifest.types?.includes(CONTENT_TYPES.LIVE)))
        if (channelCatalogs.length === 0) {
          setError(t('live.no_plugins'))
          setLoading(false)
          return
        }
        setActiveCat(channelCatalogs[0])

        const loadedAll = []
        for (const cat of channelCatalogs) {
          const items = await pluginManager.getCatalogContent(cat.pluginId, cat.id, cat.type, 0, 500)
          items.forEach(item => loadedAll.push({ ...item, pluginId: cat.pluginId }))
        }
        setAllChannels(loadedAll)
      } catch (e) {
        console.error('[LiveTV] error', e)
        setError(t('live.load_error') + ': ' + (e.message || 'unknown'))
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  useEffect(() => {
    if (!activeCat) return
    const load = async () => {
      setLoading(true)
      try {
        const items = await pluginManager.getCatalogContent(activeCat.pluginId, activeCat.id, activeCat.type, 0, 500)
        setChannels(items.map(item => ({ ...item, pluginId: activeCat.pluginId })))
      } catch (e) {
        console.error('[LiveTV] load channel error', e)
        setError(t('live.load_error') + ': ' + (e.message || 'unknown'))
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [activeCat])

  useEffect(() => {
    if (viewMode !== 'epg') return
    const load = async () => {
      try {
        const epgPrograms = await pluginManager.getEpg(selectedDate)
        setPrograms(epgPrograms)
      } catch (e) {
        console.error('[LiveTV] EPG error', e)
      }
    }
    load()
  }, [viewMode, selectedDate])

  useEffect(() => {
    if (viewMode !== 'u7d') return
    const load = async () => {
      if (u7dCatalogs.length === 0) return
      const first = u7dCatalogs[0]
      setActiveU7dCat(first)
    }
    load()
  }, [viewMode, u7dCatalogs])

  useEffect(() => {
    if (!activeU7dCat) return
    const load = async () => {
      setLoading(true)
      try {
        const items = await pluginManager.getCatalogContent(activeU7dCat.pluginId, activeU7dCat.id, activeU7dCat.type, 0, 500)
        setU7dItems(items)
      } catch (e) {
        console.error('[LiveTV] U7D error', e)
        setU7dItems([])
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [activeU7dCat])

  const handlePlayChannel = (channel) => {
    navigate(`/details/${channel.type}/${channel.id}`)
  }

  const groupU7dByDay = (items) => {
    const groups = {}
    for (const item of items) {
      const ts = item.startTimestamp || item.startTime || 0
      const d = ts ? new Date(typeof ts === 'number' ? ts * 1000 : ts) : new Date()
      const day = d.toISOString().slice(0, 10)
      if (!groups[day]) groups[day] = []
      groups[day].push(item)
    }
    // Ordenar días de más reciente a más antiguo, y dentro de cada día de más antiguo a más reciente
    for (const day of Object.keys(groups)) {
      groups[day].sort((a, b) => (a.startTimestamp || a.startTime || 0) - (b.startTimestamp || b.startTime || 0))
    }
    // Mostrar solo los últimos 7 días
    return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7)
  }

  const formatU7dDay = (dayStr) => {
    const d = new Date(dayStr + 'T00:00:00')
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
    return days[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-primary-500" size={48} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 p-4">
        <Tv className="text-dark-600" size={64} />
        <p className="text-dark-400 text-lg font-medium">{error}</p>
        {tvPlugins.length > 0 && (
          <div className="bg-dark-800/80 rounded-lg p-4 border border-dark-700/50 max-w-md">
            <p className="text-dark-300 text-sm font-medium mb-2">Plugins de TV instalados:</p>
            <ul className="text-dark-400 text-sm space-y-1">
              {tvPlugins.map(p => (
                <li key={p.id} className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-primary-500" />
                  {p.manifest.name} ({p.id})
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  if (channels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 p-4">
        <Tv className="text-dark-600" size={64} />
        <p className="text-dark-400 text-lg font-medium">{t('live.no_channels')}</p>
        <p className="text-dark-500 text-sm">{t('live.install_tv_plugin')}</p>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <Tv className="text-primary-500" size={32} />
          <h1 className="text-3xl font-bold text-white">{t('live.title')}</h1>
          <div className="flex items-center gap-1 ml-2 bg-dark-800 rounded-lg p-1">
            <button
              onClick={() => setViewMode('grid')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'grid' ? 'bg-primary-600 text-white' : 'text-dark-300 hover:text-white'}`}
            >
              <LayoutGrid size={16} />
              Canales
            </button>
            <button
              onClick={() => setViewMode('epg')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'epg' ? 'bg-primary-600 text-white' : 'text-dark-300 hover:text-white'}`}
            >
              <Calendar size={16} />
              Guía EPG
            </button>
            {u7dCatalogs.length > 0 && (
              <button
                onClick={() => setViewMode('u7d')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'u7d' ? 'bg-primary-600 text-white' : 'text-dark-300 hover:text-white'}`}
              >
                <Clock size={16} />
                7 Días
              </button>
            )}
          </div>
        </div>
      </div>

      {viewMode === 'grid' ? (
        <>
          <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin">
            {tvCatalogs.map(cat => (
              <button
                key={cat.id}
                onClick={() => setActiveCat(cat)}
                className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors ${activeCat?.id === cat.id ? 'bg-primary-600 text-white' : 'bg-dark-800 text-dark-300 hover:bg-dark-700'}`}
              >
                {cat.name}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {channels.map(channel => (
              <button
                key={channel.id}
                onClick={() => handlePlayChannel(channel)}
                className="card group p-4 flex flex-col items-center gap-3 text-center"
              >
                {channel.logo ? (
                  <img src={channel.logo} alt={channel.name} className="w-12 h-12 object-contain rounded bg-white/10" />
                ) : (
                  <div className="w-12 h-12 bg-primary-600/20 rounded-lg flex items-center justify-center">
                    <Tv className="text-primary-400" size={24} />
                  </div>
                )}
                <div>
                  <p className="text-white font-medium text-sm">{channel.name}</p>
                  <p className="text-primary-400 text-xs flex items-center justify-center gap-1 mt-1">
                    <Play size={10} /> Ver ahora
                  </p>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : viewMode === 'epg' ? (
        <>
          <EpgGrid
            channels={allChannels}
            programs={programs}
            onPlayChannel={handlePlayChannel}
            selectedDate={selectedDate}
            onDateChange={setSelectedDate}
          />
          <div className="bg-dark-800/50 rounded-xl p-4 border border-dark-700/50 text-sm text-dark-400 flex items-center gap-2">
            <AlertCircle size={16} className="text-primary-400" />
            La guía EPG se genera a partir de los plugins instalados. Los horarios son orientativos.
          </div>
        </>
      ) : (
        <>
          <div className="bg-dark-800/50 rounded-xl p-4 border border-dark-700/50 text-sm text-dark-300 flex items-start gap-3">
            <Clock size={18} className="text-primary-400 mt-0.5 flex-shrink-0" />
            <p>Contenido de los últimos 7 días. Selecciona un canal para ver sus programas disponibles, ordenados por día y hora de emisión.</p>
          </div>

          <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin">
            {u7dCatalogs.map(cat => (
              <button
                key={cat.id}
                onClick={() => setActiveU7dCat(cat)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors ${activeU7dCat?.id === cat.id ? 'bg-primary-600 text-white' : 'bg-dark-800 text-dark-300 hover:bg-dark-700'}`}
              >
                {cat.channelLogo ? (
                  <img src={cat.channelLogo} alt={cat.channelName} className="w-5 h-5 object-contain rounded bg-white/10" />
                ) : (
                  <Tv size={14} />
                )}
                {cat.name}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center min-h-[40vh]">
              <Loader2 className="animate-spin text-primary-500" size={48} />
            </div>
          ) : u7dItems.length === 0 ? (
            <div className="flex items-center justify-center min-h-[40vh]">
              <p className="text-dark-400">No hay contenido disponible</p>
            </div>
          ) : (
            <div className="space-y-6">
              {groupU7dByDay(u7dItems).map(([day, items]) => (
                <div key={day} className="space-y-3">
                  <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                    <Calendar size={18} className="text-primary-400" />
                    {formatU7dDay(day)}
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                    {items.map(item => (
                      <button
                        key={item.id}
                        onClick={() => handlePlayChannel(item)}
                        className="card group p-3 flex flex-col gap-2 text-left"
                      >
                        {item.poster ? (
                          <img src={item.poster} alt={item.title} className="w-full aspect-video object-cover rounded-lg" />
                        ) : (
                          <div className="w-full aspect-video bg-primary-600/20 rounded-lg flex items-center justify-center">
                            <Tv className="text-primary-400" size={32} />
                          </div>
                        )}
                        <div>
                          <p className="text-white font-medium text-sm line-clamp-2">{item.title}</p>
                          {item.description && (
                            <p className="text-primary-400 text-xs mt-1">{item.description}</p>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
