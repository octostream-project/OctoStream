// Enriquecimiento de escudos: el CDN de logos de FCTV (logos1.*.cfd) está
// muerto (NXDOMAIN), así que los escudos se resuelven contra Sofascore.
//
// Nota: api.sofascore.com challengea (Varnish 403) IPs de proxy/WARP, pero
// img.sofascore.com sirve exactamente la misma API SIN challenge — por eso
// las llamadas van al host de imágenes.

import { httpGetJson } from './httpClient.js'
import { teamsMatch, normTeam, leagueKey } from './teamMatch.js'

const SOFA_API = 'https://img.sofascore.com/api/v1'

// FCTV sportType → slug de deporte en Sofascore
const SOFA_SPORT = {
  1: 'football', 2: 'basketball', 3: 'tennis', 4: 'baseball', 6: 'cricket',
  7: 'motorsport', 8: 'rugby', 9: 'american-football', 10: 'aussie-rules',
  11: 'ice-hockey', 12: 'badminton', 13: 'volleyball', 14: 'mma',
  15: 'cycling', 16: 'handball',
}

const teamImg = (id) => `${SOFA_API}/team/${id}/image`
const playerImg = (id) => `${SOFA_API}/player/${id}/image`
const tournamentImg = (id) => `${SOFA_API}/unique-tournament/${id}/image`

// El CDN de logos de FCTV (logos*.<dominio-rotativo>.cfd) está muerto:
// NXDOMAIN incluso en DNS público. Tratar esos URLs como "sin logo".
const isDeadLogo = (u) => !u || /^https?:\/\/logos\d*\.[a-z0-9-]+\.cfd\//i.test(u)

const LIVE_TTL = 60 * 1000
const liveCache = new Map() // sport slug → { ts, events }

// Los caches por sesión crecen con cada nombre único buscado; en un TV box
// con poca RAM conviene acotarlos (borra la entrada más antigua al llenarse).
const CACHE_MAX = 500
function cacheSet(map, key, val) {
  if (map.size >= CACHE_MAX && !map.has(key)) map.delete(map.keys().next().value)
  map.set(key, val)
}

async function sofaLiveEvents(slug, signal) {
  const hit = liveCache.get(slug)
  if (hit && Date.now() - hit.ts < LIVE_TTL) return hit.events
  let events = []
  try {
    const data = await httpGetJson(`${SOFA_API}/sport/${slug}/events/live`, {}, signal)
    events = (data?.events || []).map(e => ({
      home: e.homeTeam?.name, homeId: e.homeTeam?.id,
      away: e.awayTeam?.name, awayId: e.awayTeam?.id,
      utId: e.tournament?.uniqueTournament?.id,
    }))
  } catch { /* offline / challenge — pasada de búsqueda cubre */ }
  cacheSet(liveCache, slug, { ts: Date.now(), events })
  return events
}

// Búsqueda de equipo/jugador por nombre → id de imagen. Cacheada por sesión;
// los ids de Sofascore son estables.
const entityCache = new Map() // `${slug}|${norm}` → {id,type} | null
const lastToken = (s) => normTeam(s).split(' ').pop() || ''

async function sofaFindEntity(name, slug, signal) {
  const key = `${slug}|${normTeam(name)}`
  if (entityCache.has(key)) return entityCache.get(key)
  let found = null
  let ok = false
  try {
    const data = await httpGetJson(`${SOFA_API}/search/all?q=${encodeURIComponent(name)}`, {}, signal)
    ok = true
    const cands = (data?.results || [])
      .filter(r => r.type === 'team' || r.type === 'player')
    const wantTok = lastToken(name)
    const hit = cands.find(r => teamsMatch(r.entity?.name, name))
      // Deportes individuales: FCTV suele dar "Apellido N." — casar por la
      // última palabra si no hubo match directo. wantTok vacío nunca casa
      // ('' === '' sería falso positivo → logo equivocado).
      || (wantTok && cands.find(r => r.type === 'player' && lastToken(r.entity?.name) === wantTok))
    if (hit) found = { id: hit.entity.id, type: hit.type }
  } catch { /* sin resultado */ }
  // Solo cachear respuestas reales: un error de red transitorio no debe
  // dejar el logo muerto hasta reiniciar la app.
  if (ok) cacheSet(entityCache, key, found)
  return found
}

// Búsqueda de torneo/liga por nombre → id de imagen. "EGY Premier League"
// casa con "Egyptian Premier League" vía leagueKey (alias FIFA); cuando el
// nombre no lleva país se prueba también con el país de la categoría
// ("Spanish La Liga" → "Spain" + "LaLiga").
const leagueCache = new Map() // `${slug}|${key}` → id | null
const compact = (s) => String(s || '').replace(/\s+/g, '')
// Tokens normalizados sin el posesivo "s" ("Women's" → women+s).
const tokSet = (s) => new Set(leagueKey(s).split(' ').filter(t => t && t !== 's'))
const sameTokens = (a, b) => a.size === b.size && [...a].every(t => b.has(t))

