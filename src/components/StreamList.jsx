import { useEffect, useState } from 'react'
import { Server, Play, Download, Zap, Hourglass, Users } from 'lucide-react'
import { parseStreamLang, parseStreamQuality, qualityColorClass, langColorClass, langFlag, getLangPrioritySaved, isDownloadableDirect } from '../utils/streamMeta.js'
import { subscribeDebridJobs, getDebridJob } from '../utils/debridJobs.js'
import { isAlldebridEnabled, hasAnyDebrid } from '../plugins/bundled/alldebrid.js'

// Re-render cuando cambia el progreso de los magnets en cola de AllDebrid.
function useDebridJobsTick() {
  const [, setTick] = useState(0)
  useEffect(() => subscribeDebridJobs(() => setTick(t => t + 1)), [])
}

// Lista de fuentes de un contenido/episodio. Estaba duplicada dos veces en
// Details.jsx (fuentes de película y de episodio): layout grid cuando hay
// más de 6 enlaces, lista completa si no.
export default function StreamList({ streams, onPlay, onDownload, disabled = false }) {
  useDebridJobsTick()
  // Filtros de la lista (persisten entre fichas): idioma preferido,
  // solo listos en debrid, y solo fuentes con seeders.
  const FILTERS_KEY = 'octostream_stream_filters'
  const [filters, setFilters] = useState(() => {
    try { return JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}') || {} } catch { return {} }
  })
  if (!streams?.length) return null
  // Entradas "processing" (debrid descargando el magnet): atenuadas con
  // su título, pero PULSABLES — tocar una envía el magnet al debrid para
  // ponerla a descargar. Pasan a reproducibles cuando termina (Details
  // re-pide la lista periódicamente).
  // Orden: idioma preferido primero (la prioridad de Ajustes) y a igual
  // idioma, más seeders. Los sin idioma quedan al final.
  const langRank = (s) => {
    const l = parseStreamLang(s)
    const i = l ? getLangPrioritySaved().indexOf(l) : -1
    return i === -1 ? 99 : i
  }
  const bySeeds = (a, b) => (b.seeds || 0) - (a.seeds || 0)
  const byLangSeeds = (a, b) => langRank(a) - langRank(b) || bySeeds(a, b)
  const qualityRank = (s) => {
    const q = parseStreamQuality(s)
    return ({ '4K': 4, '2160P': 4, '1080P': 3, '720P': 2, '480P': 1 })[q] || 0
  }
  const comparators = {
    language: byLangSeeds,
    seeds: bySeeds,
    quality: (a, b) => qualityRank(b) - qualityRank(a) || bySeeds(a, b),
    cached: (a, b) => Number(b.cached === true) - Number(a.cached === true) || byLangSeeds(a, b),
  }
  const sortMode = comparators[filters.sort] ? filters.sort : 'language'
  const toggleFilter = (k) => setFilters(f => {
    const next = { ...f, [k]: !f[k] }
    try { localStorage.setItem(FILTERS_KEY, JSON.stringify(next)) } catch { /* sin storage */ }
    return next
  })
  const prefLang = (() => {
    try { return (JSON.parse(localStorage.getItem('octostream_lang_priority') || '[]')[0]) || 'ESP' } catch { return 'ESP' }
  })()
  const applyFilters = (list) => list.filter(s => {
    if (filters.lang && parseStreamLang(s) !== prefLang) return false
    if (filters.ready && s.cached !== true && !s.processing) return false
    if (filters.seeds && !(s.seeds > 0)) return false
    return true
  })
  // Sin debrid configurado ni AIOStreams, nada de su mundo aparece:
  // entradas "procesándose" (no se pueden descargar) y enlaces
  // streamType 'debrid' (no se pueden desbloquear sin clave AllDebrid).
  const canDebrid = hasAnyDebrid()
  const canUnlock = isAlldebridEnabled()
  const playable = applyFilters(streams
    .filter(s => !s.processing && (canUnlock || s.streamType !== 'debrid'))
    .sort(comparators[sortMode]))
  const processing = canDebrid ? applyFilters(streams.filter(s => s.processing).sort(comparators[sortMode])) : []
  const chip = (k, label) => (
    <button
      key={k}
      onClick={() => toggleFilter(k)}
      className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
        filters[k] ? 'bg-primary-600 text-white' : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
      }`}
    >{label}</button>
  )
  const filterChips = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-dark-500">Filtrar:</span>
      {chip('lang', `${langFlag(prefLang)} ${prefLang}`)}
      {canDebrid && chip('ready', '⚡ Cacheados')}
      {chip('seeds', '👥 Con seeds')}
      <label className="ml-auto flex items-center gap-2 text-xs text-dark-400">
        Ordenar
        <select
          value={sortMode}
          onChange={e => setFilters(f => {
            const next = { ...f, sort: e.target.value }
            try { localStorage.setItem(FILTERS_KEY, JSON.stringify(next)) } catch { /* storage lleno */ }
            return next
          })}
          className="rounded-lg border border-dark-700 bg-dark-800 px-2 py-1.5 text-sm text-white focus:border-primary-500 focus:outline-none"
          aria-label="Ordenar fuentes"
        >
          <option value="language">Idioma y seeds</option>
          <option value="seeds">Más seeds</option>
          <option value="cached">Cacheados primero</option>
          <option value="quality">Calidad y seeds</option>
        </select>
      </label>
    </div>
  )
  // Progreso real de AllDebrid cuando el magnet está en la cola (subido
  // por la app o por la propia instancia AIOStreams).
  const procStatus = (s) => {
    const job = s._infoHash ? getDebridJob(s._infoHash) : null
    if (job?.status === 'ready') return { text: 'Listo — pulsa para reproducir', cls: 'text-emerald-400', ready: true }
    if (job) return { text: `Descargando — ${job.progress}%`, cls: 'text-amber-400/80', pct: job.progress }
    return { text: 'Pulsar para descargar en debrid', cls: 'text-amber-400/80', pct: null }
  }
  const processingCell = (s, i) => {
    const st = procStatus(s)
    return (
    <div
      key={`p${i}`}
      tabIndex={0}
      data-tv-item
      role="button"
      className="flex flex-col gap-1.5 bg-dark-800/50 rounded-lg p-3 opacity-70 hover:opacity-100 hover:bg-dark-700 transition-opacity cursor-pointer"
      title="No lista aún — pulsa para ponerla a descargar en debrid"
      onClick={() => onPlay(s)}
      onKeyDown={e => keyHandler(e, s)}
    >
      <div className="flex items-center gap-2">
        <span className={`${st.ready ? 'text-emerald-400' : 'text-amber-400'} flex-shrink-0`}>
          {st.ready ? <Zap size={14} /> : <Hourglass size={14} />}
        </span>
        {langFlag(parseStreamLang(s)) && (
          <span className={`text-sm font-bold ${langColorClass(parseStreamLang(s))} flex-shrink-0`}>
            {langFlag(parseStreamLang(s))} {parseStreamLang(s)}
          </span>
        )}
        {s.quality && (
          <span className={`text-xs ${qualityColorClass(s.quality)} text-white px-1.5 py-0.5 rounded font-bold flex-shrink-0`}>{s.quality}</span>
        )}
        {s.seeds > 0 && (
          <span className="flex items-center gap-0.5 text-xs text-emerald-400/90 flex-shrink-0" title="Semillas compartiendo el torrent">
            <Users size={12} />{s.seeds}
          </span>
        )}
      </div>
      <span className="text-white text-xs font-medium truncate">{s.name || s.releaseTitle || ''}</span>
      <div className={`flex items-center gap-1 text-xs ${st.cls}`}>
        <Download size={12} className="flex-shrink-0" />
        <span className="truncate">{st.text}</span>
      </div>
      {st.pct != null && (
        <div className="h-1 rounded bg-dark-700 overflow-hidden">
          <div className="h-full bg-amber-400 transition-all" style={{ width: `${st.pct}%` }} />
        </div>
      )}
    </div>
    )
  }
  const dim = disabled ? 'opacity-50 pointer-events-none' : ''
  const keyHandler = (e, stream) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPlay(stream) }
  }

  if (playable.length > 6) {
    return (
      <div>
        {filterChips}
      <div data-tv-list className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {playable.map((stream, i) => {
          const quality = parseStreamQuality(stream)
          const lang = parseStreamLang(stream)
          return (
            <button
              key={i}
              tabIndex={0}
              data-tv-item
              role="button"
              className={`flex flex-col gap-1.5 bg-dark-800 rounded-lg p-3 hover:bg-dark-700 transition-colors cursor-pointer text-left ${dim}`}
              onClick={() => onPlay(stream)}
              onKeyDown={e => keyHandler(e, stream)}
            >
              <div className="flex items-center gap-2">
                {lang && (
                  <span className={`text-sm font-bold ${langColorClass(lang)} flex-shrink-0`}>{langFlag(lang)} {lang}</span>
                )}
                {stream.cached === true && (
                  <span className="text-emerald-400 flex-shrink-0" title="Cacheado en debrid"><Zap size={14} /></span>
                )}
                {stream.cached === false && (
                  <span className="text-amber-400 flex-shrink-0" title="No cacheado — el debrid lo descarga al reproducir"><Hourglass size={14} /></span>
                )}
                {quality && (
                  <span className={`text-xs ${qualityColorClass(quality)} text-white px-1.5 py-0.5 rounded font-bold flex-shrink-0`}>{quality}</span>
                )}
                {stream.seeds > 0 && (
                  <span className="flex items-center gap-0.5 text-xs text-emerald-400/90 flex-shrink-0" title="Semillas compartiendo el torrent">
                    <Users size={12} />{stream.seeds}
                  </span>
                )}
                {!quality && !lang && (
                  <span className="text-sm text-dark-400 font-medium">HD</span>
                )}
              </div>
              <span className="text-white text-xs font-medium truncate">{stream.name || ''}</span>
              <div className="flex items-center gap-1 text-xs text-dark-400">
                <Server size={12} className="flex-shrink-0" />
                <span className="truncate">{stream.server || stream.pluginName}</span>
              </div>
            </button>
          )
        })}
        {processing.map(processingCell)}
      </div>
      </div>
    )
  }

  return (
    <div>
      {filterChips}
    <div data-tv-list className="space-y-2">
      {playable.map((stream, i) => {
        const quality = parseStreamQuality(stream)
        const lang = parseStreamLang(stream)
        return (
          <div
            key={i}
            tabIndex={0}
            data-tv-item
            role="button"
            className={`flex items-center gap-3 bg-dark-800 rounded-lg p-4 hover:bg-dark-700 transition-colors cursor-pointer ${dim}`}
            onClick={() => onPlay(stream)}
            onKeyDown={e => keyHandler(e, stream)}
          >
            {lang && (
              <span className={`text-sm font-bold ${langColorClass(lang)} w-16 text-center flex-shrink-0`}>{langFlag(lang)} {lang}</span>
            )}
            {stream.pluginName === 'AIOStreams' && (
              <span className="text-xs bg-violet-600 text-white px-2 py-1 rounded font-bold flex-shrink-0">AIO</span>
            )}
            {/\(debrid\)/i.test(stream.server || stream.name || '') || stream.viaDebrid ? (
              <span className="text-xs bg-emerald-600 text-white px-2 py-1 rounded font-bold flex-shrink-0">DEBRID</span>
            ) : /\(p2p\)/i.test(stream.server || '') ? (
              <span className="text-xs bg-amber-600 text-white px-2 py-1 rounded font-bold flex-shrink-0">P2P</span>
            ) : null}
            {stream.cached === true && (
              <span className="bg-emerald-700 text-white px-1.5 py-1 rounded flex-shrink-0" title="Cacheado en debrid — reproduce al instante"><Zap size={14} /></span>
            )}
            {stream.cached === false && (
              <span className="bg-amber-700 text-white px-1.5 py-1 rounded flex-shrink-0" title="No cacheado — el debrid empieza a descargarlo al reproducir"><Hourglass size={14} /></span>
            )}
            {quality && (
              <span className={`text-xs ${qualityColorClass(quality)} text-white px-2 py-1 rounded font-bold flex-shrink-0`}>{quality}</span>
            )}
            {stream.seeds > 0 && (
              <span className="flex items-center gap-1 text-xs text-emerald-400/90 px-1.5 py-1 rounded flex-shrink-0" title="Semillas compartiendo el torrent">
                <Users size={14} />{stream.seeds}
              </span>
            )}
            {!quality && !lang && (
              <span className="text-sm text-dark-400 font-medium w-12 text-center flex-shrink-0">HD</span>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">{stream.name}</p>
              <p className="text-xs text-dark-400 truncate">{stream.channelName || stream.server || stream.pluginName}</p>
            </div>
            {onDownload && (stream.streamType === 'torrent' || isDownloadableDirect(stream)) && (
              <button
                tabIndex={0}
                className="p-2 text-dark-400 hover:text-primary-400 transition-colors flex-shrink-0"
                title="Descargar para ver sin conexión"
                onClick={e => { e.stopPropagation(); onDownload(stream) }}
                onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onDownload(stream) } }}
              >
                <Download size={18} />
              </button>
            )}
            <Play size={20} className="text-dark-400 flex-shrink-0" />
          </div>
        )
      })}
      {processing.map((s, i) => {
        const st = procStatus(s)
        return (
        <div
          key={`p${i}`}
          tabIndex={0}
          data-tv-item
          role="button"
          className="flex items-center gap-3 bg-dark-800/50 rounded-lg p-4 opacity-70 hover:opacity-100 hover:bg-dark-700 transition-opacity cursor-pointer"
          title="No lista aún — pulsa para ponerla a descargar en debrid"
          onClick={() => onPlay(s)}
          onKeyDown={e => keyHandler(e, s)}
        >
          <span className={`${st.ready ? 'text-emerald-400' : 'text-amber-400'} flex-shrink-0`}>
            {st.ready ? <Zap size={18} /> : <Hourglass size={18} />}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-medium truncate">{s.name || s.releaseTitle}</p>
            <p className={`text-xs ${st.cls} truncate`}>{s.channelName || s.server || 'AIOStreams'} · {st.text}</p>
            {st.pct != null && (
              <div className="h-1 mt-1.5 rounded bg-dark-700 overflow-hidden">
                <div className="h-full bg-amber-400 transition-all" style={{ width: `${st.pct}%` }} />
              </div>
            )}
          </div>
        </div>
        )
      })}
    </div>
    </div>
  )
}
