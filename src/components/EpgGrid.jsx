import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { ChevronLeft, ChevronRight, Play, Tv } from 'lucide-react'

const HOURS_VISIBLE = 4
const MINUTE_WIDTH = 3

function formatTime(date) {
  return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
}

function timeToMinutes(date, baseDate) {
  return (date.getTime() - baseDate.getTime()) / 60000
}

export default function EpgGrid({ channels, programs, onPlayChannel, selectedDate, onDateChange }) {
  const { t } = useTranslation()
  const scrollRef = useRef(null)
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!scrollRef.current) return
    const startMinutes = timeToMinutes(now, selectedDate)
    scrollRef.current.scrollLeft = Math.max(0, startMinutes * MINUTE_WIDTH - 100)
  }, [selectedDate, now])

  const startHour = 0
  const endHour = 24
  const totalMinutes = (endHour - startHour) * 60

  const grouped = {}
  const channelMap = new Map()
  channels.forEach(ch => {
    grouped[ch.id] = []
    channelMap.set(ch.id, ch)
  })
  // Añadir canales que tienen programas EPG pero no están en la lista de canales
  programs.forEach(p => {
    if (!grouped[p.channelId]) {
      grouped[p.channelId] = []
      channelMap.set(p.channelId, {
        id: p.channelId,
        name: p.channelName || p.channelId,
        logo: p.logo || '',
      })
    }
    grouped[p.channelId].push(p)
  })

  // Solo mostrar canales que tienen programas
  const channelsWithPrograms = Array.from(channelMap.values()).filter(ch => grouped[ch.id]?.length > 0)

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
            style={{ left: 160 + timeToMinutes(now, selectedDate) * MINUTE_WIDTH }}
          >
            <div className="bg-primary-500 text-white text-[10px] px-1.5 py-0.5 rounded -translate-x-1/2 -mt-6 whitespace-nowrap">
              Ahora
            </div>
          </div>

          {/* Channels and programs */}
          <div>
          {channelsWithPrograms.map(channel => (
              <div key={channel.id} className="flex border-b border-dark-700/30 min-h-[72px]">
                <div className="flex-shrink-0 w-40 p-3 border-r border-dark-700/50 flex items-center gap-3 bg-dark-800/50 sticky left-0 z-10">
                  {channel.logo ? (
                    <img src={channel.logo} alt={channel.name} className="w-8 h-8 object-contain rounded bg-white/10" />
                  ) : (
                    <div className="w-8 h-8 bg-primary-600/20 rounded flex items-center justify-center"><Tv size={14} className="text-primary-400" /></div>
                  )}
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium truncate">{channel.name}</p>
                    <button onClick={() => onPlayChannel(channel)} className="text-primary-400 text-xs flex items-center gap-1 hover:text-primary-300">
                      <Play size={10} /> Ver
                    </button>
                  </div>
                </div>

                <div className="relative flex-1" style={{ width: totalMinutes * MINUTE_WIDTH }}>
                  {grouped[channel.id]?.map(program => {
                    const start = new Date(program.start)
                    const end = new Date(program.end)
                    const startMin = Math.max(0, timeToMinutes(start, selectedDate))
                    const endMin = Math.min(totalMinutes, timeToMinutes(end, selectedDate))
                    const width = Math.max(0, (endMin - startMin) * MINUTE_WIDTH)
                    if (width <= 0) return null

                    const isCurrent = now >= start && now < end
                    return (
                      <div
                        key={program.id}
                        className={`absolute top-2 bottom-2 rounded-lg px-2 py-1 text-xs border cursor-pointer transition-colors overflow-hidden ${
                          isCurrent
                            ? 'bg-primary-600/30 border-primary-500/50 text-white'
                            : 'bg-dark-700/50 border-dark-600/50 text-dark-300 hover:bg-dark-700'
                        }`}
                        style={{ left: startMin * MINUTE_WIDTH, width }}
                        onClick={() => onPlayChannel(channel)}
                        title={program.description}
                      >
                        <p className="font-medium truncate">{program.title}</p>
                        <p className="text-[10px] opacity-70">{formatTime(start)} - {formatTime(end)}</p>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
