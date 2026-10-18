// Calendario Marca en runtime — port de scripts/update-marca-calendar.mjs.
// El fichero empaquetado (src/data/marcaCalendar.js) se regenera solo con
// cada build y queda desfasado en la app instalada; la API de Sofascore
// (alternativa runtime) challengea con 403 desde muchas IPs — marca.com
// sigue abierto, así que las jornadas reales se sacan scrapeando sus
// páginas de calendario como hace el workflow CI.
//
// Devuelve la MISMA estructura que MARCA_LEAGUES[].jornadas:
//   Map<slug, [{round, matches:[{home{id,name,logo}, away, result, date, time, link}]}]>

import { httpGetBlobWithHeaders } from './httpClient.js'

// slug del calendario en la URL de Marca: futbol/{slug}/calendario.html.
// Son las mismas ligas que regenera scripts/update-marca-calendar.mjs.
export const MARCA_SLUGS = new Set([
  'primera-division', 'premier-league', 'liga-italiana', 'bundesliga',
  'liga-francesa', 'segunda-division', 'champions-league', 'europa-league',
])

const PAGE_URL = (slug) => `https://www.marca.com/futbol/${slug}/calendario.html`
const MARCA_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const CACHE_TTL = 6 * 60 * 60 * 1000
const cache = new Map() // slug → { ts, jornadas }

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// Marca sirve ISO-8859-15: decodificar con el charset real del header o los
// acentos salen corruptos ("Málaga" → mojibake).
async function fetchPage(slug, signal) {
  const { data, headers } = await httpGetBlobWithHeaders(PAGE_URL(slug), {
    'User-Agent': MARCA_UA,
    'Accept-Language': 'es',
  }, signal)
  // Android devuelve base64 (blob nativo); web/Electron un Blob real.
  const buf = typeof data === 'string'
    ? (/^[A-Za-z0-9+/]+={0,2}$/.test(data) ? b64ToBytes(data) : new TextEncoder().encode(data))
    : await data.arrayBuffer()
  const ct = headers['content-type'] || headers['Content-Type'] || ''
  const charset = /charset=([\w-]+)/i.exec(ct)?.[1] || 'iso-8859-15'
  let html
  try {
    html = new TextDecoder(charset).decode(buf)
  } catch {
    html = new TextDecoder('iso-8859-15').decode(buf)
  }
  if (!html || html.length < 1000) throw new Error('empty page')
  return html
}

// Enlaces {homeId}_{awayId}-directo.html repartidos por la página.
function parseLinks(html) {
  const links = new Map()
  for (const m of html.matchAll(/href="(https:\/\/www\.marca\.com\/futbol\/[^"#]+?_(\d+)_(\d+)-directo\.html)"/g)) {
    if (!links.has(`${m[2]}_${m[3]}`)) links.set(`${m[2]}_${m[3]}`, m[1])
  }
  return links
}

// Marca sirve '?' literal para caracteres que ISO-8859-15 no cubre (ń, ň…)
// y entidades HTML ocasionales; limpiar ambos para que el nombre sea usable.
function cleanName(s) {
  return s
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/\?+/g, '')
    .trim()
}

function parseTeam(td) {
  const tid = td.match(/equipo_t(\d+)/)
  const logo = td.match(/(https:\/\/[^"]+\.png)/)
  const name = td.match(/equipo_t\d+">([^<]+)</)
  return {
    id: tid ? Number(tid[1]) : 0,
    name: name ? cleanName(name[1]) : '',
    logo: logo ? logo[1] : '',
  }
}

function parseJornada(sec) {
  const matches = []
  for (const tr of sec.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const tds = [...tr[1].matchAll(/<td class="(local|resultado|visitante)">([\s\S]*?)<\/td>/g)]
    if (tds.length !== 3) continue
    const home = parseTeam(tds[0][2])
    const away = parseTeam(tds[2][2])
    if (!home.name || !away.name) continue
    const res = tds[1][2]
    const score = res.match(/resultado-partido">([^<]+)</)
    const fecha = res.match(/fecha">([^<]+)</)
    const hora = res.match(/hora">([^<]+)</)
    matches.push({
      home, away,
      result: score ? score[1].trim() : null,
      date: fecha ? fecha[1] : null,
      time: hora ? hora[1] : null,
    })
  }
  return matches
}

async function scrapeLeague(slug, signal) {
  const html = await fetchPage(slug, signal)
  const links = parseLinks(html)

  // Secciones id="jornadaN" en orden de aparición.
  const marks = [...html.matchAll(/id="jornada(\d+)"/g)]
    .map(m => ({ n: Number(m[1]), pos: m.index }))
    .sort((a, b) => a.pos - b.pos)
  const secs = marks.map((m, i) => ({
    n: m.n,
    html: html.slice(m.pos, i + 1 < marks.length ? marks[i + 1].pos : undefined),
  }))

  // Primera jornada sin resultados = próxima jornada — la página solo lleva
  // la última jugada y la siguiente, que es lo que la vista necesita.
  const nextIdx = secs.findIndex(s => !s.html.includes('resultado-partido'))
  const pick = nextIdx > 0
    ? [secs[nextIdx - 1], secs[nextIdx]]
    : nextIdx === 0 ? [secs[0]] : secs.slice(-2)

  return pick.map(({ n, html: sec }) => {
    const matches = parseJornada(sec)
    for (const m of matches) {
      m.link = links.get(`${m.home.id}_${m.away.id}`) || links.get(`${m.away.id}_${m.home.id}`) || null
    }
    return { round: n, matches }
  })
}

/**
 * Jornadas actuales de Marca para las ligas con calendario (slugs de
 * MARCA_SLUGS). Devuelve Map<slug, jornadas[]> — mismo shape que
 * MARCA_LEAGUES[].jornadas. Caché de 6 h por liga; los fallos no se
 * cachean (reintento en la próxima carga).
 */
export async function fetchMarcaCalendar(leagueSlugs, signal) {
  const out = new Map()
  const jobs = []
  for (const s of leagueSlugs) {
    const hit = cache.get(s)
    if (hit && Date.now() - hit.ts < CACHE_TTL) { out.set(s, hit.jornadas); continue }
    jobs.push(() => scrapeLeague(s, signal)
      .then(jornadas => { cache.set(s, { ts: Date.now(), jornadas }); out.set(s, jornadas) })
      .catch(() => {})) // liga sin datos: el fallback empaquetado/Sofascore cubre
  }
  // Concurrencia 4: suficiente para 8 ligas sin martillear marca.com.
  for (let i = 0; i < jobs.length; i += 4) {
    if (signal?.aborted) break
    await Promise.all(jobs.slice(i, i + 4).map(j => j()))
  }
  return out
}
