import { useEffect, useState, useRef, useCallback } from 'react'
import { pluginManager } from '../plugins/manager.js'
import { switchChannel } from '../utils/exoPlayer.js'
import { useWindowedList } from '../hooks/useWindowedList.js'
import { useStore } from '../store/useStore.js'
import { CONTENT_TYPES } from '../plugins/base.js'
import EpgGrid from '../components/EpgGrid.jsx'
import VideoPlayer from '../components/VideoPlayer.jsx'
import { useTranslation } from '../i18n/index.js'
import { isAndroidTv } from '../utils/platform.js'
import { Tv, Play, AlertCircle, LayoutGrid, Calendar, Clock, ArrowLeft } from 'lucide-react'
import OctoLoader from '../components/OctoLoader.jsx'
import LogoLoader from '../components/LogoLoader.jsx'

const urlHost = (u) => { try { return new URL(u).host } catch { return 'unknown' } }

// Normaliza nombres de canal para deduplicación: minúsculas, sin espacios
// extra, sin sufijos HD/FHD/4K comunes.
function normalizeChannelName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s+(hd|fhd|4k|full hd)$/i, '')
}

export default function LiveTV() {
  const { t } = useTranslation()
  const addToHistory = useStore(s => s.addToHistory)
  // Restore state from sessionStorage so navigating back from details preserves view
  const savedState = (() => {
    try {
      const raw = sessionStorage.getItem('livetv_state')
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  })()
  const [channels, setChannels] = useState([])
  // Montaje progresivo del grid (hasta 500 canales cargados)
  const channelsWindow = useWindowedList(channels, 60, 60)
  const [tvCatalogs, setTvCatalogs] = useState([])
  const [activeCat, setActiveCat] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tvPlugins, setTvPlugins] = useState([])
  const [viewMode, setViewMode] = useState(savedState.viewMode || 'grid')
  const [programs, setPrograms] = useState([])
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [allChannels, setAllChannels] = useState([])
  const [u7dCatalogs, setU7dCatalogs] = useState([])
  const [u7dItems, setU7dItems] = useState([])
  const [u7dSelectedChannel, setU7dSelectedChannel] = useState(savedState.u7dSelectedChannel || null)
  const [u7dSelectedDay, setU7dSelectedDay] = useState(savedState.u7dSelectedDay || null)
  const [u7dChannels, setU7dChannels] = useState([])

  // Persist view state to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem('livetv_state', JSON.stringify({
        viewMode,
        u7dSelectedChannel,
        u7dSelectedDay,
      }))
    } catch { /* ignore */ }
  }, [viewMode, u7dSelectedChannel, u7dSelectedDay])

  // Restore scroll position on mount
  useEffect(() => {
    const savedScroll = sessionStorage.getItem('livetv_scroll')
    if (!savedScroll) return
    requestAnimationFrame(() => {
      const main = document.querySelector('main')
      if (main) main.scrollTop = parseInt(savedScroll, 10)
    })
  }, [])

  // Save scroll position before navigating away
  useEffect(() => {
    const main = document.querySelector('main')
    if (!main) return
    const onSave = () => sessionStorage.setItem('livetv_scroll', String(main.scrollTop))
    window.addEventListener('pagehide', onSave)
    return () => window.removeEventListener('pagehide', onSave)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const installed = pluginManager.getInstalledPlugins()
        const allCatalogs = await pluginManager.getAllCatalogs()
        // Los plugins de deportes (FCTV, DLive) tienen su propia página
        // (Deportes): no mezclarlos con canales TV.
        const channelCatalogs = allCatalogs.filter(c =>
          (c.type === CONTENT_TYPES.CHANNEL || c.type === CONTENT_TYPES.LIVE) &&
          !c.id?.startsWith('u7d-') &&
          c.pluginId !== 'fctv' && c.pluginId !== 'dlive'
        )
        const u7dCatalogs = allCatalogs.filter(c => c.id?.startsWith('u7d-'))
        if (cancelled) return
        setTvCatalogs(channelCatalogs)
        setU7dCatalogs(u7dCatalogs)
        setTvPlugins(installed.filter(p => p.id !== 'fctv' && p.id !== 'dlive' && (p.manifest.types?.includes(CONTENT_TYPES.CHANNEL) || p.manifest.types?.includes(CONTENT_TYPES.LIVE))))
        if (channelCatalogs.length === 0) {
          setError(t('live.no_plugins'))
          setLoading(false)
          return
        }

        // Load catalogs: TDT Spain first (fast), others in parallel
        const tdtCatalogs = channelCatalogs.filter(c => c.pluginId === 'tdtspain')
        const otherCatalogs = channelCatalogs.filter(c => c.pluginId !== 'tdtspain')

        const firstCat = tdtCatalogs[0] || otherCatalogs[0] || channelCatalogs[0]
        setActiveCat(firstCat)
        const firstItems = await pluginManager.getCatalogContent(firstCat.pluginId, firstCat.id, firstCat.type, 0, 500)
        if (cancelled) return
        const loadedAll = firstItems.map(item => ({ ...item, pluginId: firstCat.pluginId }))
        setAllChannels(loadedAll)
        setLoading(false) // TDT Spain visible, stop loading spinner

        // Load remaining catalogs in parallel
        const otherRest = [...tdtCatalogs.slice(1), ...otherCatalogs]
        if (otherRest.length > 0) {
          Promise.all(otherRest.map(cat =>
            pluginManager.getCatalogContent(cat.pluginId, cat.id, cat.type, 0, 500)
              .then(items => ({ cat, items }))
              .catch(() => null)
          )).then(results => {
            if (cancelled) return
            const more = []
            const existingNames = new Set(loadedAll.map(item => normalizeChannelName(item.name)))
            for (const r of results) {
              if (!r) continue
              for (const item of r.items) {
                const n = normalizeChannelName(item.name)
                if (existingNames.has(n)) continue
                existingNames.add(n)
                more.push({ ...item, pluginId: r.cat.pluginId })
              }
            }
            if (more.length) setAllChannels(prev => [...prev, ...more])
          })
        }

      } catch (e) {
        if (cancelled) return
        console.error('[LiveTV] error', e)
        setError(t('live.load_error') + ': ' + (e.message || 'unknown'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!activeCat) return
    let cancelled = false
    const load = async () => {
      // No mostrar spinner si ya hay canales (recarga silenciosa tras el
      // primer render o al cambiar de catálogo con cache caliente).
      if (channels.length === 0) setLoading(true)
      try {
        const items = await pluginManager.getCatalogContent(activeCat.pluginId, activeCat.id, activeCat.type, 0, 500)
        if (!cancelled) setChannels(items.map(item => ({ ...item, pluginId: activeCat.pluginId })))
      } catch (e) {
        if (cancelled) return
        console.error('[LiveTV] load channel error', e)
        setError(t('live.load_error') + ': ' + (e.message || 'unknown'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCat])

  useEffect(() => {
    if (viewMode !== 'epg') return
    let cancelled = false
    const load = async () => {
      try {
        console.log('[LiveTV] Loading EPG for', selectedDate)
        const epgPrograms = await pluginManager.getEpg(selectedDate)
        console.log('[LiveTV] EPG loaded:', epgPrograms.length, 'programs')
        if (!cancelled) setPrograms(epgPrograms)
      } catch (e) {
        if (!cancelled) console.error('[LiveTV] EPG error', e)
      }
    }
    load()
    return () => { cancelled = true }
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
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        // Load programs for the selected channel only
        if (u7dCatalogs.length > 0) {
          const cat = u7dCatalogs[0]
          const chKey = u7dSelectedChannel.channelId || String(u7dSelectedChannel.id || '').replace(/^u7d-channel-/, '')
          const allItems = await pluginManager.getCatalogContent(cat.pluginId, `u7d-programs-${chKey}`, cat.type, 0, 500)
          if (cancelled) return
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
        if (cancelled) return
        console.error('[LiveTV] U7D error', e)
        setU7dItems([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [viewMode, u7dSelectedChannel, u7dSelectedDay, u7dCatalogs])

  const [playing, setPlaying] = useState(null) // { stream, channel }

  // Mientras se ve un canal en directo, refrescar la lista cada minuto:
  // getCatalogContent re-normaliza now/next contra el EPG cacheado (TTL 1h,
  // sin red salvo que venza el caché) y el cambio de `channels` dispara
  // setChannels en el player nativo → el OSD actualiza el programa, sus
  // horarios y la barra de progreso al cruzar un cambio de programa,
  // sin reiniciar el stream.
  useEffect(() => {
    if (!playing || playing.isU7d || !activeCat) return
    let cancelled = false
    const refresh = async () => {
      try {
        const items = await pluginManager.getCatalogContent(activeCat.pluginId, activeCat.id, activeCat.type, 0, 500)
        if (cancelled) return
        const fresh = items.map(item => ({ ...item, pluginId: activeCat.pluginId }))
        setChannels(fresh)
        // El canal que suena también lleva su EPG en meta (OSD del fallback
        // web y arranques posteriores) — actualizarlo con la lista fresca.
        setPlaying(p => {
          if (!p) return p
          const cur = fresh.find(c => c.id === p.channel.id)
          return cur ? { ...p, channel: cur } : p
        })
      } catch (e) {
        if (!cancelled) console.warn('[LiveTV] EPG refresh failed:', e?.message || e)
      }
    }
    const timer = setInterval(refresh, 60_000)
    return () => { cancelled = true; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing?.stream, playing?.isU7d, activeCat])

  const currentChannelRef = useRef(null) // track current channel for history on close
  const playRequestRef = useRef(0)
  const playAbortRef = useRef(null)

  useEffect(() => () => {
    playRequestRef.current++
    playAbortRef.current?.abort()
  }, [])

  const [resolvingChannel, setResolvingChannel] = useState(null)

  const handlePlayChannel = async (channel) => {
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
    // Reproducción directa: resolver el stream y abrir el player sin pasar
    // por la página de detalles (igual que hace U7D al instante).
    console.log('[LiveTV] handlePlayChannel called for:', channel.name, 'id:', channel.id)
    setError('')
    setResolvingChannel(channel.id)
    playAbortRef.current?.abort()
    const ctrl = new AbortController()
    playAbortRef.current = ctrl
    const requestId = ++playRequestRef.current
    try {
      const streams = await pluginManager.getStreams(channel.type, channel.id, channel.name, ctrl.signal)
      if (requestId !== playRequestRef.current || ctrl.signal.aborted) return
      const stream = streams?.[0]
      if (stream) {
        // No guardar en historial aquí — solo se guarda al cerrar el player.
        console.log('[LiveTV] setPlaying called for:', channel.name)
        setPlaying({ stream, channel, isU7d: channel.id?.startsWith('u7d-') || !!channel.isU7d })
        currentChannelRef.current = channel
      } else {
        setError(t('live.load_error') + ': sin stream')
      }
    } catch (e) {
      if (!ctrl.signal.aborted && requestId === playRequestRef.current) {
        setError(t('live.load_error') + ': ' + (e?.message || 'error'))
      }
    } finally {
      if (requestId === playRequestRef.current) setResolvingChannel(null)
    }
  }

  // Zapping nativo: el player emite 'channelZap' con el índice destino; aquí se
  // resuelve el stream y se hace switchChannel sin cerrar el diálogo.
  // IMPORTANTE: no hacer setPlaying — re-dispararía el efecto de VideoPlayer
  // y reabriría el player completo.
  const channelsRef = useRef([])
  channelsRef.current = channels
  // Zapping "último gana": si llega un zap mientras se resuelve otro, la
  // resolución anterior se aborta y solo se aplica el último canal pedido.
  // El bucle serializa los switchChannel para no solapar cambios de stream.
  const zappingLockRef = useRef(false)
  const zapAbortRef = useRef(null)
  const pendingZapRef = useRef(null)
  const handleZapChannel = useCallback(async (event) => {
    console.log('[LiveTV] channelZap event:', event.index, event.name)
    const ch = channelsRef.current[event.index]
    if (!ch) {
      console.warn('[LiveTV] No channel at index', event.index, 'channels:', channelsRef.current.length)
      return
    }
    pendingZapRef.current = { ch, index: event.index }
    if (zappingLockRef.current) {
      // Hay un zap en curso: se aborta su resolución y el bucle recogerá
      // este canal al terminar (pendingZap siempre guarda el último).
      zapAbortRef.current?.abort()
      return
    }
    zappingLockRef.current = true
    try {
      while (pendingZapRef.current) {
        const { ch: target, index } = pendingZapRef.current
        pendingZapRef.current = null
        // No guardar al historial en cada zap — solo se guarda el último canal
        // al cerrar el player (onClose abajo).
        currentChannelRef.current = target
        const ctrl = new AbortController()
        zapAbortRef.current = ctrl
        try {
          console.log('[LiveTV] Resolving stream for channel:', target.name, 'type:', target.type, 'id:', target.id)
          const streams = await pluginManager.getStreams(target.type, target.id, target.name, ctrl.signal)
          if (ctrl.signal.aborted) continue
          const stream = streams?.[0]
          if (stream?.url) {
            console.log('[LiveTV] switchChannel to:', urlHost(stream.url))
            await switchChannel({
              url: stream.url,
              streamType: stream.streamType || 'hls',
              direct: stream.direct === true,
              headers: stream.headers || {},
              title: target.name,
              channelIndex: index,
              epgNow: target.nowPlaying || '',
              epgNext: target.nextPlaying || '',
              epgStart: target.nowPlayingStart || 0,
              epgEnd: target.nowPlayingEnd || 0,
            })
          } else {
            console.warn('[LiveTV] No stream found for channel:', target.name)
          }
        } catch (e) {
          if (!ctrl.signal.aborted) console.error('[LiveTV] Zap failed:', e)
        }
      }
    } finally {
      zapAbortRef.current = null
      zappingLockRef.current = false
    }
  }, [])

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
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <LogoLoader size={80} />
        <p className="text-white/70 text-sm">Verificando canales activos…</p>
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
      {playing && (
        <VideoPlayer
          mode={playing.isU7d ? 'vod' : 'live'}
          stream={playing.stream}
          title={playing.channel.name}
          meta={{ id: playing.channel.id, type: 'live', name: playing.channel.name, poster: playing.channel.logo, epgNow: playing.channel.nowPlaying || '', epgNext: playing.channel.nextPlaying || '', epgStart: playing.channel.nowPlayingStart || 0, epgEnd: playing.channel.nowPlayingEnd || 0 }}
          channels={playing.isU7d ? null : channels}
          channelIndex={playing.isU7d ? -1 : channels.findIndex(c => c.id === playing.channel.id)}
          onZapChannel={playing.isU7d ? null : handleZapChannel}
          onClose={() => {
            // Save last channel to "Continuar viendo" on close — this is
            // the ONLY place live channels are added to history, so zapping
            // through many channels never pollutes the history.
            console.log('[LiveTV] onClose called, currentChannel:', currentChannelRef.current?.name)
            playRequestRef.current++
            playAbortRef.current?.abort()
            zapAbortRef.current?.abort()
            pendingZapRef.current = null
            const ch = currentChannelRef.current
            if (ch) {
              addToHistory({
                id: ch.id,
                type: 'live',
                name: ch.name,
                poster: ch.logo || ch.poster || '',
                server: ch.group || ch.pluginName || '',
              })
            }
            setPlaying(null)
            console.log('[LiveTV] setPlaying(null) called from onClose')
          }}
        />
      )}
      {resolvingChannel && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center">
          <OctoLoader size={56} className="text-primary-400" />
        </div>
      )}
      {/* En Android TV: tabs centrados debajo del título; en el resto,
          título a la izquierda y tabs a la derecha. */}
      <div className={`flex flex-col gap-3 sm:gap-4 ${isAndroidTv() ? 'sm:items-center' : 'sm:flex-row sm:items-center sm:justify-between'}`}>
        <div className={`flex items-center gap-3 ${isAndroidTv() ? 'self-start' : ''}`}>
          <Tv className="text-primary-500 flex-shrink-0" size={32} />
          <h1 className="text-3xl font-bold text-white">{t('live.title')}</h1>
        </div>
        <div data-tv-row className="flex items-center gap-1 bg-dark-800 rounded-lg p-1 w-full sm:w-auto overflow-x-auto">
          <button
            onClick={() => setViewMode('grid')}
            tabIndex={0}
            data-tv-card
            className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'grid' ? 'bg-primary-600 text-white' : 'text-dark-300 hover:text-white'}`}
          >
            <LayoutGrid size={16} />
            Canales
          </button>
          <button
            onClick={() => setViewMode('epg')}
            tabIndex={0}
            data-tv-card
            className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'epg' ? 'bg-primary-600 text-white' : 'text-dark-300 hover:text-white'}`}
          >
            <Calendar size={16} />
            Guía EPG
          </button>
          {u7dCatalogs.length > 0 && (
            <button
              onClick={() => setViewMode('u7d')}
              tabIndex={0}
              data-tv-card
              className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'u7d' ? 'bg-primary-600 text-white' : 'text-dark-300 hover:text-white'}`}
            >
              <Clock size={16} />
              7 Días
            </button>
          )}
        </div>
      </div>

      {viewMode === 'grid' ? (
        <>
          <div data-tv-row className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin">
            {tvCatalogs.map(cat => (
              <button
                key={cat.id}
                tabIndex={0}
                data-tv-card
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
                data-tv-card
                className="px-3 py-1.5 rounded-full text-sm whitespace-nowrap bg-primary-600/20 text-primary-400 hover:bg-primary-600/30 transition-colors flex items-center gap-1"
              >
                <ArrowLeft size={14} /> Volver a grupos
              </button>
            )}
          </div>

          <div data-tv-grid className="media-card-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4" onFocus={channelsWindow.onFocusNearEnd}>
            {channelsWindow.visible.map((channel, wIdx) => (
              <button
                key={channel.id}
                tabIndex={0}
                data-tv-card
                data-windex={wIdx}
                onClick={() => handlePlayChannel(channel)}
                className="card group p-4 flex flex-col items-center gap-3 text-center"
              >
                {channel.logo ? (
                  <img src={channel.logo} alt={channel.name} loading="lazy" className="w-12 h-12 object-contain rounded bg-white/10" />
                ) : (
                  <div className="w-12 h-12 bg-primary-600/20 rounded-lg flex items-center justify-center">
                    <Tv className="text-primary-400" size={24} />
                  </div>
                )}
                <div className="w-full min-w-0">
                  <p className="text-white font-medium text-sm truncate">{channel.name}</p>
                  {channel.nowPlaying ? (
                    <p className="text-primary-400 text-xs mt-1 line-clamp-2 flex items-start gap-1">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 mt-1 flex-shrink-0 animate-pulse" />
                      <span className="truncate">{channel.nowPlaying}</span>
                    </p>
                  ) : (
                    <p className="text-dark-500 text-xs mt-1">Sin información</p>
                  )}
                  <p className="text-primary-400 text-xs flex items-center justify-center gap-1 mt-1">
                    <Play size={10} /> Ver ahora
                  </p>
                </div>
              </button>
            ))}
            {channelsWindow.hasMore && <div ref={channelsWindow.sentinelRef} className="h-1 col-span-full" />}
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
              <div data-tv-grid className="media-card-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                {u7dChannels.map(ch => (
                  <button
                    key={ch.id}
                    onClick={() => { setU7dSelectedChannel(ch); setU7dSelectedDay(null); setU7dItems([]) }}
                    data-tv-card
                    className="card group p-4 flex flex-col items-center gap-3 text-center"
                  >
                    {ch.logo ? (
                      <img src={ch.logo} alt={ch.name} loading="lazy" className="w-12 h-12 object-contain rounded bg-white/10" />
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
              <div data-tv-row className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin">
                {getLast7Days().map(day => (
                  <button
                    key={day.value}
                    onClick={() => setU7dSelectedDay(day.value)}
                    data-tv-card
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
                  <LogoLoader size={80} />
                </div>
              ) : u7dItems.length === 0 ? (
                <div className="flex items-center justify-center min-h-[40vh]">
                  <p className="text-dark-400">No hay contenido disponible para este día</p>
                </div>
              ) : (
                <div data-tv-grid className="media-card-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                  {u7dItems.map(item => {
                    const ts = item.startTimestamp || (item.startTime ? new Date(item.startTime).getTime() / 1000 : 0)
                    const timeStr = ts ? new Date(ts * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : ''
                    const isFree = item.isFree
                    const hasVod = item.hasVod
                    return (
                      <button
                        key={item.id}
                        onClick={() => handlePlayChannel(item)}
                        data-tv-card
                        className="card group p-3 flex flex-col gap-2 text-left"
                      >
                        <div className="w-full aspect-video bg-primary-600/20 rounded-lg flex items-center justify-center relative overflow-hidden">
                          <Tv className="text-primary-400 absolute" size={32} />
                          {item.poster && (
                            <img
                              src={item.poster}
                              alt={item.title}
                              className="absolute inset-0 w-full h-full object-cover"
                              loading="lazy"
                              onError={(e) => { e.currentTarget.style.display = 'none' }}
                            />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            {timeStr && <span className="text-dark-500 text-xs">{timeStr}</span>}
                            {hasVod && isFree && <span className="text-[10px] bg-green-600/30 text-green-400 px-1 rounded">GRATIS</span>}
                            {hasVod && !isFree && <span className="text-[10px] bg-orange-600/30 text-orange-400 px-1 rounded">PAGO</span>}
                            {!hasVod && <span className="text-[10px] bg-dark-600 text-dark-400 px-1 rounded">SIN VOD</span>}
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
