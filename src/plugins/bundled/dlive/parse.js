// Parser puro del HTML de schedule de dlive/daddylive — sin dependencias de
// red para poder testearlo con fixtures.

export const decodeEntities = (s) => String(s || '')
  .replace(/&#0?39;|&apos;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))

// Strip emojis, regional-indicator flags and icon prefixes (⚽ 📺 🏀 …).
export const stripIcons = (s) => decodeEntities(s)
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
  .replace(/\s{2,}/g, ' ')
  .trim()

// "La Liga : Team A vs Team B" → { league, title, home, away }
export function parseEventTitle(raw) {
  const clean = stripIcons(raw)
  const ci = clean.indexOf(' : ')
  const league = ci > 0 ? clean.slice(0, ci).trim() : ''
  const rest = ci > 0 ? clean.slice(ci + 3).trim() : clean
  const m = rest.match(/^(.*?)\s+vs\.?\s+(.*)$/i)
  if (!m) return { league, title: rest, home: null, away: null }
  return { league, title: rest, home: m[1].trim(), away: m[2].trim() }
}

const LIVE_CAT_RE = /live now/i
const LINK_RE = /href="(\/(?:watchlivelive|watchextra|watchstreamed|watch|stream\/stream)[^"]*)"[^>]*>([^<]*)</g

// Parse a schedule HTML fragment (main page or schedule-api html payload).
// Returns events: { title, league, home, away, category, time, live, links }
export function parseSchedule(html, base = 'https://dlive.sx') {
  const events = []
  if (!html) return events
  const chunks = html.split('schedule__catHeader')
  for (const chunk of chunks.slice(1)) {
    const catM = chunk.match(/card__meta">([^<]+)/)
    if (!catM) continue
    const category = stripIcons(catM[1])
    const liveCat = LIVE_CAT_RE.test(category)
    const evBlocks = chunk.split('schedule__event">')
    for (const eb of evBlocks.slice(1)) {
      const titleM = eb.match(/schedule__eventTitle">([^<]+)/)
      if (!titleM) continue
      const timeM = eb.match(/schedule__time[^>]*data-time="([^"]+)"/) ||
                    eb.match(/schedule__time[^>]*>([^<]+)/)
      const parsed = parseEventTitle(titleM[1])
      const links = []
      LINK_RE.lastIndex = 0
      let lm
      while ((lm = LINK_RE.exec(eb))) {
        links.push({ label: decodeEntities(lm[2]).trim() || 'Stream', url: base + lm[1] })
      }
      if (!links.length) continue
      events.push({ ...parsed, category, time: (timeM?.[1] || '').trim(), live: liveCat, links: sortLinks(links) })
    }
  }
  return events
}

// watchlivelive.php?id=HEX → iframe src with ?url=<m3u8>. Returns
// { url, referer } or null when the page doesn't expose a direct playlist.
export function extractLiveLiveUrl(pageHtml) {
  const m = String(pageHtml || '').match(/playerFrame[^>]*src="([^"]+)"/) ||
            String(pageHtml || '').match(/<iframe[^>]*src="([^"]+)"/)
  if (!m) return null
  const src = m[1].replace(/&amp;/g, '&')
  // url= es el último parámetro y su valor contiene los suyos propios
  // (?txSecret=…&txTime=…): coger TODO hasta el final del src, no parar en '&'.
  const u = src.match(/[?&]url=(.+)$/)
  if (!u) return null
  let m3u8 = decodeURIComponent(u[1]).replace(/&amp;/g, '&')
  // Formato nuevo: url= lleva el m3u8 firmado en base64.
  if (!/^https?:\/\//.test(m3u8)) {
    try { m3u8 = atob(m3u8) } catch { return null }
  }
  if (!/^https?:\/\//.test(m3u8) || !/\.m3u8/.test(m3u8)) return null
  let referer = ''
  try { referer = new URL(src).origin + '/' } catch { /* optional */ }
  return { url: m3u8, referer }
}

