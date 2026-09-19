import { useEffect, useMemo, useRef, useState, memo } from 'react'
import { pluginManager } from '../plugins/manager.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import LogoLoader from '../components/LogoLoader.jsx'
import { useTranslation } from '../i18n/index.js'
import { Trophy, AlertCircle, ExternalLink, ArrowLeft, Play } from 'lucide-react'
import { MARCA_LEAGUES } from '../data/marcaCalendar.js'
import { teamsMatch, leagueKey } from '../utils/teamMatch.js'
import { enrichLogos, fetchLeagueEvents } from '../utils/sofascore.js'

const SPORTS_PLUGIN = 'fctv'
const DLIVE_PLUGIN = 'dlive'

// Un partido finalizado permanece 5 min marcado FINALIZADO en su liga y
// luego se retira de la lista. Se detecta por transición: era live en la
// carga anterior y ahora ya no lo está (la API lo quita o pierde el stream).
const FINISHED_LINGER_MS = 5 * 60 * 1000
const prevLiveItems = new Map()   // id → { catId, item }
const finishedMatches = new Map() // id → { at, catId, item }

// Snapshot en memoria por pestaña: al volver a un catálogo se pinta al
// instante con lo último conocido y se refresca en segundo plano (stale-
// while-revalidate). Los items ya llegan enriquecidos con escudos.
const catalogSnapshot = new Map() // catId → { items, ts }
const SNAPSHOT_TTL = 10 * 60 * 1000

// Mismo partido = mismo PAR de equipos, sin importar quién figura como local.
// FCTV usa el orden oficial del fixture pero DLive parsea "A vs B" del título
// — cuando el orden difiere, el merge no casaba y el partido salía dos veces
// (el mismo equipo aparecía en "dos partidos diferentes"). Si ambos traen
// fecha y difieren >6h son partidos distintos (ida/vuelta, doble jornada).
const WOMEN_RE = /femenin|feminine|women|ladies/i
const isWomen = (item) => WOMEN_RE.test(item._home?.name || '') ||
  WOMEN_RE.test(item._away?.name || '') || WOMEN_RE.test(item._league?.name || '')

function sameMatch(a, b) {
  const ah = a._home?.name, aa = a._away?.name, bh = b._home?.name, ba = b._away?.name
  if (!ah || !aa || !bh || !ba) return false
  const direct = teamsMatch(ah, bh) && teamsMatch(aa, ba)
  const swapped = teamsMatch(ah, ba) && teamsMatch(aa, bh)
  if (!direct && !swapped) return false
  // "Real Madrid vs Barcelona" y "Real Madrid Femenino vs Barcelona Femení"
  // casan por includes pero son partidos distintos.
  if (isWomen(a) !== isWomen(b)) return false
  if (a._matchDate && b._matchDate && Math.abs(a._matchDate - b._matchDate) > 6 * 3600 * 1000) return false
  return true
}

// Quita duplicados del mismo partido dentro de la lista final (pueden venir
// del propio FCTV con distinto matchId, o de DLive con nombres que casan por
// includes en un sentido pero no en el otro). Gana el primero —FCTV va antes
// que DLive—, heredando lo que el duplicado aporte (links DLive, escudos).
function dedupeMatches(items) {
  const out = []
  for (const item of items) {
    const dup = out.find(o => sameMatch(o, item))
    if (!dup) { out.push(item); continue }
    // El duplicado aporta sus links DLive al item que se queda (puede ser el
    // propio item DLive o un FCTV con _dliveItem ya asignado).
    const dItem = item.pluginId === DLIVE_PLUGIN ? item : item._dliveItem
    if (dItem) {
      if (!dup._dliveItem) {
        dup._dliveItem = dItem
      } else if (Array.isArray(dItem._links) && Array.isArray(dup._dliveItem._links)) {
        const urls = new Set(dup._dliveItem._links.map(l => l.url))
        for (const l of dItem._links) if (!urls.has(l.url)) dup._dliveItem._links.push(l)
      }
    }
    if (!dup._isLive && item._isLive) dup._isLive = true
    for (const side of ['_home', '_away']) {
      if (dup[side] && !dup[side].logo && item[side]?.logo) dup[side].logo = item[side].logo
    }
    if (dup._league && !dup._league.logo && item._league?.logo) dup._league.logo = item._league.logo
    if (!dup._score && item._score) dup._score = item._score
  }
  return out
}

function trackFinished(merged, catId) {
  const now = Date.now()
  const liveIds = new Set()
  for (const i of merged) {
    if (i._isLive) { liveIds.add(i.id); prevLiveItems.set(i.id, { catId, item: i }) }
  }
  for (const [id, prev] of prevLiveItems) {
    if (prev.catId !== catId || liveIds.has(id)) continue
    if (!finishedMatches.has(id)) {
      // Si la API sigue listándolo (ya no live), conservar el objeto actual:
      // lleva el marcador final fresco.
      const cur = merged.find(i => i.id === id)
      finishedMatches.set(id, { at: now, catId, item: cur || prev.item })
    }
    prevLiveItems.delete(id)
  }
  for (const [id, f] of finishedMatches) {
    if (now - f.at > FINISHED_LINGER_MS) finishedMatches.delete(id)
  }
}

