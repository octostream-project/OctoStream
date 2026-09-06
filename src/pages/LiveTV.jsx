import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { pluginManager } from '../plugins/manager.js'
import { CONTENT_TYPES } from '../plugins/base.js'
import EpgGrid from '../components/EpgGrid.jsx'
import { useTranslation } from '../i18n/index.js'
import { Loader2, Tv, Play, AlertCircle, LayoutGrid, Calendar, Clock, ArrowLeft } from 'lucide-react'

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
  const [u7dSelectedChannel, setU7dSelectedChannel] = useState(null)
  const [u7dSelectedDay, setU7dSelectedDay] = useState(null)
  const [u7dChannels, setU7dChannels] = useState([])

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

        // Load only the first catalog quickly, rest in background
        const firstCat = channelCatalogs[0]
        const firstItems = await pluginManager.getCatalogContent(firstCat.pluginId, firstCat.id, firstCat.type, 0, 500)
        const loadedAll = firstItems.map(item => ({ ...item, pluginId: firstCat.pluginId }))
        setAllChannels(loadedAll)
        setLoading(false)

        // Load remaining catalogs in background
        for (let i = 1; i < channelCatalogs.length; i++) {
          const cat = channelCatalogs[i]
          try {
            const items = await pluginManager.getCatalogContent(cat.pluginId, cat.id, cat.type, 0, 500)
            setAllChannels(prev => [...prev, ...items.map(item => ({ ...item, pluginId: cat.pluginId }))])
          } catch (e) { /* skip */ }
        }
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
    // Load U7D channel list from the catalog
    const load = async () => {
      setLoading(true)
      try {
        if (u7dCatalogs.length > 0) {
          const cat = u7dCatalogs[0]
          const channels = await pluginManager.getCatalogContent(cat.pluginId, cat.id, cat.type, 0, 200)
          setU7dChannels(channels)
        }
      } catch (e) {
        console.error('[LiveTV] U7D channel list error', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [viewMode, u7dCatalogs])

  useEffect(() => {
    if (viewMode !== 'u7d' || !u7dSelectedChannel || !u7dSelectedDay) return
    const load = async () => {
      setLoading(true)
      try {
        // Load programs for the selected channel only
        if (u7dCatalogs.length > 0) {
          const cat = u7dCatalogs[0]
          const chKey = u7dSelectedChannel.channelId || String(u7dSelectedChannel.id || '').replace(/^u7d-channel-/, '')
          const allItems = await pluginManager.getCatalogContent(cat.pluginId, `u7d-programs-${chKey}`, cat.type, 0, 500)
          // Filter by day
          const dayStr = u7dSelectedDay
          const filtered = allItems.filter(item => {
            const ts = item.startTimestamp || (item.startTime ? new Date(item.startTime).getTime() / 1000 : 0)
            const itemDay = ts ? new Date(ts * 1000).toISOString().slice(0, 10) : ''
            return itemDay === dayStr
          })
          setU7dItems(filtered)
        }
      } catch (e) {
        console.error('[LiveTV] U7D error', e)
        setU7dItems([])
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [viewMode, u7dSelectedChannel, u7dSelectedDay, u7dCatalogs])

  const handlePlayChannel = (channel) => {
    // If it's a group, load its channels instead of navigating to details
    if (channel.isGroup || channel.id?.startsWith('tdtspain-group-')) {
      setActiveCat({
        id: channel.id,
        name: channel.name,
        type: CONTENT_TYPES.LIVE,
        pluginId: 'tdtspain',
      })
      return
    }
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

  const getLast7Days = () => {
    const result = []
    const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
    for (let i = 0; i < 7; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const value = d.toISOString().slice(0, 10)
      const label = (i === 0 ? 'Hoy' : i === 1 ? 'Ayer' : days[d.getDay()]) + ' ' + d.getDate() + '/' + (d.getMonth() + 1)
      result.push({ value, label })
    }
    return result
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
            {/* Show "Volver a grupos" button when inside a group */}
            {activeCat?.id?.startsWith('tdtspain-group-') && (
              <button
                onClick={() => setActiveCat(tvCatalogs.find(c => c.id === 'tdtspain-groups'))}
                className="px-3 py-1.5 rounded-full text-sm whitespace-nowrap bg-primary-600/20 text-primary-400 hover:bg-primary-600/30 transition-colors flex items-center gap-1"
              >
                <ArrowLeft size={14} /> Volver a grupos
              </button>
            )}
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
            <p>Contenido de los últimos 7 días. Selecciona un canal y un día para ver sus programas disponibles.</p>
          </div>

          {/* Step 1: Select channel */}
          {!u7dSelectedChannel && (
            <>
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <Tv size={18} className="text-primary-400" />
                Selecciona un canal
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                {u7dChannels.map(ch => (
                  <button
                    key={ch.id}
                    onClick={() => { setU7dSelectedChannel(ch); setU7dSelectedDay(null); setU7dItems([]) }}
                    className="card group p-4 flex flex-col items-center gap-3 text-center"
                  >
                    {ch.logo ? (
                      <img src={ch.logo} alt={ch.name} className="w-12 h-12 object-contain rounded bg-white/10" />
                    ) : (
                      <div className="w-12 h-12 bg-primary-600/20 rounded-lg flex items-center justify-center">
                        <Tv className="text-primary-400" size={24} />
                      </div>
                    )}
                    <p className="text-white font-medium text-sm">{ch.name}</p>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Step 2: Select day */}
          {u7dSelectedChannel && !u7dSelectedDay && (
            <>
              <div className="flex items-center gap-3 mb-4">
                <button
                  onClick={() => { setU7dSelectedChannel(null); setU7dItems([]) }}
                  className="btn-ghost p-2"
                >
                  <ArrowLeft size={20} />
                </button>
                <div className="flex items-center gap-2">
                  {u7dSelectedChannel.logo && (
                    <img src={u7dSelectedChannel.logo} alt={u7dSelectedChannel.name} className="w-8 h-8 object-contain rounded bg-white/10" />
                  )}
                  <h3 className="text-lg font-semibold text-white">{u7dSelectedChannel.name}</h3>
                </div>
              </div>
              <h4 className="text-sm text-dark-400 mb-3">Selecciona un día</h4>
              <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin">
                {getLast7Days().map(day => (
                  <button
                    key={day.value}
                    onClick={() => setU7dSelectedDay(day.value)}
                    className="px-4 py-2 rounded-lg text-sm whitespace-nowrap bg-dark-800 text-dark-300 hover:bg-dark-700 transition-colors"
                  >
                    {day.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Step 3: Show programs */}
          {u7dSelectedChannel && u7dSelectedDay && (
            <>
              <div className="flex items-center gap-3 mb-4">
                <button
                  onClick={() => { setU7dSelectedDay(null); setU7dItems([]) }}
                  className="btn-ghost p-2"
                >
                  <ArrowLeft size={20} />
                </button>
                <div className="flex items-center gap-2">
                  {u7dSelectedChannel.logo && (
                    <img src={u7dSelectedChannel.logo} alt={u7dSelectedChannel.name} className="w-8 h-8 object-contain rounded bg-white/10" />
                  )}
                  <h3 className="text-lg font-semibold text-white">{u7dSelectedChannel.name}</h3>
                  <span className="text-dark-400 text-sm">· {formatU7dDay(u7dSelectedDay)}</span>
                </div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center min-h-[40vh]">
                  <Loader2 className="animate-spin text-primary-500" size={48} />
                </div>
              ) : u7dItems.length === 0 ? (
                <div className="flex items-center justify-center min-h-[40vh]">
                  <p className="text-dark-400">No hay contenido disponible para este día</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                  {u7dItems.map(item => {
                    const ts = item.startTimestamp || (item.startTime ? new Date(item.startTime).getTime() / 1000 : 0)
                    const timeStr = ts ? new Date(ts * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : ''
                    const noVod = item.hasVod === false
                    return (
                      <button
                        key={item.id}
                        onClick={() => !noVod && handlePlayChannel(item)}
                        className={`card group p-3 flex flex-col gap-2 text-left ${noVod ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        {item.poster ? (
                          <img src={item.poster} alt={item.title} className="w-full aspect-video object-cover rounded-lg" />
                        ) : (
                          <div className="w-full aspect-video bg-primary-600/20 rounded-lg flex items-center justify-center">
                            <Tv className="text-primary-400" size={32} />
                          </div>
                        )}
                        <div>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            {timeStr && <span className="text-dark-500 text-xs">{timeStr}</span>}
                            {item.hasVod && <span className="text-[10px] bg-green-600/30 text-green-400 px-1 rounded">VOD</span>}
                          </div>
                          <p className="text-white font-medium text-sm line-clamp-2">{item.title}</p>
                          {item.description && (
                            <p className="text-primary-400 text-xs mt-1 line-clamp-2">{item.description}</p>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