// Category → catalog id (mirrors the fctv sport buckets so Sports.jsx can
// merge both providers per catalog).
//
// La categoría del site manda: "Handball" con liga "Champions League" es
// balonmano, no fútbol. El nombre de la liga solo se usa cuando la categoría
// es genérica (LIVE NOW, Other…) o no dice el deporte.
const CATEGORY_RULES = [
  { id: 'dlive-football', re: /soccer|futsal|\bfootball\b/i, not: /american|am\.|nfl|aussie|\bafl\b|gaelic|flag|college football|high school football|ncaa football/i },
  { id: 'dlive-basketball', re: /basketball|wnba|\bnba\b|euroleague|fiba|3x3/i },
  { id: 'dlive-tennis', re: /tennis|\batp\b|\bwta\b|davis cup/i },
  { id: 'dlive-motor', re: /motor|nascar|formula|motogp|superbike|rally|indy|\bf1\b|racing/i, not: /horse/i },
]

// Categorías de otros deportes: la liga no debe reclasificarlas
// ("Champions League" de balonmano/voleibol no es fútbol).
const OTHER_SPORT_CAT = /volleyball|handball|rugby|cricket|baseball|mlb|hockey|nhl|golf|darts|snooker|squash|mma|ufc|boxing|wrestling|fight|cycling|badminton|sailing|athletics|swimming|horse|polo|softball|lacrosse|table tennis|biathlon|curling|ski|skat|luge|e-?sport|gaming|billiards|pool|bowls|netball|water polo|rowing|canoe|gymnastics|weightlift|judo|taekwondo|karate|triathlon|archery|shooting|fencing|surf|skate|climbing|pickleball|padel|chess|poker|american|nfl|college football|high school|aussie|\bafl\b|gaelic/i

// Ligas/e-sports de fútbol frecuentes en el schedule (solo se evalúan cuando
// la categoría no decide).
const FOOTBALL_LEAGUE_RE = /soccer|futsal|premier league|la ?liga|serie a|bundesliga|ligue 1|champions league|europa league|conference league|libertadores|sudamericana|copa|world cup|euro 20|eafc|ea fc|fc ?2[0-9]|vs-fb|eredivisie|primeira|mls|liga mx|scottish|fa cup|carabao|dfb|erediv/i
const TEXT_RULES = [
  { id: 'dlive-basketball', re: /basketball|wnba|\bnba\b|euroleague|fiba|3x3/i },
  { id: 'dlive-tennis', re: /tennis|\batp\b|\bwta\b|davis cup/i },
  { id: 'dlive-motor', re: /motorsport|formula ?1|nascar|motogp|superbike|rally|indy|\bf1\b/i, not: /horse/i },
  { id: 'dlive-football', re: FOOTBALL_LEAGUE_RE },
]

export const catalogFor = (category, league) => {
  const c = String(category || '')
  for (const r of CATEGORY_RULES) {
    if (r.re.test(c) && !(r.not && r.not.test(c))) return r.id
  }
  if (OTHER_SPORT_CAT.test(c)) return 'dlive-others'
  const s = league || c
  for (const r of TEXT_RULES) {
    if (r.re.test(s) && !(r.not && r.not.test(s))) return r.id
  }
  return 'dlive-others'
}

