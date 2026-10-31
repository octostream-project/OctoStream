// Aviso de episodios nuevos: revisa las series de Mi Lista/historial contra
// TMDB (getSeriesUpcoming) y devuelve las que tienen un último episodio
// emitido que el usuario aún no ha visto ni descartado.
// La marca de "ya visto el aviso" vive en octostream_epseen por serie.
import { getSeriesUpcoming } from '../plugins/builtIn/tmdb.js'
import { getJsonSync, setJsonSync } from './storage.js'

const CHECK_KEY = 'octostream_epcheck_at'
const SEEN_KEY = 'octostream_epseen'
const CHECK_INTERVAL = 6 * 3600 * 1000
const MAX_SERIES = 8
// En la primera pasada (sin marcas) solo cuenta lo emitido en esta ventana —
// si no, la primera ejecución llenaría el aviso con estrenos de hace meses.
const FIRST_RUN_WINDOW_DAYS = 21

const todayStr = () => new Date().toISOString().slice(0, 10)

// items: [{id, name, poster}] series tipo tmdb-series-*. Devuelve
// [{id, name, poster, season, episode, epName, airDate}] ya filtrados.
export async function checkNewEpisodes(items, { force = false, watchedEpisodes = {}, signal } = {}) {
  if (!force) {
    const last = Number(getJsonSync(CHECK_KEY, 0)) || 0
    if (Date.now() - last < CHECK_INTERVAL) return []
  }
  setJsonSync(CHECK_KEY, Date.now())
  const seen = getJsonSync(SEEN_KEY, {}) || {}
  const today = todayStr()
  const out = []
  for (const item of (items || []).slice(0, MAX_SERIES)) {
    if (!item?.id) continue
    try {
      const info = await getSeriesUpcoming(item.id, signal)
      const ep = info?.lastEpisode
      if (!ep?.airDate || ep.airDate > today) continue
      // Ya reproducido: no avisar de lo que el usuario ya vio.
      if ((watchedEpisodes[`${item.id}:S${ep.season}:E${ep.episode}`]?.progress || 0) >= 0.97) continue
      const seenDate = seen[item.id]
      if (seenDate && ep.airDate <= seenDate) continue
      if (!seenDate) {
        const ageDays = (Date.parse(today) - Date.parse(ep.airDate)) / 86400000
        if (ageDays > FIRST_RUN_WINDOW_DAYS) continue
      }
      out.push({
        id: item.id,
        name: item.name,
        poster: item.poster || '',
        season: ep.season,
        episode: ep.episode,
        epName: ep.name || '',
        airDate: ep.airDate,
      })
    } catch { /* la siguiente serie */ }
  }
  return out
}

// Marca los avisos como vistos (descartar o abrir): guarda la fecha del
// último episodio conocido para que solo avise de episodios POSTERIORES.
export function markEpisodesSeen(items) {
  const seen = getJsonSync(SEEN_KEY, {}) || {}
  const today = todayStr()
  for (const it of items || []) {
    if (it?.id) seen[it.id] = it.airDate || today
  }
  const keys = Object.keys(seen)
  if (keys.length > 300) {
    for (const k of keys.slice(0, keys.length - 300)) delete seen[k]
  }
  setJsonSync(SEEN_KEY, seen)
}