// Queries alternativas: el nombre tal cual, la cola tras '-' / ':' (quita
// prefijos tipo "Handball-") y el nombre sin el primer token (quita países
// tipo "Spanish"/"EGY" que a Sofascore no le gustan en la query).
function leagueQueries(name) {
  const qs = [name]
  const tail = String(name).split(/[-:]/).pop().trim()
  if (tail && tail !== name) qs.push(tail)
  const minus1 = String(name).split(/\s+/).slice(1).join(' ')
  if (minus1 && minus1 !== name && minus1 !== tail) qs.push(minus1)
  return qs
}

async function sofaFindTournament(name, slug, signal) {
  const key = `${slug}|${leagueKey(name) || name}`
  if (leagueCache.has(key)) return leagueCache.get(key)
  let id = null
  const want = compact(leagueKey(name))
  const wantTok = tokSet(name)
  const wantTail = tokSet(String(name).split(/[-:]/).pop())
  let anyOk = false
  for (const q of leagueQueries(name)) {
    try {
      const data = await httpGetJson(`${SOFA_API}/search/all?q=${encodeURIComponent(q)}`, {}, signal)
      anyOk = true
      const cands = (data?.results || []).filter(r =>
        r.type === 'uniqueTournament' &&
        (!slug || !r.entity?.category?.sport?.slug || r.entity.category.sport.slug === slug))
      const hit = want && cands.find(r => {
        const en = compact(leagueKey(r.entity?.name))
        const cn = compact(leagueKey(`${r.entity?.category?.name || ''} ${r.entity?.name || ''}`))
        if (en === want || cn === want) return true
        // Conjunto de tokens: "Caribbean Premier League, Women" ⇔
        // "Women's Caribbean Premier League".
        const et = tokSet(r.entity?.name)
        if (sameTokens(et, wantTok)) return true
        const ct = tokSet(`${r.entity?.category?.name || ''} ${r.entity?.name || ''}`)
        if (sameTokens(ct, wantTok)) return true
        // Cola tras el prefijo de deporte: "Handball-Bundesliga" ⇔ "Bundesliga".
        return sameTokens(et, wantTail)
      })
      if (hit) { id = hit.entity.id; break }
    } catch { /* sin resultado */ }
  }
  // Sin respuesta válida en ninguna query no se cachea: reintento en la
  // próxima carga en vez de un miss permanente por un fallo de red.
  if (anyOk || id) cacheSet(leagueCache, key, id)
  return id
}

// Calendario de una liga: resuelve el torneo por nombre y trae sus últimos
// resultados y próximos partidos (con jornada, fecha, marcador y escudos).
// Sirve para reconstruir en runtime el calendario Marca empaquetado en el
// APK — los partidos de ayer aparecen con resultado sin esperar a un build.
const leagueEventsCache = new Map() // utId → { ts, events }
const EVENTS_TTL = 60 * 60 * 1000

export async function fetchLeagueEvents(leagueName, slug = 'football', signal) {
  const utId = await sofaFindTournament(leagueName, slug, signal)
  if (!utId) return []
  const hit = leagueEventsCache.get(utId)
  if (hit && Date.now() - hit.ts < EVENTS_TTL) return hit.events
  let seasonId = null
  let seasonsOk = false
  try {
    const data = await httpGetJson(`${SOFA_API}/unique-tournament/${utId}/seasons`, {}, signal)
    seasonsOk = true
    seasonId = data?.seasons?.[0]?.id
  } catch { /* sin seasons */ }
  // "Sin seasons" es respuesta real y se cachea; error de red no (reintento).
  if (!seasonId) {
    if (seasonsOk) cacheSet(leagueEventsCache, utId, { ts: Date.now(), events: [] })
    return []
  }
  const out = []
  const seen = new Set()
  let anyPageOk = false
  for (const page of ['last/0', 'last/1', 'next/0', 'next/1']) {
    try {
      const data = await httpGetJson(
        `${SOFA_API}/unique-tournament/${utId}/season/${seasonId}/events/${page}`, {}, signal)
      anyPageOk = true
      for (const e of data?.events || []) {
        const round = e.roundInfo?.round
        if (!round || seen.has(e.id)) continue
        seen.add(e.id)
        const finished = e.status?.type === 'finished'
        out.push({
          round,
          roundName: e.roundInfo?.name || null,
          ts: e.startTimestamp ? e.startTimestamp * 1000 : 0,
          status: e.status?.type,
          home: e.homeTeam?.name, away: e.awayTeam?.name,
          homeImg: e.homeTeam?.id ? teamImg(e.homeTeam.id) : null,
          awayImg: e.awayTeam?.id ? teamImg(e.awayTeam.id) : null,
          homeScore: finished ? e.homeScore?.current ?? null : null,
          awayScore: finished ? e.awayScore?.current ?? null : null,
        })
      }
    } catch { /* offline / challenge */ }
    if (signal?.aborted) break
  }
  // Cachear solo si alguna página respondió: un fallo total de red no debe
  // congelar el calendario una hora.
  if (anyPageOk) cacheSet(leagueEventsCache, utId, { ts: Date.now(), events: out })
  return out
}

