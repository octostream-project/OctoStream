import { useEffect, useState } from 'react'
import { pluginManager } from '../plugins/manager.js'
import { CONTENT_TYPES } from '../plugins/base.js'
import EpgGrid from '../components/EpgGrid.jsx'
import { useTranslation } from '../i18n/index.js'
import { Loader2, Tv, AlertCircle, Calendar } from 'lucide-react'

export default function Epg() {
  const { t } = useTranslation()
  const [channels, setChannels] = useState([])
  const [programs, setPrograms] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [error, setError] = useState('')
  const [tvPlugins, setTvPlugins] = useState([])

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const installed = pluginManager.getInstalledPlugins()
        const allCatalogs = await pluginManager.getAllCatalogs()
        const tvCatalogs = allCatalogs.filter(c => c.type === CONTENT_TYPES.CHANNEL)
        setTvPlugins(installed.filter(p => p.manifest.types?.includes(CONTENT_TYPES.CHANNEL) || p.manifest.types?.includes(CONTENT_TYPES.LIVE)))

        if (tvCatalogs.length === 0) {
          setError(t('live.no_plugins'))
          setLoading(false)
          return
        }

        const loadedChannels = []
        for (const cat of tvCatalogs) {
          const items = await pluginManager.getCatalogContent(cat.pluginId, cat.id, cat.type, 0, 500)
          items.forEach(item => loadedChannels.push({ ...item, pluginId: cat.pluginId }))
        }
        setChannels(loadedChannels)

        const epgPrograms = await pluginManager.getEpg(selectedDate)
        setPrograms(epgPrograms)
      } catch (e) {
        console.error('[Epg] error', e)
        setError(t('live.load_error') + ': ' + (e.message || 'unknown'))
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [selectedDate])

  const handlePlayChannel = (channel) => {
    window.location.hash = `#/details/${channel.type}/${channel.id}`
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Calendar className="text-primary-500" size={32} />
          <h1 className="text-3xl font-bold text-white">Guía TV</h1>
        </div>
      </div>

      <EpgGrid
        channels={channels}
        programs={programs}
        onPlayChannel={handlePlayChannel}
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
      />

      <div className="bg-dark-800/50 rounded-xl p-4 border border-dark-700/50 text-sm text-dark-400 flex items-center gap-2">
        <AlertCircle size={16} className="text-primary-400" />
        La guía EPG se genera a partir de los plugins instalados. Los horarios son orientativos.
      </div>
    </div>
  )
}