// Ligas principales primero en la vista de categorías (substring, minúsculas).
const MAJOR_LEAGUES = [
  'la liga', 'laliga', 'primera división', 'primera division',
  'premier league', 'bundesliga', 'serie a', 'ligue 1',
  'champions league', 'europa league', 'conference league',
  'copa del rey', 'fa cup', 'eredivisie', 'primeira',
  'brasileir', 'brazilian serie a', 'libertadores', 'sudamericana',
  'argentin', 'liga mx', 'mls', 'saudi', 'championship',
]
const leagueRank = (name) => {
  const n = String(name || '').toLowerCase()
  const i = MAJOR_LEAGUES.findIndex(k => n.includes(k))
  return i === -1 ? MAJOR_LEAGUES.length : i
}

// Alias: nombre de liga Marca → regex sobre el nombre de liga FCTV
// normalizado, con exclusiones (p.ej. "Premier League" no debe casar con
// "Russian Premier League" ni "Serie A" con "Brazilian Serie A").
const MARCA_TO_FCTV = {
  'LaLiga EA Sports': { re: /\bla liga\b|\blaliga\b/, not: /hyper|segunda|\b2\b|rfef|federac|women/ },
  'LaLiga Hypermotion': { re: /hypermotion|la liga 2|laliga 2|segunda division/ },
  'Premier League': { re: /premier league/, not: /russian|egyptian|ukrain|saudi|indian|burundi|scottish|women|\b2\b|reserve/ },
  'Serie A': { re: /\bserie a\b/, not: /brazil|ecuador|women|primavera/ },
  'Bundesliga': { re: /bundesliga/, not: /\b2\b|austria|women|liga 3/ },
  'Ligue 1': { re: /\bligue 1\b/, not: /women|reserve/ },
  'Champions League': { re: /champions league/, not: /afc|caf|women|youth|qualif|two|asian|concacaf|oceania/ },
  'Europa League': { re: /europa league/, not: /conference/ },
}

// Comparación de nombres de equipo (Marca ↔ FCTV) en utils/teamMatch.js.

// Normaliza un partido del calendario de Marca al formato de tarjeta.
// date="DD/MM" time="HH:MM" sin año: se deduce del año de temporada.
function normalizeMarcaMatch(m, round, leagueSlug, idx) {
  let matchDate = 0
  if (m.ts) matchDate = m.ts
  else if (m.date) {
    const [dd, mm] = m.date.split('/').map(Number)
    const now = new Date()
    const seasonYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1
    const year = mm >= 7 ? seasonYear : seasonYear + 1
    const [hh, mi] = (m.time || '00:00').split(':').map(Number)
    matchDate = new Date(year, mm - 1, dd, hh, mi).getTime()
  }
  let score = null
  if (m.result) {
    const [h, a] = m.result.split('-').map(Number)
    if (!isNaN(h) && !isNaN(a)) score = { home: h, away: a }
  }
  return {
    id: `marca-${leagueSlug}-j${round}-${m.home.id || m.home.name}-${m.away.id || m.away.name}-${idx}`,
    type: 'marca',
    name: `${m.home.name} vs ${m.away.name}`,
    _home: { name: m.home.name, logo: m.home.logo },
    _away: { name: m.away.name, logo: m.away.logo },
    _score: score,
    _matchDate: matchDate,
    _isLive: !!m._live,
    _round: round,
    link: m.link,
    _idx: idx,
  }
}

// Eventos de Sofascore → misma forma {round, matches} que las jornadas del
// calendario Marca, así normalizeMarcaMatch y la fusión FCTV/DLive sirven
// igual. m.ts lleva el kickoff exacto y m._live el estado en directo.
// Nombre comercial en Marca → nombre del torneo en Sofascore.
const MARCA_TO_SOFA = {
  'LaLiga EA Sports': 'LaLiga',
  'LaLiga Hypermotion': 'LaLiga 2',
  'Champions League': 'UEFA Champions League',
  'Europa League': 'UEFA Europa League',
}

function sofaToJornadas(events) {
  const byRound = new Map()
  for (const e of events) {
    if (!e.round) continue
    if (!byRound.has(e.round)) byRound.set(e.round, [])
    byRound.get(e.round).push({
      home: { name: e.home, logo: e.homeImg },
      away: { name: e.away, logo: e.awayImg },
      result: e.homeScore != null ? `${e.homeScore}-${e.awayScore}` : null,
      ts: e.ts,
      _live: e.status === 'inprogress',
      name: e.roundName,
    })
  }
  return [...byRound.entries()].sort((a, b) => a[0] - b[0])
    .map(([round, matches]) => ({
      round,
      name: matches[0].name || null,
      matches: matches.sort((a, b) => a.ts - b.ts),
    }))
}