const SEARCH_CAP = 30 // máx. consultas de búsqueda por carga de catálogo
const LEAGUE_CAP = 20 // máx. búsquedas de liga por carga

async function mapLimit(list, limit, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) await fn(list[i++])
  }))
}

// Rellena _home.logo / _away.logo / _league.logo cuando el logo de FCTV está
// muerto. 1ª pasada: eventos live por deporte (1 request cada uno). 2ª
// pasada: búsqueda por nombre, acotada por SEARCH_CAP. Best-effort.
// opts.deep=false → solo la pasada live (rápida): las búsquedas por nombre
// se hacen en segundo plano tras pintar las tarjetas.
const ENRICH_BUDGET_MS = 8000  // la llamada getCatalog del manager corta a 15s
const QUICK_BUDGET_MS = 4000

export async function enrichLogos(items, signal, { deep = true } = {}) {
  // Presupuesto propio: la fase de búsquedas no puede tardar más que el
  // timeout del catálogo o el manager descarta TODOS los items del plugin.
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), deep ? ENRICH_BUDGET_MS : QUICK_BUDGET_MS)
  const onAbort = () => ctl.abort()
  if (signal) {
    if (signal.aborted) ctl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const sig = ctl.signal
  try {
    await enrichLogosInner(items, sig, deep)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function enrichLogosInner(items, signal, deep) {
  const bySlug = new Map()
  for (const it of items) {
    const slug = it._sofaSport || SOFA_SPORT[it._sportType]
    if (!slug) continue
    if (!bySlug.has(slug)) bySlug.set(slug, [])
    bySlug.get(slug).push(it)
  }

  await Promise.all([...bySlug].map(async ([slug, list]) => {
    const events = await sofaLiveEvents(slug, signal)
    for (const it of list) {
      const ev = events.find(e =>
        teamsMatch(e.home, it._home?.name) && teamsMatch(e.away, it._away?.name))
      if (!ev) continue
      if (it._home && ev.homeId) it._home.logo = teamImg(ev.homeId)
      if (it._away && ev.awayId) it._away.logo = teamImg(ev.awayId)
      if (it._league && ev.utId) it._league.logo = tournamentImg(ev.utId)
    }
  }))
  if (signal?.aborted) return

  const fillPoster = () => {
    for (const it of items) {
      if (!isDeadLogo(it._home?.logo)) it.poster = it._home.logo
      else if (!isDeadLogo(it._away?.logo)) it.poster = it._away.logo
    }
  }
  if (!deep) { fillPoster(); return }

  const pending = []
  for (const [slug, list] of bySlug) {
    for (const it of list) {
      for (const side of ['_home', '_away']) {
        const t = it[side]
        if (t?.name && isDeadLogo(t.logo)) pending.push({ it, t, slug })
      }
    }
  }
  const seen = new Set()
  const jobs = pending.filter(p => {
    const k = `${p.slug}|${normTeam(p.t.name)}`
    return !seen.has(k) && (seen.add(k), true)
  }).slice(0, SEARCH_CAP)

  await mapLimit(jobs, 4, async (job) => {
    if (signal?.aborted) return
    const e = await sofaFindEntity(job.t.name, job.slug, signal)
    if (!e) return
    const url = e.type === 'player' ? playerImg(e.id) : teamImg(e.id)
    const k = `${job.slug}|${normTeam(job.t.name)}`
    for (const p of pending) {
      if (`${p.slug}|${normTeam(p.t.name)}` === k) p.t.logo = url
    }
  })

  // 3ª pasada: logo de liga por búsqueda de torneo (para ligas sin partido
  // live casado en la 1ª pasada, p.ej. jornadas futuras).
  const lPending = []
  for (const [slug, list] of bySlug) {
    for (const it of list) {
      if (it._league?.name && isDeadLogo(it._league.logo)) lPending.push({ it, slug })
    }
  }
  const lSeen = new Set()
  const lJobs = lPending.filter(p => {
    const k = `${p.slug}|${leagueKey(p.it._league.name) || p.it._league.name}`
    return !lSeen.has(k) && (lSeen.add(k), true)
  }).slice(0, LEAGUE_CAP)

  await mapLimit(lJobs, 4, async (job) => {
    if (signal?.aborted) return
    const id = await sofaFindTournament(job.it._league.name, job.slug, signal)
    if (!id) return
    const url = tournamentImg(id)
    const k = `${job.slug}|${leagueKey(job.it._league.name) || job.it._league.name}`
    for (const p of lPending) {
      if (`${p.slug}|${leagueKey(p.it._league.name) || p.it._league.name}` === k) p.it._league.logo = url
    }
  })

  fillPoster()
}
