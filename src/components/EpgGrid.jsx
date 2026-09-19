import { useEffect, useRef, useState, useMemo } from 'react'
import { useWindowedList } from '../hooks/useWindowedList.js'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from '../i18n/index.js'
import { pluginManager } from '../plugins/manager.js'
import { ChevronLeft, ChevronRight, Play, Tv } from 'lucide-react'
import OctoLoader from './OctoLoader.jsx'

const MINUTE_WIDTH = 3

function formatTime(date) {
  return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
}

function timeToMinutes(date, baseDate) {
  return (date.getTime() - baseDate.getTime()) / 60000
}

export default function EpgGrid({ channels, programs, onPlayChannel, selectedDate, onDateChange }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const scrollRef = useRef(null)
  const [now, setNow] = useState(new Date())
  const [notice, setNotice] = useState(null) // { text, loading }
  const noticeTimer = useRef(null)

  const showNotice = (text, ms = 3500) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice({ text })
    noticeTimer.current = setTimeout(() => setNotice(null), ms)
  }

  // Click en un programa de la guía:
  // - En emisión → reproducir el canal en directo.
  // - Futuro → aviso "todavía no se ha emitido".
  // - Pasado → buscar el programa en Últimos 7 días (U7D) y abrirlo.
  const handleProgramClick = async (channel, program) => {
    const nowDate = new Date()
    const start = new Date(program.start)
    const end = new Date(program.end)

    if (nowDate >= start && nowDate < end) {
      onPlayChannel(channel)
      return
    }
    if (nowDate < start) {
      showNotice('Todavía no se ha emitido')
      return
    }

    // Programa ya emitido → intentar localizarlo en U7D del mismo canal
    setNotice({ text: 'Buscando en Últimos 7 días…', loading: true })
    try {
      const pluginId = program.pluginId || channel.pluginId || 'tdtspain'
      const rawId = String(channel._raw?.id || String(channel.id || '').replace(/^tdtspain-/, ''))
      const rawEpgid = String(channel._raw?.epgid || program.channelId || '')

      const u7dChannels = await pluginManager.getCatalogContent(pluginId, 'u7d-tdtspain', 'live', 0, 200)
      const u7dCh = (u7dChannels || []).find(u => u.channelId === rawId || (rawEpgid && u.channelId === rawEpgid))
      if (!u7dCh) {
        showNotice('Contenido no disponible')
        return
      }

      const progs = await pluginManager.getCatalogContent(pluginId, `u7d-programs-${u7dCh.channelId}`, 'live', 0, 500)
      const epgTs = start.getTime() / 1000

      // Coincidencia por hora de inicio (±15 min por desfases entre EPG y U7D)
      let best = null
      let bestDiff = Infinity
      for (const p of progs || []) {
        const d = Math.abs((p.startTimestamp || 0) - epgTs)
        if (d < bestDiff) { bestDiff = d; best = p }
      }
      if (best && bestDiff <= 900) {
        setNotice(null)
        navigate(`/details/live/${best.id}`, { state: { autoplay: true } })
        return
      }

      // Fallback por título + proximidad horaria (±6 h)
      const q = (program.title || '').toLowerCase().trim()
      if (q) {
        const byTitle = (progs || [])
          .filter(p => {
            const t = String(p.title || p.name || '').toLowerCase().trim()
            return t === q || (t.length > 3 && (t.includes(q) || q.includes(t)))
          })
          .sort((a, b) => Math.abs((a.startTimestamp || 0) - epgTs) - Math.abs((b.startTimestamp || 0) - epgTs))
        if (byTitle.length && Math.abs((byTitle[0].startTimestamp || 0) - epgTs) <= 21600) {
          setNotice(null)
          navigate(`/details/live/${byTitle[0].id}`, { state: { autoplay: true } })
          return
        }
      }

      showNotice('Contenido no disponible en Últimos 7 días')
    } catch {
      showNotice('Contenido no disponible')
    }
  }

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  useEffect(() => {
    if (!scrollRef.current) return
    const dayStart = new Date(selectedDate)
    dayStart.setHours(0, 0, 0, 0)
    // Solo al montar/cambiar de día: con `now` en deps el grid se re-centraba
    // solo cada 60s y pisaba el scroll horizontal del usuario.
    const startMinutes = timeToMinutes(new Date(), dayStart)
    scrollRef.current.scrollLeft = Math.max(0, startMinutes * MINUTE_WIDTH - 100)
  }, [selectedDate])

  const dayStart = new Date(selectedDate)
  dayStart.setHours(0, 0, 0, 0)
  const startHour = 0
  const endHour = 24
  const totalMinutes = (endHour - startHour) * 60

  // Agrupación programas→canal. Memoizada: before recomputaba en cada render
  // (y `now` re-renderiza cada 60s) con una búsqueda O(canales) por programa.
  const { grouped, channelsWithPrograms } = useMemo(() => {
    const grouped = {}
    const channelMap = new Map()
    // Índice channelId-alternativo → channel.id para casar programas O(1)
    const altKeys = new Map()
    channels.forEach(ch => {
      grouped[ch.id] = []
      channelMap.set(ch.id, ch)
      altKeys.set(String(ch._raw?.id || ''), ch.id)
      altKeys.set(String(ch._raw?.epgid || ''), ch.id)
      altKeys.set(String(ch.id || '').replace(/^tdtspain-/, ''), ch.id)
    })
    // Añadir canales que tienen programas EPG pero no están en la lista.
    // Casar p.channelId (raw, p.ej. 'La1.TV') con el canal normalizado
    // ('tdtspain-La1.TV') por _raw.id / epgid / nombre para que la fila use
    // el canal real (con logo, type y _raw) y el click pueda resolver stream.
    const findChannelKey = (p) => {
      if (grouped[p.channelId]) return p.channelId
      return altKeys.get(String(p.channelId)) || null
    }
    programs.forEach(p => {
      const key = findChannelKey(p)
      if (key) {
        grouped[key].push(p)
        return
      }
      grouped[p.channelId] = grouped[p.channelId] || []
      if (!channelMap.has(p.channelId)) {
        channelMap.set(p.channelId, {
          id: p.channelId,
          type: 'live',
          pluginId: p.pluginId || 'tdtspain',
          name: p.channelName || p.channelId,
          logo: p.channelLogo || p.logo || '',
        })
      }
      grouped[p.channelId].push(p)
    })

    // Solo mostrar canales que tienen programas
    const channelsWithPrograms = Array.from(channelMap.values()).filter(ch => grouped[ch.id]?.length > 0)
    return { grouped, channelsWithPrograms }
  }, [channels, programs])

  // Ventana vertical: cientos de canales x ~30 programas cada uno = miles de
  // nodos. Se montan ~20 filas y se expanden al hacer scroll/foco.
  const rowsWindow = useWindowedList(channelsWithPrograms, 20, 20)

  const dateLabel = selectedDate.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' })

  const prevDay = () => {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() - 1)
    onDateChange(d)
  }

  const nextDay = () => {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + 1)
    onDateChange(d)
  }

  return (
    <div className="bg-dark-800/80 backdrop-blur-sm rounded-xl border border-dark-700/50 shadow-lg overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-dark-700/50">
        <div className="flex items-center gap-3">
          <Tv className="text-primary-400" size={22} />
          <h3 className="text-white font-bold">{t('epg.guide_title')}</h3>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={prevDay} className="btn-ghost p-1.5"><ChevronLeft size={18} /></button>
          <span className="text-white text-sm font-medium min-w-[120px] text-center capitalize">{dateLabel}</span>
          <button onClick={nextDay} className="btn-ghost p-1.5"><ChevronRight size={18} /></button>
        </div>
      </div>

      <div className="overflow-x-auto" ref={scrollRef} style={{ scrollbarWidth: 'thin' }}>
        <div className="relative" style={{ minWidth: totalMinutes * MINUTE_WIDTH + 160 }}>
          {/* Header hours */}
          <div className="flex border-b border-dark-700/50 sticky top-0 bg-dark-800/95 z-10" style={{ paddingLeft: 160 }}>
            {Array.from({ length: endHour - startHour }).map((_, i) => {
              const hour = startHour + i
              return (
                <div key={hour} className="flex-shrink-0 border-l border-dark-700/50 text-dark-400 text-xs pl-2 py-2" style={{ width: 60 * MINUTE_WIDTH }}>
                  {hour.toString().padStart(2, '0')}:00
                </div>
              )
            })}
          </div>

          {/* Current time indicator */}
          <div
            className="absolute top-0 bottom-0 w-px bg-primary-500 z-20"
            style={{ left: 160 + timeToMinutes(now, dayStart) * MINUTE_WIDTH }}
          >
            <div className="bg-primary-500 text-white text-[10px] px-1.5 py-0.5 rounded -translate-x-1/2 -mt-6 whitespace-nowrap">
              Ahora
            </div>
          </div>

          {/* Channels and programs — ventana vertical progresiva */}
          <div data-tv-list onFocus={rowsWindow.onFocusNearEnd}>
          {rowsWindow.visible.map((channel, wIdx) => (
              <div key={channel.id} className="flex border-b border-dark-700/30 min-h-[72px]" data-windex={wIdx}>
                <button
                  type="button"
                  data-tv-card
                  data-windex={wIdx}
                  onClick={() => onPlayChannel(channel)}
                  className="epg-channel-cell flex-shrink-0 w-40 p-3 border-r border-dark-700/50 flex items-center gap-3 bg-dark-800 sticky left-0 z-30 text-left cursor-pointer"
                >
                  {channel.logo ? (
                    <img src={channel.logo} alt={channel.name} className="w-8 h-8 object-contain rounded bg-white/10" />
                  ) : (
                    <div className="w-8 h-8 bg-primary-600/20 rounded flex items-center justify-center"><Tv size={14} className="text-primary-400" /></div>
                  )}
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium truncate">{channel.name}</p>
                    <span className="text-primary-400 text-xs flex items-center gap-1">
                      <Play size={10} /> Ver
                    </span>
                  </div>
                </button>

                <div className="relative flex-1" style={{ width: totalMinutes * MINUTE_WIDTH }}>
                  {grouped[channel.id]?.map(program => {
                    const start = new Date(program.start)
                    const end = new Date(program.end)
                    const startMin = Math.max(0, timeToMinutes(start, dayStart))
                    const endMin = Math.min(totalMinutes, timeToMinutes(end, dayStart))
                    const width = Math.max(0, (endMin - startMin) * MINUTE_WIDTH)
                    if (width <= 0) return null

                    const isCurrent = now >= start && now < end
                    const isFuture = now < start
                    return (
                      <button
                        key={program.id}
                        type="button"
                        tabIndex={0}
                        data-tv-item
                        data-windex={wIdx}
                        className={`epg-program absolute top-2 bottom-2 rounded-lg px-2 py-1 text-left text-xs border cursor-pointer transition-colors overflow-hidden ${
                          isCurrent
                            ? 'bg-primary-600/30 border-primary-500/50 text-white'
                            : isFuture
                              ? 'bg-dark-700/30 border-dark-600/30 text-dark-500 hover:bg-dark-700'
                              : 'bg-blue-600/20 border-blue-500/40 text-blue-200 hover:bg-blue-600/30'
                        }`}
                        style={{ left: startMin * MINUTE_WIDTH, width }}
                        onClick={() => handleProgramClick(channel, program)}
                        title={program.description}
                      >
                        <p className="font-medium truncate">{program.title}</p>
                        <p className="text-[10px] opacity-70">{formatTime(start)} - {formatTime(end)}</p>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            {rowsWindow.hasMore && <div ref={rowsWindow.sentinelRef} className="h-1" />}
          </div>
        </div>
      </div>

      {/* Mensaje de estado (búsqueda U7D / avisos) */}
      {notice && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[70] bg-dark-800 border border-dark-600 rounded-lg px-5 py-3 shadow-xl flex items-center gap-3">
          {notice.loading && <OctoLoader size={18} className="text-primary-400" />}
          <span className="text-sm text-white">{notice.text}</span>
        </div>
      )}
    </div>
  )
}
