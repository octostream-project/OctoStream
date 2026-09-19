// Regenera src/data/marcaCalendar.js scrapeando los calendarios de marca.com.
// Por cada liga extrae la última jornada jugada y la próxima (con fecha/hora),
// incluyendo el enlace al "directo" de Marca cuando existe en la página.
//
//   node scripts/update-marca-calendar.mjs

import { writeFile } from 'node:fs/promises'

// [slug-marca, nombre, id de torneo en Sofascore] — el logo de competición se
// sirve desde el CDN público de Sofascore (Marca no expone el de competición).
const LEAGUES = [
  ['primera-division', 'LaLiga EA Sports', 8],
  ['premier-league', 'Premier League', 17],
  ['liga-italiana', 'Serie A', 23],
  ['bundesliga', 'Bundesliga', 35],
  ['liga-francesa', 'Ligue 1', 34],
  ['segunda-division', 'LaLiga Hypermotion', 54],
  ['champions-league', 'Champions League', 7],
  ['europa-league', 'Europa League', 679],
]

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

async function fetchPage(slug) {
  const res = await fetch(`https://www.marca.com/futbol/${slug}/calendario.html`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'es' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // Marca sirve ISO-8859-15: res.text() decodifica UTF-8 y corrompe los
  // acentos ("Málaga" → mojibake). Decodificar con el charset real.
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') || '')?.[1] || 'utf-8'
  return new TextDecoder(charset).decode(await res.arrayBuffer())
}

// Enlaces {homeId}_{awayId}-directo.html repartidos por la página.
function parseLinks(html) {
  const links = new Map()
  for (const m of html.matchAll(/href="(https:\/\/www\.marca\.com\/futbol\/[^"#]+?_(\d+)_(\d+)-directo\.html)"/g)) {
    if (!links.has(`${m[2]}_${m[3]}`)) links.set(`${m[2]}_${m[3]}`, m[1])
  }
  return links
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

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

async function scrapeLeague(slug, name) {
  const html = await fetchPage(slug)
  const links = parseLinks(html)

  // Secciones id="jornadaN" en orden de aparición
  const marks = [...html.matchAll(/id="jornada(\d+)"/g)]
    .map(m => ({ n: Number(m[1]), pos: m.index }))
    .sort((a, b) => a.pos - b.pos)
  const secs = marks.map((m, i) => ({
    n: m.n,
    html: html.slice(m.pos, i + 1 < marks.length ? marks[i + 1].pos : undefined),
  }))

  // Primera jornada sin resultados = próxima jornada
  const nextIdx = secs.findIndex(s => !s.html.includes('resultado-partido'))
  const pick = nextIdx > 0
    ? [secs[nextIdx - 1], secs[nextIdx]]
    : nextIdx === 0 ? [secs[0]] : secs.slice(-2)

  const jornadas = pick.map(({ n, html: sec }) => {
    const matches = parseJornada(sec)
    for (const m of matches) {
      m.link = links.get(`${m.home.id}_${m.away.id}`) || links.get(`${m.away.id}_${m.home.id}`) || null
    }
    return { round: n, matches }
  })
  return { slug, name, jornadas }
}

const sofascoreLogo = (id) => `https://img.sofascore.com/api/v1/unique-tournament/${id}/image`

const out = []
for (const [slug, name, tournamentId] of LEAGUES) {
  try {
    const league = await scrapeLeague(slug, name)
    league.logo = sofascoreLogo(tournamentId)
    out.push(league)
    console.log(`${name}:`, league.jornadas.map(j => `J${j.round}(${j.matches.length})`).join(' '))
  } catch (e) {
    console.warn(`${name}: FAILED ${e.message}`)
  }
}

const js = `// Calendario de las principales ligas — extraído de marca.com por
// scripts/update-marca-calendar.mjs (workflow sports-calendar, 2× al día).
// match.link apunta a la página del directo en Marca cuando existe.
export const MARCA_LEAGUES = ${JSON.stringify(out, null, 2)}
`
await writeFile(new URL('../src/data/marcaCalendar.js', import.meta.url), js)
console.log('marcaCalendar.js written')