// Categoría → slug de deporte en Sofascore (para el enriquecimiento de
// escudos en utils/sofascore.js). Misma filosofía: categoría primero.
const SOFA_CAT_RULES = [
  { slug: 'football', re: /soccer|futsal|\bfootball\b/i, not: /american|am\.|nfl|aussie|\bafl\b|gaelic|flag|college football|high school football|ncaa football/i },
  { slug: 'basketball', re: /basketball|wnba|\bnba\b|euroleague|fiba|3x3/i },
  { slug: 'tennis', re: /tennis|\batp\b|\bwta\b|davis cup/i },
  { slug: 'motorsport', re: /motor|nascar|formula|motogp|superbike|rally|indy|\bf1\b|racing/i, not: /horse/i },
  { slug: 'american-football', re: /american|am\.|nfl|college football|high school football|ncaa football/i },
  { slug: 'ice-hockey', re: /ice hockey|\bnhl\b|ushl|\bohl\b|\bwhl\b|\bshl\b|\bdel\b/i },
  { slug: 'aussie-rules', re: /aussie|\bafl\b/i },
  { slug: 'handball', re: /handball/i },
  { slug: 'cricket', re: /cricket/i },
  { slug: 'volleyball', re: /volleyball/i },
  { slug: 'baseball', re: /baseball|\bmlb\b/i },
  { slug: 'rugby', re: /rugby/i },
  { slug: 'mma', re: /\bmma\b|ufc|boxing|bellator|wrestling|\bfight\b/i },
  { slug: 'badminton', re: /badminton/i },
  { slug: 'cycling', re: /cycling|\buci\b/i },
  { slug: 'darts', re: /darts/i },
  { slug: 'snooker', re: /snooker/i },
  { slug: 'golf', re: /golf|\bpga\b/i },
]
export const sofaSportFor = (category, league) => {
  const c = String(category || '')
  for (const r of SOFA_CAT_RULES) if (r.re.test(c) && !(r.not && r.not.test(c))) return r.slug
  // Categoría genérica (LIVE NOW, Other…): la liga suele llevar el deporte
  // ("Basketball Champions League", "VS-FB EAFC24 Champions League").
  const l = String(league || '')
  for (const r of SOFA_CAT_RULES) if (r.re.test(l) && !(r.not && r.not.test(l))) return r.slug
  if (FOOTBALL_LEAGUE_RE.test(l)) return 'football'
  return null
}

const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim()

export const eventKey = (e) => (e.home && e.away)
  ? `${norm(e.home)}|${norm(e.away)}|${norm(e.league)}`
  : `t|${norm(e.title)}|${norm(e.category)}`

// Clave sin liga: para casar el mismo partido cuando una fuente no la da
// (extra_backup no lleva "Spain LaLiga", solo "Betis vs Getafe"). Solo se usa
// como comodín cuando a UNO de los dos lados le falta la liga — si ambas
// fuentes la dan y difiere (liga vs copa, mismo día), son partidos distintos.
export const eventKeyNoLeague = (e) => (e.home && e.away)
  ? `${norm(e.home)}|${norm(e.away)}`
  : null

// Las fuentes de respaldo (extra_backup) dejaron de dar el nombre real del
// canal/emisora y ahora etiquetan sus enlaces con códigos genéricos
// ("admin Stream", "delta Stream", "foxtrot Stream", "golf Stream", "hotel
// Stream"…) — alfabeto fonético + "admin". Se reconocen para mandarlos al
// final del picker en vez de tapar el nombre real cuando existe.
const GENERIC_LABEL_RE = /^(alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliet|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|x-?ray|yankee|zulu|admin)\s*stream$/i
export const isGenericLabel = (label) => GENERIC_LABEL_RE.test(String(label || '').trim())

// Canales con nombre real primero; los códigos genéricos de respaldo van al
// final — siguen disponibles (a veces son el único enlace) pero no tapan un
// nombre real cuando lo hay. Orden estable dentro de cada grupo.
export function sortLinks(links) {
  return [...links].sort((a, b) => (isGenericLabel(a.label) ? 1 : 0) - (isGenericLabel(b.label) ? 1 : 0))
}

// djb2 — id estable y corto (mismo id en getCatalog/getStreams).
export const eventId = (e) => {
  const k = eventKey(e)
  let h = 5381
  for (let i = 0; i < k.length; i++) h = ((h << 5) + h + k.charCodeAt(i)) >>> 0
  return `dlive:${h.toString(36)}`
}
