import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'

const OPENSUBS_API = 'https://api.opensubtitles.com/api/v1'

function getStoredToken() {
  return localStorage.getItem('optopus_opensubs_token') || ''
}

function getStoredApiKey() {
  return localStorage.getItem('optopus_opensubs_apikey') || ''
}

async function osFetch(endpoint, params = {}) {
  const apiKey = getStoredApiKey()
  const token = getStoredToken()
  if (!apiKey) throw new Error('OpenSubtitles API key no configurada')

  const url = new URL(`${OPENSUBS_API}${endpoint}`)
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  })

  const res = await fetch(url.toString(), {
    headers: {
      'Api-Key': apiKey,
      'Authorization': token ? `Bearer ${token}` : '',
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) throw new Error(`OpenSubtitles error: ${res.status}`)
  return res.json()
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

    downloadSubtitle: async (fileUrl) => {
      const apiKey = getStoredApiKey()
      const res = await fetch(fileUrl, {
        headers: { 'Api-Key': apiKey },
      })
      if (!res.ok) throw new Error('Error descargando subtítulo')
      return res.text()
    },

    search: async () => [],
    getStreams: async () => [],
  }
)
