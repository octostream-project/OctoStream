// Normalización y comparación de nombres de equipo/jugador entre fuentes
// (Marca, FCTV, Sofascore): minúsculas, sin tildes ni siglas típicas.
//
// Equivalencias léxicas: las fuentes llaman distinto al mismo club
// ("Athletic Club" en DLive = "Athletic Bilbao" en FCTV). 'real' NO se
// recorta: "Real Madrid" vs "Atlético Madrid" colapsaría por includes.
// 'club' tampoco: "Racing Club" ≠ "Racing Santander".
export const normTeam = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(fc|cf|afc|ud|cd|sc|ac|as|rc|rcd|sv|fk|sk|ssc|ogc|vfl|vfb|tsv|tsg|fsv|bc|scb|rcc|rfc|krc|kvc|kfc|sad|ad|ca|cp|de|the|deportivo|1)\b\.?/g, ' ')
  .replace(/\butd\b/g, 'united')
  .replace(/\bdinamo\b/g, 'dynamo')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

// Alias: nombres normalizados que designan al mismo club aunque no se
// contengan ("athletic club" no contiene "athletic bilbao"). Se aplica
// DESPUÉS de normTeam — añadir aquí divergencias que aparezcan en vivo.
const TEAM_ALIASES = {
  'athletic club': 'athletic bilbao',
  'man united': 'manchester united',
  'spurs': 'tottenham',
  'wolves': 'wolverhampton',
  'psg': 'psg',
  'paris saint germain': 'psg',
  'paris sg': 'psg',
  'inter milan': 'inter',
  'internazionale': 'inter',
  'bayer 04 leverkusen': 'leverkusen',
  'borussia monchengladbach': 'gladbach',
  'rb leipzig': 'leipzig',
  'red bull leipzig': 'leipzig',
  'rb salzburg': 'salzburg',
  'red bull salzburg': 'salzburg',
  'red bull bragantino': 'bragantino',
  'sporting lisbon': 'sporting',
  'olympiakos': 'olympiacos',
  'schalke 04': 'schalke',
  'mainz 05': 'mainz',
  'koln': 'cologne',
  'fc cologne': 'cologne',
  'nottm forest': 'nottingham forest',
  'west brom': 'west bromwich',
  'qpr': 'queens park rangers',
  'olympique lyonnais': 'lyon',
  'ol': 'lyon',
  'olympique marseille': 'marseille',
  'om': 'marseille',
  'stade rennais': 'rennes',
  'stade brestois': 'brest',
  'stade reims': 'reims',
  'mhsc': 'montpellier',
  'racing club': 'racing avellaneda',
  'real madrid cf': 'real madrid',
}

export const canonTeam = (s) => {
  const n = normTeam(s)
  return TEAM_ALIASES[n] || n
}

export const teamsMatch = (a, b) => {
  const x = canonTeam(a), y = canonTeam(b)
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x))
}

// ─── Ligas ──────────────────────────────────────────────────────────────────
// DLive nombra ligas con prefijo FIFA ("EGY Premier League") y FCTV con el
// adjetivo ("Egyptian Premier League") o el país ("Egypt Premier League").
// leagueKey normaliza el primer token a código FIFA para que todas casen en
// el mismo grupo; ligas de países distintos ("RUS Premier League") quedan
// separadas de la inglesa ("Premier League").

const COUNTRY_ALIAS = {
  egypt: 'egy', egyptian: 'egy', russia: 'rus', russian: 'rus', spain: 'esp',
  spanish: 'esp', england: 'eng', english: 'eng', france: 'fra', french: 'fra',
  germany: 'ger', german: 'ger', italy: 'ita', italian: 'ita', portugal: 'por',
  portuguese: 'por', netherlands: 'ned', holland: 'ned', dutch: 'ned',
  turkey: 'tur', turkish: 'tur', greece: 'gre', greek: 'gre', ukraine: 'ukr',
  ukrainian: 'ukr', poland: 'pol', polish: 'pol', belgium: 'bel', belgian: 'bel',
  austria: 'aut', austrian: 'aut', switzerland: 'sui', swiss: 'sui',
  scotland: 'sco', scottish: 'sco', argentina: 'arg', argentinian: 'arg',
  brazil: 'bra', brazilian: 'bra', mexico: 'mex', mexican: 'mex', usa: 'usa',
  'united states': 'usa', china: 'chn', chinese: 'chn', japan: 'jpn',
  japanese: 'jpn', korea: 'kor', korean: 'kor', australia: 'aus',
  australian: 'aus', india: 'ind', indian: 'ind', indonesia: 'idn',
  indonesian: 'idn', saudi: 'ksa', qatar: 'qat', morocco: 'mar',
  moroccan: 'mar', algeria: 'dza', algerian: 'dza', tunisia: 'tun',
  tunisian: 'tun', nigeria: 'nga', nigerian: 'nga', chile: 'chi',
  chilean: 'chi', colombia: 'col', colombian: 'col', peru: 'per',
  peruvian: 'per', uruguay: 'uru', uruguayan: 'uru', ecuador: 'ecu',
  ecuadorian: 'ecu', venezuela: 'ven', paraguay: 'par', bolivia: 'bol',
  croatia: 'cro', croatian: 'cro', serbia: 'srb', serbian: 'srb',
  czechia: 'cze', czech: 'cze', slovakia: 'svk', slovenia: 'svn',
  romania: 'rou', romanian: 'rou', bulgaria: 'bul', bulgarian: 'bul',
  hungary: 'hun', hungarian: 'hun', denmark: 'den', danish: 'den',
  sweden: 'swe', swedish: 'swe', norway: 'nor', norwegian: 'nor',
  finland: 'fin', finnish: 'fin', ireland: 'irl', irish: 'irl',
  iceland: 'isl', cyprus: 'cyp', israel: 'isr', iran: 'irn', iraq: 'irq',
  kazakhstan: 'kaz', uzbekistan: 'uzb', georgia: 'geo', armenia: 'arm',
  azerbaijan: 'aze', bahrain: 'bhr', kuwait: 'kuw', oman: 'omn',
  jordan: 'jor', lebanon: 'lbn', syria: 'syr', vietnam: 'vie', thailand: 'tha',
  malaysia: 'mas', singapore: 'sgp', philippines: 'phi', taiwan: 'twn',
  pakistan: 'pak', bangladesh: 'ban', canada: 'can', canadian: 'can',
  wales: 'wal', welsh: 'wal', burundi: 'bdi', kenya: 'ken', ghana: 'gha',
  cameroon: 'cmr', senegal: 'sen', mali: 'mli', zambia: 'zam', congo: 'cod',
}

const normName = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

export const leagueKey = (name) => {
  const n = normName(name)
  if (!n) return ''
  const parts = n.split(' ')
  parts[0] = COUNTRY_ALIAS[parts[0]] || parts[0]
  return parts.join(' ')
}
