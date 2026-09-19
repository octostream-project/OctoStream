import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'
import { getItemSync } from '../../utils/storage.js'

const OPENSUBS_API = 'https://api.opensubtitles.com/api/v1'
// Addon público de Stremio (OpenSubtitles v3): no necesita API key ni login.
// Solo indexa por IMDB id: /subtitles/movie/ttXXX.json y
// /subtitles/series/ttXXX:temporada:episodio.json
const OPENSUBS_STREMIO = 'https://opensubtitles-v3.strem.io'

function getStoredToken() {
  return getItemSync('octostream_opensubs_token') || ''
}

function getStoredApiKey() {
  return getItemSync('octostream_opensubs_apikey') || ''
}

async function osFetch(endpoint, params = {}) {
  const apiKey = getStoredApiKey()
  const token = getStoredToken()
  if (!apiKey) throw new Error('OpenSubtitles API key no configurada')

  const url = new URL(`${OPENSUBS_API}${endpoint}`)
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  })

  const headers = {
    'Api-Key': apiKey,
    'Content-Type': 'application/json',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
  })
  if (!res.ok) throw new Error(`OpenSubtitles error: ${res.status}`)
  return res.json()
}

// ISO-639-1 → ISO-639-2 para el campo "lang" del addon (spa, eng, ger…)
const LANG_ISO2 = {
  es: 'spa', en: 'eng', de: 'ger', fr: 'fre', it: 'ita', pt: 'por',
  ca: 'cat', gl: 'glg', eu: 'baq', ja: 'jpn', ko: 'kor', zh: 'chi',
}

function langRank(lang, preferred) {
  const idx = preferred.findIndex(p => p === lang || LANG_ISO2[p] === lang)
  return idx === -1 ? preferred.length : idx
}

// Búsqueda vía addon Stremio: requiere imdbId (tt…). Para series el id es
// "ttXXX:temporada:episodio". Devuelve el mismo shape que la API oficial.
async function stremioSearch({ imdbId, season, episode, languages }) {
  if (!imdbId) throw new Error('Se necesita IMDB id para buscar sin API key')
  const isSeries = season != null && episode != null
  const id = isSeries ? `${imdbId}:${season}:${episode}` : imdbId
  const type = isSeries ? 'series' : 'movie'
  const res = await fetch(`${OPENSUBS_STREMIO}/subtitles/${type}/${id}.json`, {
    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
  })
  if (!res.ok) throw new Error(`OpenSubtitles addon error: ${res.status}`)
  const data = await res.json()
  const preferred = (languages || 'es,en').split(',').map(l => l.trim().toLowerCase())
  return (data.subtitles || [])
    .map(sub => ({
      id: sub.id,
      language: sub.lang,
      releaseName: sub.subtitleFileName || sub.movieReleaseName || '',
      url: sub.url,
      downloadUrl: sub.url,
      encoding: sub.SubEncoding || 'UTF-8',
      fps: sub.fpsMilli ? sub.fpsMilli / 1000 : null,
      season: sub.season || null,
      episode: sub.episode || null,
    }))
    .sort((a, b) => langRank(a.language, preferred) - langRank(b.language, preferred))
}

export const openSubtitlesPlugin = createPlugin(
  new PluginManifest({
    id: 'opensubtitles',
    name: 'OpenSubtitles',
    version: '1.0.0',
    description: 'Búsqueda y descarga de subtítulos desde OpenSubtitles.com',
    types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
    catalogs: [],
    icon: 'captions',
  }),
  {
    searchSubtitles: async ({ query, languages = 'es,en', imdbId, season, episode }) => {
      // Sin API key: usar el addon de Stremio (indexa por IMDB id).
      if (!getStoredApiKey()) {
        return stremioSearch({ imdbId, season, episode, languages })
      }

      const params = { query, languages }
      if (imdbId) params.imdb_id = imdbId
      if (season) params.season_number = season
      if (episode) params.episode_number = episode

      const data = await osFetch('/subtitles', params)
      return (data.data || []).map(sub => ({
        id: sub.id,
        language: sub.attributes.language,
        releaseName: sub.attributes.release,
        url: sub.attributes.url,
        downloadUrl: sub.attributes.url,
        rating: sub.attributes.ratings,
        downloads: sub.attributes.download_count,
        hearingImpaired: sub.attributes.hearing_impaired,
        fromTrusted: sub.attributes.from_trusted,
      }))
    },

    downloadSubtitle: async (fileUrl, encoding) => {
      const apiKey = getStoredApiKey()
      const isStremio = typeof fileUrl === 'string' && fileUrl.includes('strem.io')
      const res = await fetch(fileUrl, {
        headers: apiKey && !isStremio ? { 'Api-Key': apiKey } : {},
        signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
      })
      if (!res.ok) throw new Error('Error descargando subtítulo')
      // El addon declara SubEncoding (CP1252 en muchos subs antiguos):
      // decodificarlo evita mojibake en acentos/eñes.
      if (encoding && !/^utf-?8$/i.test(encoding)) {
        const buf = await res.arrayBuffer()
        try {
          return new TextDecoder(encoding === 'CP1252' ? 'windows-1252' : encoding).decode(buf)
        } catch {
          return new TextDecoder('utf-8').decode(buf)
        }
      }
      return res.text()
    },

    search: async () => [],
    getStreams: async () => [],
  }
)