function formatKickoff(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return time
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${time}`
}

// Tarjeta grande de partido: escudos de ambos equipos, marcador/hora y estado.
const MatchCard = memo(function MatchCard({ item, resolving, onPlay, liveLabel, finishedLabel, loadingLabel, initial }) {
  const home = item._home
  const away = item._away
  const score = item._score
  const hasScore = score?.home != null && score?.away != null
  const kickoff = formatKickoff(item._matchDate)
  const live = item._isLive

  return (
    <button
      type="button"
      tabIndex={0}
      data-tv-card
      data-match-id={item.id}
      {...(initial ? { 'data-tv-initial': true } : {})}
      onClick={() => onPlay(item)}
      disabled={resolving}
      className="card group p-4 flex flex-col items-center gap-3 text-center w-full disabled:opacity-60"
    >
      <div className="flex items-center justify-center gap-4 w-full">
        <div className="flex-1 flex flex-col items-center gap-2 min-w-0">
          <div className="w-16 h-16 sm:w-20 sm:h-20 flex items-center justify-center">
            {home?.logo && (
              <img src={home.logo} alt="" loading="lazy" onError={e => { e.currentTarget.style.display = 'none' }} className="max-w-full max-h-full object-contain" />
            )}
          </div>
          <span className="text-sm font-medium text-white leading-tight line-clamp-2 break-words w-full">
            {home?.name || '—'}
          </span>
        </div>

        <div className="flex flex-col items-center gap-1 flex-shrink-0 px-1">
          {hasScore ? (
            <span className="text-2xl font-bold text-white tabular-nums">
              {score.home} - {score.away}
            </span>
          ) : (
            <span className="text-lg font-semibold text-dark-300">vs</span>
          )}
          {live ? (
            <span className="text-xs font-bold text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-0.5 rounded-full">
              {liveLabel}
            </span>
          ) : item._justFinished ? (
            <span className="text-xs font-bold text-dark-300 bg-dark-700/80 border border-dark-600 px-2 py-0.5 rounded-full">
              {finishedLabel}
            </span>
          ) : kickoff ? (
            <span className="text-xs text-dark-300 bg-dark-700/60 px-2 py-0.5 rounded-full tabular-nums">
              {kickoff}
            </span>
          ) : null}
          <span className="flex items-center gap-1.5">
            {(item._fctvItem || item._dliveItem || item.type !== 'marca') && (
              <Play size={14} className="text-primary-400" aria-label="Streams disponibles" />
            )}
            {item.link && (
              <ExternalLink size={14} className="text-primary-400" aria-label="Enlace Marca" />
            )}
          </span>
        </div>

        <div className="flex-1 flex flex-col items-center gap-2 min-w-0">
          <div className="w-16 h-16 sm:w-20 sm:h-20 flex items-center justify-center">
            {away?.logo && (
              <img src={away.logo} alt="" loading="lazy" onError={e => { e.currentTarget.style.display = 'none' }} className="max-w-full max-h-full object-contain" />
            )}
          </div>
          <span className="text-sm font-medium text-white leading-tight line-clamp-2 break-words w-full">
            {away?.name || '—'}
          </span>
        </div>
      </div>

      {resolving && (
        <span className="text-xs text-primary-400">{loadingLabel}</span>
      )}
    </button>
  )
})

// Tarjeta de categoría de liga: logo + nombre + nº de partidos.
const LeagueCard = memo(function LeagueCard({ group, onOpen, matchesLabel, liveLabel, initial }) {
  const liveCount = group.items.filter(i => i._isLive).length
  return (
    <button
      type="button"
      tabIndex={0}
      data-tv-card
      {...(initial ? { 'data-tv-initial': true } : {})}
      onClick={() => onOpen(group)}
      className="card group p-5 flex flex-col items-center gap-3 text-center w-full"
    >
      <div className="w-20 h-20 sm:w-24 sm:h-24 flex items-center justify-center">
        {group.logo && (
          <img src={group.logo} alt="" loading="lazy" onError={e => { e.currentTarget.style.display = 'none' }} className="max-w-full max-h-full object-contain" />
        )}
      </div>
      <span className="text-base font-semibold text-white leading-tight line-clamp-2 w-full">
        {group.name}
      </span>
      <span className="text-xs text-dark-400">
        {group.items.length} {matchesLabel}
        {liveCount > 0 && <span className="text-red-400 font-bold"> · {liveCount} {liveLabel}</span>}
      </span>
    </button>
  )
})

export default function Sports() {
  const { t } = useTranslation()

  const [catalogs, setCatalogs] = useState([])
  const [activeCat, setActiveCat] = useState(null)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(null) // { stream, item }
  const [resolvingId, setResolvingId] = useState(null)
  const [selectedLeague, setSelectedLeague] = useState(null) // group | null
  const [marcaResults, setMarcaResults] = useState(new Map()) // leagueSlug → [{home,away,homeScore,awayScore}]
  const [streamPicker, setStreamPicker] = useState(null) // { item, streams }
  const playAbortRef = useRef(null)
  const playRequestRef = useRef(0)
  // Última liga abierta: al volver atrás, el foco regresa a su tarjeta.
  const lastLeagueRef = useRef(null)
  // Timestamp de apertura de liga: el WebView dispara `click` en keyup sobre el
  // elemento enfocado; sin guarda, el OK que abre la liga activa también la
  // primera tarjeta de partido recién enfocada.
  const leagueOpenedAtRef = useRef(0)
  const leagueClosedAtRef = useRef(0)
  const pickerOpenedAtRef = useRef(0)
  const pickerClosedAtRef = useRef(0)
  // Última tarjeta de partido pulsada: restaura el foco al cerrar el picker.
  const lastPickerItemRef = useRef(null)
  const openLeague = (group) => {
    // Click residual del Back que cerró la liga anterior.
    if (Date.now() - leagueClosedAtRef.current < 400) return
    lastLeagueRef.current = group.name
    leagueOpenedAtRef.current = Date.now()
    setSelectedLeague(group)
  }

  useEffect(() => () => {
    playRequestRef.current++
    playAbortRef.current?.abort()
  }, [])

  // Back (TV/esc): cierra el picker de enlaces o vuelve a la lista de ligas.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Back' && e.key !== 'Escape') return
      if (streamPicker) {
        pickerClosedAtRef.current = Date.now()
        setStreamPicker(null)
        document.body.setAttribute('data-back-consumed', 'true')
      } else if (selectedLeague) {
        leagueClosedAtRef.current = Date.now()
        setSelectedLeague(null)
        document.body.setAttribute('data-back-consumed', 'true')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [streamPicker, selectedLeague])

  // Cuando llega el contenido, llevar el foco a la primera tarjeta (los
  // directos) si el foco quedó en un chip, en el nav o fuera del contenido.
  // No robarlo si el usuario ya navega dentro de la grid de ligas.
  useEffect(() => {
    if (selectedLeague || !items.length) return
    const timer = setTimeout(() => {
      const initial = document.querySelector('main [data-tv-initial]')
      const ae = document.activeElement
      if (initial && !ae?.closest?.('[data-tv-grid]')) initial.focus()
    }, 250)
    return () => clearTimeout(timer)
  }, [items, selectedLeague])

  // Al abrir el picker de enlaces: inert en TODOS los hermanos de la cadena
  // de ancestros del modal (nav, contenido, etc.) para que ni la navegación
  // nativa del WebView ni tvNavigation puedan sacar el foco del modal; y foco
  // en la primera entrada. Al cerrarlo, se revierte y el foco vuelve a la
  // tarjeta de partido que lo abrió.
  useEffect(() => {
    if (!streamPicker) return
    const inerted = []
    const timer = setTimeout(() => {
      const modal = document.querySelector('[data-tv-modal]')
      if (!modal) return
      let el = modal
      while (el && el.parentElement && el !== document.body) {
        for (const sib of el.parentElement.children) {
          if (sib !== el && !sib.inert) { sib.inert = true; inerted.push(sib) }
        }
        el = el.parentElement
      }
      modal.querySelector('[data-tv-card]')?.focus()
    }, 60)
    return () => {
      clearTimeout(timer)
      for (const s of inerted) s.inert = false
      const id = lastPickerItemRef.current
      if (id) {
        lastPickerItemRef.current = null
        setTimeout(() => document.querySelector(`[data-match-id="${CSS.escape(id)}"]`)?.focus(), 60)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamPicker?.item]) // solo al abrir/cambiar de partido — no en cada lote de streams

  // Carga progresiva: si el foco quedó fuera de la lista (p.ej. en Cancelar
  // mientras el picker estaba vacío), moverlo al primer enlace al llegar el
  // primer stream; y si el elemento enfocado desapareció (embed→directo),
  // devolverlo al modal.
  const pickerHadStreamsRef = useRef(false)
  useEffect(() => {
    if (!streamPicker) { pickerHadStreamsRef.current = false; return }
    const modal = document.querySelector('[data-tv-modal]')
    if (!modal) return
    const had = pickerHadStreamsRef.current
    pickerHadStreamsRef.current = streamPicker.streams.length > 0
    const active = document.activeElement
    if (!modal.contains(active)) {
      modal.querySelector('[data-tv-card]')?.focus()
    } else if (!had && streamPicker.streams.length > 0 && !active?.closest('[data-tv-list]')) {
      modal.querySelector('[data-tv-list] [data-tv-card]')?.focus()
    }
  }, [streamPicker])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const all = await pluginManager.getAllCatalogs()
        const cats = all.filter(c => c.pluginId === SPORTS_PLUGIN)
        if (cancelled) return
        if (!cats.length) {
          setError(t('sports.no_plugin'))
          setLoading(false)
          return
        }
        setCatalogs(cats)
        setActiveCat(cats[0])
      } catch (e) {
        if (!cancelled) {
          setError(t('sports.load_error') + ': ' + (e?.message || 'unknown'))
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!activeCat) return
    let cancelled = false
    const load = async (silent = false) => {
      try {
        // Vaciar antes de cargar: si no, la grid renderiza los grupos del
        // catálogo anterior (p.ej. ligas de fútbol en la pestaña Baloncesto).
        // En el refresco silencioso (60s) se conserva la lista para no parpadear.
        if (!silent) {
          const snap = catalogSnapshot.get(activeCat.id)
          if (snap && Date.now() - snap.ts < SNAPSHOT_TTL) {
            // Pintado instantáneo con datos stale; el fetch los reemplaza.
            setItems(snap.items)
            setError('')
          } else {
            setItems([])
            setLoading(true)
            setError('')
          }
        }
        // DLive cubre los mismos catálogos (fctv-X → dlive-X). Se carga en
        // paralelo y sus eventos se funden en los items FCTV por equipos; los
        // que no casan entran como items propios (más cobertura de ligas).
        // Pintado progresivo: FCTV aparece en cuanto llega; los items DLive
        // se funden/insertan cuando su catálogo resuelve, sin esperarlo.
        const dliveCat = activeCat.id.replace('fctv-', 'dlive-')
        let fctvItems = null
        let dliveItems = []
        const mergeAll = () => {
          const merged = (fctvItems || []).map(i => ({ ...i, pluginId: activeCat.pluginId }))
          for (const d of dliveItems) {
            const f = merged.find(i => sameMatch(i, d))
            if (f) {
              f._dliveItem = d
              if (!f._isLive && d._isLive) f._isLive = true
              // Heredar escudos/logo de liga de DLive si FCTV no los tiene.
              for (const side of ['_home', '_away']) {
                if (f[side] && !f[side].logo && d[side]?.logo) f[side].logo = d[side].logo
              }
              if (f._league && !f._league.logo && d._league?.logo) f._league.logo = d._league.logo
            } else {
              merged.push({ ...d, pluginId: DLIVE_PLUGIN })
            }
          }
          return dedupeMatches(merged)
        }
        const paint = () => {
          if (cancelled || fctvItems === null) return
          const merged = mergeAll()
          trackFinished(merged, activeCat.id)
          setItems(merged)
          catalogSnapshot.set(activeCat.id, { items: merged, ts: Date.now() })
          setLoading(false)
          // Enriquecimiento profundo de escudos en segundo plano: las
          // tarjetas ya están pintadas; los logos que la pasada live no
          // cubrió llegan aquí. Objetos nuevos para romper el memo.
          enrichLogos(merged).then(() => {
            if (!cancelled) setItems(merged.map(i => ({ ...i })))
          }).catch(() => {})
        }
        await Promise.all([
          pluginManager.getCatalogContent(activeCat.pluginId, activeCat.id, activeCat.type, 0, 500)
            .then(r => { fctvItems = r; paint() })
            .catch(() => { fctvItems = []; paint() }),
          pluginManager.getCatalogContent(DLIVE_PLUGIN, dliveCat, 'channel', 0, 500)
            .then(r => { dliveItems = r; paint() })
            .catch(() => { dliveItems = []; paint() }),
        ])
      } catch (e) {
        if (!cancelled) {
          setError(t('sports.load_error') + ': ' + (e?.message || 'unknown'))
          setLoading(false)
        }
      }
    }
    load()
    // Refresco silencioso cada 60s: actualiza marcadores, mete nuevos directos
    // y retira los finalizados cuando expira su periodo de gracia.
    const iv = setInterval(() => load(true), 60000)
    return () => { cancelled = true; clearInterval(iv) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCat])

  // Calendario en runtime: el fichero Marca empaquetado solo se regenera con
  // cada build, así que sus jornadas/resultados quedan desfasados en la app
  // instalada. Sofascore lo reconstruye (resultados de ayer incluidos) y se
  // refresca cada 6h; el fichero empaquetado queda como fallback offline.
  useEffect(() => {
    if (activeCat?.id !== 'fctv-football') return
    let cancelled = false
    const ctl = new AbortController()
    const refresh = async () => {
      const map = new Map()
      for (let i = 0; i < MARCA_LEAGUES.length; i += 4) {
        await Promise.all(MARCA_LEAGUES.slice(i, i + 4).map(async lg => {
          const res = await fetchLeagueEvents(MARCA_TO_SOFA[lg.name] || lg.name, 'football', ctl.signal)
          if (res.length) map.set(lg.slug, res)
        }))
        if (cancelled) return
      }
      if (!cancelled) setMarcaResults(map)
    }
    refresh()
    const iv = setInterval(refresh, 6 * 60 * 60 * 1000)
    return () => { cancelled = true; ctl.abort(); clearInterval(iv) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCat])

  // Agrupar por liga → secciones "La Liga", "Bundesliga", etc.
  const leagueGroups = useMemo(() => {
    const groups = new Map()
    const deadCdn = (u) => /\/logos\d*\.[a-z0-9-]+\.(cfd|ru)\//i.test(u || '')
    const catId = activeCat?.id
    for (const item of items) {
      // Si acaba de finalizar (<5 min) pero la API aún lo lista, se marca
      // FINALIZADO; al expirar sale del mapa y vuelve a render normal.
      if (finishedMatches.has(item.id) && finishedMatches.get(item.id).catId === catId) {
        item._isLive = false
        item._justFinished = true
      }
      const lname = item._league?.name || item.genre || t('sports.other')
      // leagueKey une "EGY Premier League" (DLive) con "Egyptian Premier
      // League" (FCTV) en el mismo grupo.
      const key = leagueKey(lname) || lname
      if (!groups.has(key)) {
        groups.set(key, { name: lname, logo: item._league?.logo || null, items: [], dliveName: item.pluginId === DLIVE_PLUGIN })
      }
      const g = groups.get(key)
      // Preferir el nombre FCTV ("Egyptian Premier League") sobre el de
      // DLive ("EGY Premier League") como nombre visible del grupo.
      if (g.dliveName && item.pluginId !== DLIVE_PLUGIN) {
        g.name = lname
        g.dliveName = false
      }
      // Preferir un logo que no sea del CDN muerto de FCTV (logos*.*.cfd).
      if (g.logo == null || (deadCdn(g.logo) && item._league?.logo && !deadCdn(item._league.logo))) {
        g.logo = item._league?.logo || g.logo
      }
      g.items.push(item)
    }
    // Inyectar partidos finalizados que la API ya no lista: siguen en su
    // liga con sello FINALIZADO durante 5 min.
    for (const [id, f] of finishedMatches) {
      if (f.catId !== catId) continue
      if (items.some(i => i.id === id)) continue
      const ghost = { ...f.item, _isLive: false, _justFinished: true }
      const lname = ghost._league?.name || ghost.genre || t('sports.other')
      const key = leagueKey(lname) || lname
      if (!groups.has(key)) {
        groups.set(key, { name: lname, logo: ghost._league?.logo || null, items: [], dliveName: false })
      }
      groups.get(key).items.push(ghost)
    }
    // Ligas principales primero, luego con directos, luego por nombre.
    return [...groups.values()].sort((a, b) => {
      const diff = leagueRank(a.name) - leagueRank(b.name)
      if (diff) return diff
      const aLive = a.items.some(i => i._isLive) ? 1 : 0
      const bLive = b.items.some(i => i._isLive) ? 1 : 0
      return bLive - aLive || a.name.localeCompare(b.name)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, activeCat])

  // Fuentes de enlaces de un partido: el propio item (FCTV/DLive), el item
  // FCTV equivalente para tarjetas de calendario Marca, y el evento DLive
  // fusionado (mismo partido en ambas fuentes → ambos enlaces en el picker).
  const sourcesOf = (item) => {
    const srcs = []
    if (item.type === 'marca') {
      const f = findFctvItem(item)
      if (f) {
        if (f.pluginId === DLIVE_PLUGIN) srcs.push(f)
        else {
          srcs.push(f)
          if (f._dliveItem) srcs.push(f._dliveItem)
        }
      }
      if (item._dliveItem && !srcs.includes(item._dliveItem)) srcs.push(item._dliveItem)
    } else {
      srcs.push(item)
      if (item._dliveItem) srcs.push(item._dliveItem)
    }
    return srcs
  }

  const handlePlay = async (item) => {
    // Ignorar el click residual del OK que abrió la liga o del Back que
    // cerró el picker anterior (keyup tras refocus).
    if (Date.now() - leagueOpenedAtRef.current < 400) return
    if (Date.now() - pickerClosedAtRef.current < 400) return
    setError('')
    setResolvingId(item.id)

    playAbortRef.current?.abort()
    const ctrl = new AbortController()
    playAbortRef.current = ctrl
    const requestId = ++playRequestRef.current

    // Picker abierto de inmediato: los enlaces aparecen según resuelve cada
    // fuente (FCTV, DLive…), como en la ficha de pelis/series.
    pickerOpenedAtRef.current = Date.now()
    lastPickerItemRef.current = item.id
    const acc = []
    const flush = () => {
      if (requestId !== playRequestRef.current || ctrl.signal.aborted) return
      const direct = acc.filter(s => s.streamType !== 'embed')
      setStreamPicker({ item, streams: direct.length ? direct : acc, loading: true })
    }
    try {
      flush()
      const srcs = sourcesOf(item)
      await Promise.all(srcs.map(src =>
        pluginManager.getStreams(src.type, src.id, src.name, ctrl.signal)
          .catch(() => [])
          .then(streams => {
            for (const s of streams || []) acc.push({ ...s, _fctvItem: src })
            flush()
          })))
      if (requestId !== playRequestRef.current || ctrl.signal.aborted) return
      // Página del directo en Marca para partidos del calendario.
      if (item.link) {
        acc.push({ name: 'Marca · Directo', title: 'Página del partido', _external: item.link })
      }
      const direct = acc.filter(s => s.streamType !== 'embed')
      const final = direct.length ? direct : acc
      if (final.length) {
        setStreamPicker({ item, streams: final, loading: false })
      } else {
        setStreamPicker(null)
        setError(t('sports.no_stream'))
      }
    } catch (e) {
      if (!ctrl.signal.aborted && requestId === playRequestRef.current) {
        setStreamPicker(null)
        setError(t('sports.load_error') + ': ' + (e?.message || 'error'))
      }
    } finally {
      if (requestId === playRequestRef.current) setResolvingId(null)
    }
  }

  const playStream = (stream, item) => {
    // Click residual del OK que abrió el picker (keyup tras refocus).
    if (Date.now() - pickerOpenedAtRef.current < 400) return
    if (stream._external) {
      window.open(stream._external, '_blank', 'noopener,noreferrer')
      return
    }
    setStreamPicker(null)
    // Marca items resuelven el partido FCTV equivalente: reproducir con los
    // metadatos del item real para que el historial quede consistente.
    setPlaying({ stream, item: stream._fctvItem || item })
  }

  // Ligas Marca → mismo formato de grupo que las ligas FCTV, con _round por
  // partido para agrupar por jornada dentro del detalle. Los partidos FCTV de
  // la misma liga se funden EN la tarjeta de la jornada (live + enlaces) en
  // vez de duplicarse arriba; solo quedan sueltos los que no están en Marca.
  const marcaGroups = useMemo(() => {
    const used = new Set()
    const groups = MARCA_LEAGUES.map(lg => {
      const rule = MARCA_TO_FCTV[lg.name] || { re: new RegExp(lg.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }
      // Solo grupos con items FCTV reclaman una liga Marca: una liga solo-DLive
      // ("RUS Premier League") no debe secuestrar la tarjeta de otra liga.
      // Los eventos DLive se fusionan igualmente por equipos más abajo.
      const fctvGroup = leagueGroups.find(g => {
        if (used.has(g.name) || !g.items.some(i => i.pluginId !== DLIVE_PLUGIN)) return false
        const n = g.name.toLowerCase()
        return rule.re.test(n) && !(rule.not && rule.not.test(n))
      })
      if (fctvGroup) used.add(fctvGroup.name)

      const claimedFctv = new Set()
      // Si Sofascore devolvió el calendario en runtime se usa ese (resultados
      // y fechas al día); el fichero Marca empaquetado es el fallback offline
      // y también si la liga está en off-season (pocas jornadas con datos).
      const sofaJornadas = marcaResults.get(lg.slug)
      const conv = sofaJornadas?.length ? sofaToJornadas(sofaJornadas) : null
      const jornadasSrc = conv?.some(j => j.matches.length >= 3) ? conv : lg.jornadas
      const jornadas = jornadasSrc.map(j => ({
        round: j.round,
        name: j.name || null,
        items: j.matches.map((m, i) => {
          const item = normalizeMarcaMatch(m, j.round, lg.slug, i)
          let f = fctvGroup?.items.find(fi =>
            teamsMatch(fi._home?.name, item._home?.name) &&
            teamsMatch(fi._away?.name, item._away?.name))
          let d = null
          // El match puede venir de un item DLive colgado en el grupo FCTV.
          if (f?.pluginId === DLIVE_PLUGIN) { d = f; f = null }
          if (f) {
            claimedFctv.add(f.id)
            item._fctvItem = f
            item._isLive = f._isLive
            if (f._justFinished) item._justFinished = true
            if (!item._score && f._score) item._score = f._score
            for (const side of ['_home', '_away']) {
              if (item[side] && !item[side].logo && f[side]?.logo) item[side].logo = f[side].logo
            }
            d = d || f._dliveItem || null
          }
          // DLive puede tener el partido aunque FCTV no: buscar también un
          // evento DLive suelto (cualquier grupo) que case por equipos.
          if (!d) {
            d = items.find(di => di.pluginId === DLIVE_PLUGIN && !claimedFctv.has(di.id) &&
              teamsMatch(di._home?.name, item._home?.name) &&
              teamsMatch(di._away?.name, item._away?.name))
          }
          if (d) {
            claimedFctv.add(d.id)
            item._dliveItem = d
            if (d._isLive) item._isLive = true
            if (d._justFinished) item._justFinished = true
            for (const side of ['_home', '_away']) {
              if (item[side] && !item[side].logo && d[side]?.logo) item[side].logo = d[side].logo
            }
          }
          return item
        }),
      }))
      // Los partidos en directo SALEN de su jornada y se mueven a la sección
      // EN DIRECTO (con la tarjeta de escudos fusionada). Los FCTV en directo
      // sin tarjeta de calendario también van ahí; los que no están en directo
      // ni en la jornada se descartan (evita duplicados sin escudos).
      const liveItems = [
        ...jornadas.flatMap(j => j.items).filter(i => i._isLive || i._justFinished),
        ...(fctvGroup?.items || []).filter(fi => !claimedFctv.has(fi.id) && (fi._isLive || fi._justFinished)),
      ]
      // Los recién finalizados tampoco vuelven a la jornada durante sus 5 min.
      jornadas.forEach(j => { j.items = j.items.filter(i => !i._isLive && !i._justFinished) })
      return {
        name: lg.name,
        logo: lg.logo || fctvGroup?.logo || null,
        marca: true,
        liveItems,
        items: [...liveItems, ...jornadas.flatMap(j => j.items)],
        jornadas,
      }
    })
    return { groups, usedNames: used }
  }, [leagueGroups, marcaResults])

  // Ligas FCTV no cubiertas por el calendario Marca (solo en catálogo fútbol).
  const extraFctvGroups = useMemo(
    () => leagueGroups.filter(g => !marcaGroups.usedNames.has(g.name)),
    [leagueGroups, marcaGroups])

  // Localiza el item FCTV equivalente a un partido del calendario (para sacar
  // sus enlaces de stream al seleccionarlo).
  const findFctvItem = (marcaItem) => marcaItem._fctvItem || items.find(i =>
    teamsMatch(i._home?.name, marcaItem._home?.name) &&
    teamsMatch(i._away?.name, marcaItem._away?.name))

  // La liga seleccionada se re-resuelve contra los grupos actuales: el refresco
  // silencioso reconstruye los objetos y la referencia guardada queda obsoleta
  // (un finalizado no desaparecería nunca del detalle). Si la liga ya no
  // existe, volver a la parrilla.
  const allGroups = activeCat?.id === 'fctv-football'
    ? [...marcaGroups.groups, ...extraFctvGroups]
    : leagueGroups
  const activeLeague = selectedLeague
    ? allGroups.find(g => g.name === selectedLeague.name) || null
    : null
  useEffect(() => {
    if (selectedLeague && items.length > 0 && !activeLeague) setSelectedLeague(null)
  }, [selectedLeague, allGroups, activeLeague, items.length])

  if (loading && items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <LogoLoader size={80} />
        <p className="text-white/70 text-sm">{t('sports.loading')}</p>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6">
      {playing && (
        <VideoPlayer
          mode="live"
          stream={playing.stream}
          title={playing.item.title || playing.item.name}
          meta={{ id: playing.item.id, type: 'live', name: playing.item.name, poster: playing.item.poster || '' }}
          onClose={() => {
            playRequestRef.current++
            playAbortRef.current?.abort()
            // Los deportes en directo no se guardan en historial: no son
            // reanudables y ensucian "Continuar viendo".
            setPlaying(null)
          }}
        />
      )}

      <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Trophy size={24} className="text-primary-400" />
        <h1 className="text-xl font-bold text-white">{t('sports.title')}</h1>
      </div>

      {catalogs.length > 1 && (
        <div data-tv-row className="flex gap-2 overflow-x-auto pb-1">
          {catalogs.map(cat => (
            <button
              key={cat.id}
              type="button"
              tabIndex={0}
              data-tv-card
              onClick={() => { setActiveCat(cat); setSelectedLeague(null); lastLeagueRef.current = null }}
              className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeCat?.id === cat.id
                  ? 'bg-primary-600 text-white'
                  : 'bg-dark-800 text-dark-300 hover:text-white'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm">
          <AlertCircle size={18} />
          {error}
        </div>
      )}

      {!error && items.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Trophy size={56} className="text-dark-600" />
          <p className="text-dark-400">{t('sports.empty')}</p>
        </div>
      )}

      {activeLeague ? (
        // Nivel 2: partidos de la liga seleccionada
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              tabIndex={0}
              data-tv-card
              onClick={() => setSelectedLeague(null)}
              className="btn-ghost p-2 rounded-lg"
              aria-label={t('common.back')}
            >
              <ArrowLeft size={22} />
            </button>
            {activeLeague.logo && (
              <img src={activeLeague.logo} alt="" loading="lazy" onError={e => { e.currentTarget.style.display = 'none' }} className="w-8 h-8 object-contain" />
            )}
            <h2 className="text-lg font-semibold text-white/90">{activeLeague.name}</h2>
            <span className="text-xs text-dark-500">{activeLeague.items.length}</span>
          </div>
          {activeLeague.marca ? (
            // Liga de calendario: partidos en directo arriba (tarjetas con
            // escudos movidas desde su jornada), luego las jornadas.
            <>
              {activeLeague.liveItems.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-red-400">{t('sports.live')}</h3>
                  <div data-tv-grid className="sports-card-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {activeLeague.liveItems.map((item, i) => (
                      <MatchCard
                        key={item.id}
                        item={item}
                        resolving={resolvingId === item.id}
                        onPlay={handlePlay}
                        liveLabel={t('sports.live')}
                        finishedLabel={t('sports.finished')}
                        loadingLabel={t('sports.loading')}
                        initial={i === 0}
                      />
                    ))}
                  </div>
                </div>
              )}
              {activeLeague.jornadas.map((j, ji) => (
                <div key={j.round} className="space-y-3">
                  <h3 className="text-sm font-medium text-dark-300">{j.name || `Jornada ${j.round}`}</h3>
                  <div data-tv-grid className="sports-card-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {j.items.map((item, i) => (
                      <MatchCard
                        key={item.id}
                        item={item}
                        resolving={resolvingId === item.id}
                        onPlay={handlePlay}
                        liveLabel={t('sports.live')}
                        finishedLabel={t('sports.finished')}
                        loadingLabel={t('sports.loading')}
                        initial={activeLeague.liveItems.length === 0 && ji === 0 && i === 0}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </>
          ) : (
            <div data-tv-grid className="sports-card-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {(() => {
                const firstLive = activeLeague.items.findIndex(i => i._isLive)
                return activeLeague.items.map((item, i) => (
                  <MatchCard
                    key={item.id}
                    item={item}
                    resolving={resolvingId === item.id}
                    onPlay={handlePlay}
                    liveLabel={t('sports.live')}
                    finishedLabel={t('sports.finished')}
                    loadingLabel={t('sports.loading')}
                    initial={i === (firstLive >= 0 ? firstLive : 0)}
                  />
                ))
              })()}
            </div>
          )}
        </section>
      ) : (
        <>
          {/* Nivel 1: categorías por liga */}
          {activeCat?.id === 'fctv-football' ? (
            // Fútbol: ligas principales (Marca) fusionadas con sus directos
            // FCTV, más ligas FCTV sin calendario.
            <div data-tv-grid className="sports-card-grid grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {[...marcaGroups.groups, ...extraFctvGroups].map((group, i) => (
                <LeagueCard
                  key={group.name}
                  group={group}
                  onOpen={openLeague}
                  matchesLabel={t('sports.matches')}
                  liveLabel={t('sports.live')}
                  initial={lastLeagueRef.current ? group.name === lastLeagueRef.current : i === 0}
                />
              ))}
            </div>
          ) : (
            <div data-tv-grid className="sports-card-grid grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {leagueGroups.map((group, i) => (
                <LeagueCard
                  key={group.name}
                  group={group}
                  onOpen={openLeague}
                  matchesLabel={t('sports.matches')}
                  liveLabel={t('sports.live')}
                  initial={lastLeagueRef.current ? group.name === lastLeagueRef.current : i === 0}
                />
              ))}
            </div>
          )}
        </>
      )}
      </div>

      {/* Nivel 3: enlaces/streams del partido */}
      {streamPicker && (
        <div data-tv-modal className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => { pickerClosedAtRef.current = Date.now(); setStreamPicker(null) }}>
          <div className="bg-dark-900 border border-dark-700 rounded-xl p-5 max-w-md w-full space-y-3 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white leading-tight">
              {streamPicker.item.title || streamPicker.item.name}
            </h3>
            <p className="text-xs text-dark-400">{streamPicker.item.description}</p>
            <div data-tv-list className="space-y-2">
              {streamPicker.loading && streamPicker.streams.length === 0 && (
                <div className="flex items-center justify-center gap-2 py-4 text-sm text-dark-400">
                  <span className="w-4 h-4 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
                  Buscando enlaces…
                </div>
              )}
              {streamPicker.streams.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  tabIndex={0}
                  data-tv-card
                  onClick={() => playStream(s, streamPicker.item)}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-dark-800 hover:bg-dark-700 text-left transition-colors"
                >
                  {s._external ? (
                    <ExternalLink size={16} className="text-primary-400 flex-shrink-0" />
                  ) : (
                    <Play size={16} className="text-primary-400 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-white truncate">{s.name}</span>
                    <span className="block text-xs text-dark-400 truncate">{s.title}{s.streamType ? ` · ${s.streamType}` : ''}</span>
                  </div>
                </button>
              ))}
              {streamPicker.loading && streamPicker.streams.length > 0 && (
                <div className="flex items-center justify-center gap-2 py-1 text-xs text-dark-500">
                  <span className="w-3 h-3 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
                  Más enlaces…
                </div>
              )}
            </div>
            <button
              type="button"
              tabIndex={0}
              data-tv-card
              onClick={() => { pickerClosedAtRef.current = Date.now(); setStreamPicker(null) }}
              className="w-full px-4 py-2.5 rounded-lg bg-dark-800 text-dark-300 text-sm hover:text-white transition-colors"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
