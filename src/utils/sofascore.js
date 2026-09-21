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
export const tournamentImg = (id) => `${SOFA_API}/unique-tournament/${id}/image`

// Deportes individuales: home/away son jugadores, no equipos. La foto cuelga
// de /player/{id}/image (los dobles existen como "team" → logoAlt) y el
// casado es por apellido — FCTV da "Apellido I." y las iniciales no comparan.
const INDIVIDUAL_SPORTS = new Set([
  'tennis', 'badminton', 'table-tennis', 'mma', 'boxing', 'darts',
  'snooker', 'squash', 'esports',
])

// Apellidos = tokens de más de una letra (descarta iniciales sueltas).
const surnameTokens = (name) => normTeam(name).split(' ').filter(t => t.length > 1)

// Casado por apellido para deportes individuales: "Sinner J." ⇔ "Jannik
// Sinner". Dobles ("A / B") casan si cualquier apellido coincide.
const playersMatch = (a, b) => {
  if (teamsMatch(a, b)) return true
  const sa = surnameTokens(a)
  if (!sa.length) return false
  const sb = new Set(surnameTokens(b))
  return sa.some(t => sb.has(t))
}

// El CDN de logos de FCTV (logos*.<dominio-rotativo>.cfd) está muerto:
// NXDOMAIN incluso en DNS público. Tratar esos URLs como "sin logo".
const isDeadLogo = (u) => !u || /^https?:\/\/logos\d*\.[a-z0-9-]+\.cfd\//i.test(u)

const LIVE_TTL = 60 * 1000
const liveCache = new Map() // sport slug → { ts, events }

const sofaEvent = (e) => ({
  home: e.homeTeam?.name, homeId: e.homeTeam?.id,
  away: e.awayTeam?.name, awayId: e.awayTeam?.id,
  utId: e.tournament?.uniqueTournament?.id,
  tournament: e.tournament?.uniqueTournament?.name || e.tournament?.name || null,
})

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
    events = (data?.events || []).map(sofaEvent)
  } catch { /* offline / challenge — pasada de búsqueda cubre */ }
  cacheSet(liveCache, slug, { ts: Date.now(), events })
  return events
}

// Búsqueda de equipo/jugador por nombre → id de imagen. Cacheada por sesión;
// los ids de Sofascore son estables.
const entityCache = new Map() // `${slug}|${norm}` → {id,type} | null

// Variantes de query: el nombre tal cual, el primer jugador de una pareja de
// dobles ("A / B"), el nombre sin cualificadores ("(F)", "Women", "U21"…
// → el equipo base como escudo de respaldo) y el apellido suelto para
// jugadores individuales ("Sinner J." → "sinner").
function nameQueries(name, slug) {
  const qs = [name]
  const pair = String(name).split(/\s*[\/&]\s*/).filter(Boolean)
  if (pair.length > 1) qs.push(pair[0])
  const clean = String(name)
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\b(women|woman|fem|femenina?|f|w)\b/gi, ' ')
    .replace(/\b(u1[6-9]|u2[0-3]|reserves?|ii|b)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim()
  if (clean && clean !== name) qs.push(clean)
  if (INDIVIDUAL_SPORTS.has(slug)) {
    const sn = surnameTokens(name).join(' ')
    if (sn && !qs.includes(sn)) qs.push(sn)
  }
  return qs
}

async function sofaFindEntity(name, slug, signal) {
  const key = `${slug}|${normTeam(name)}`
  if (entityCache.has(key)) return entityCache.get(key)
  let found = null
  let ok = false
  for (const q of nameQueries(name, slug)) {
    try {
      const data = await httpGetJson(`${SOFA_API}/search/all?q=${encodeURIComponent(q)}`, {}, signal)
      ok = true
      const cands = (data?.results || [])
        .filter(r => r.type === 'team' || r.type === 'player')
      // Preferir candidatos del mismo deporte cuando el resultado lo declara
      // ("Arsenal" también existe en baloncesto).
      const sameSport = cands.filter(r =>
        !slug || !r.entity?.sport?.slug || r.entity.sport.slug === slug)
      const pool = sameSport.length ? sameSport : cands
      const hit = pool.find(r => teamsMatch(r.entity?.name, name))
        || (INDIVIDUAL_SPORTS.has(slug)
            && pool.find(r => r.type === 'player' && playersMatch(r.entity?.name, name)))
        || (q !== name && pool.find(r => teamsMatch(r.entity?.name, q)))
      if (hit) { found = { id: hit.entity.id, type: hit.type }; break }
    } catch { /* sin resultado */ }
  }
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

// utId opcional: id de unique-tournament conocido — evita la búsqueda por
// nombre, que es ambigua (hay varias "Copa del Rey", una por deporte).
export async function fetchLeagueEvents(leagueName, slug = 'football', signal, utId = null) {
  if (!utId) utId = await sofaFindTournament(leagueName, slug, signal)
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
  // Las 4 páginas son independientes (2 pasadas + 2 futuras) — pedirlas en
  // paralelo en vez de una tras otra corta el tiempo de 4 round-trips a 1.
  const pages = ['last/0', 'last/1', 'next/0', 'next/1']
  const results = await Promise.allSettled(pages.map(page =>
    httpGetJson(`${SOFA_API}/unique-tournament/${utId}/season/${seasonId}/events/${page}`, {}, signal)))
  for (const r of results) {
    if (r.status !== 'fulfilled') continue // offline / challenge
    anyPageOk = true
    for (const e of r.value?.events || []) {
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
  }
  // Cachear solo si alguna página respondió: un fallo total de red no debe
  // congelar el calendario una hora.
  if (anyPageOk) cacheSet(leagueEventsCache, utId, { ts: Date.now(), events: out })
  return out
}

const SEARCH_CAP = 60 // máx. consultas de búsqueda por carga de catálogo
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
const ENRICH_BUDGET_MS = 12000  // la pasada deep solo corre en background tras pintar
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
    const individual = INDIVIDUAL_SPORTS.has(slug)
    const sideOk = individual ? playersMatch : teamsMatch
    const img = individual ? playerImg : teamImg
    for (const it of list) {
      const ev = events.find(e =>
        sideOk(e.home, it._home?.name) && sideOk(e.away, it._away?.name))
      if (!ev) continue
      // Dobles: la pareja existe como entidad "team" — logoAlt por si el
      // endpoint de jugador no la tiene.
      if (it._home && ev.homeId) {
        it._home.logo = img(ev.homeId)
        if (individual) it._home.logoAlt = teamImg(ev.homeId)
      }
      if (it._away && ev.awayId) {
        it._away.logo = img(ev.awayId)
        if (individual) it._away.logoAlt = teamImg(ev.awayId)
      }
      if (it._league && ev.utId) it._league.logo = tournamentImg(ev.utId)
      // Sofascore sabe la competición real: los providers a veces etiquetan
      // mal la liga (Copa del Rey listada bajo La Liga). Re-etiquetar cuando
      // difiere de verdad — la comparación compacta ignora "La Liga"≈"LaLiga"
      // para no partir una liga en dos grupos.
      if (it._league?.name && ev.tournament) {
        const cur = leagueKey(it._league.name).replace(/\s+/g, '')
        const real = leagueKey(ev.tournament).replace(/\s+/g, '')
        if (real && cur !== real) it._league = { ...it._league, name: ev.tournament }
      }
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
