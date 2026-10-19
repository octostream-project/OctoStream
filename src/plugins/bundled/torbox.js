// TorBox (torbox.app) — integración debrid.
// API v1: https://api.torbox.app/v1/api — auth `Authorization: Bearer <key>`.
// Enlaces de hoster (1fichier, etc.): webdl createtorrent → poll mylist →
// requestdl. Magnets: torrents createtorrent → mylist → requestdl (file_id).
// All API traffic follows the app's Aether/WARP proxy configuration.

import { httpGetJson, httpPostJson, httpHead } from '../../utils/httpClient.js'
import { getItemSync } from '../../utils/storage.js'

const API = 'https://api.torbox.app/v1/api'

const hostOf = (u) => { try { return new URL(u).host } catch { return 'unknown' } }

export function getTorboxApiKey() {
  try { return getItemSync('octostream_torbox_key') || '' } catch { return '' }
}

export function isTorboxEnabled() {
  return !!getTorboxApiKey()
}

const TORBOX_HOSTERS = new Set([
  '1fichier.com', 'rapidgator.net', 'turbobit.net', 'mega.nz', 'katfile.com',
  'filefactory.com', 'hitfile.net', 'nitroflare.com', 'uploaded.net',
])

export function isTorboxSupported(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return [...TORBOX_HOSTERS].some(domain => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return false
  }
}


/**
 * Pide el link de descarga y lo valida con HEAD antes de entregarlo.
 * TorBox sirve el archivo progresivamente en algunos casos — si responde,
 * el player puede empezar aunque el job siga "downloading".
 */
async function validatedLink(path, params) {
  try {
    const r = await apiFetch(path, { params: { token: getTorboxApiKey(), redirect: 'false', ...params } })
    const link = typeof r === 'string' ? r : (r?.download_link || r?.link || r?.url || null)
    if (!link || !/^https?:/i.test(link)) return null
    const probe = await httpHead(link, {}, undefined, true).catch(() => null)
    if (probe && probe.status < 400) return link
    return null
  } catch { return null }
}

export async function getTorboxDownloads() {
  const [webDownloads, torrents] = await Promise.all([
    apiFetch('/webdl/mylist', { params: { bypass_cache: 'true', limit: '100' } }),
    apiFetch('/torrents/mylist', { params: { bypass_cache: 'true', limit: '100' } }),
  ])
  const listOf = (value, ...keys) => {
    if (Array.isArray(value)) return value
    for (const key of keys) if (Array.isArray(value?.[key])) return value[key]
    return []
  }
  const normalize = (items, kind) => (Array.isArray(items) ? items : []).map(item => {
    const state = String(item?.download_state || item?.status || item?.state || '')
    const finished = item?.download_ready === true
      || /cached|completed|finished|success|ready|processed|seeding/i.test(state)
    return {
      id: String(item?.id ?? item?.webdownload_id ?? item?.torrent_id ?? `${kind}-${Math.random()}`),
      name: item?.name || item?.filename || item?.link || `${kind === 'webdl' ? 'Enlace' : 'Torrent'} ${item?.id ?? ''}`,
      kind,
      state: state || (finished ? 'completed' : 'pending'),
      progress: Number(item?.progress ?? item?.progress_percentage ?? 0),
      finished,
      size: Number(item?.size || item?.downloaded || 0),
    }
  })
  const all = [
    ...normalize(listOf(webDownloads, 'webdownloads', 'downloads', 'items'), 'webdl'),
    ...normalize(listOf(torrents, 'torrents', 'items'), 'torrent'),
  ]
  return {
    pending: all.filter(item => !item.finished),
    completed: all.filter(item => item.finished),
  }
}

export function clearTorboxToken() {
  try { localStorage.removeItem('octostream_torbox_key') } catch {}
}

async function apiFetch(path, { method = 'GET', params = {}, body, timeoutMs = 20000 } = {}) {
  const key = getTorboxApiKey()
  if (!key) throw new Error('No hay API key de TorBox')
  const url = `${API}${path}?${new URLSearchParams(params).toString()}`
  const headers = { Authorization: `Bearer ${key}` }
  let data
  try {
    data = method === 'POST'
      // TorBox espera application/x-www-form-urlencoded, no JSON (422).
      ? await httpPostJson(url, new URLSearchParams(body || {}).toString(),
          { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
          true, undefined, false, true)
      : await httpGetJson(url, headers, undefined, false, true)
  } catch (e) {
    const raw = e?.message || 'error HTTP'
    // Fallos de socket (WARP/túnel caído a mitad de request) son transitorios.
    if (/econn|ehost|enet|etimedout|socket|connection abort|network error|failed to fetch|timeout/i.test(raw)) {
      const wrapped = new Error(`TorBox ${method} ${path}: TorBox no responde temporalmente; espera unos segundos y reintenta`)
      wrapped.transient = true
      wrapped.httpStatus = e?.httpStatus
      throw wrapped
    }
    // El path ayuda a identificar un 500 del proveedor sin exponer key ni URL.
    const wrapped = new Error(`TorBox ${method} ${path}: ${raw}`)
    wrapped.httpStatus = e?.httpStatus
    throw wrapped
  }
  if (!data || typeof data !== 'object') throw new Error('Respuesta no es JSON válido')
  if (data.success === false || data.error) {
    const msg = typeof data.error === 'string' ? data.error : (data.error?.code || data.detail || 'error')
    throw new Error(`TorBox: ${msg}`)
  }
  return data.data
}

/**
 * Desbloquea un enlace de hoster (1fichier, rapidgator…).
 * Devuelve {link, filename} o {link:null, error}.
 */
export async function unlockLink(url, { onProgress } = {}) {
  try {
    let created = null
    // "error scanning this link" puede ser transitorio (el hoster responde
    // tarde al escaneo de TorBox). createwebdownload deduplica por link en
    // el servidor — un solo reintento no crea trabajos dobles.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        created = await apiFetch('/webdl/createwebdownload', { method: 'POST', body: { link: url } })
        break
      } catch (e) {
        if (attempt === 0 && /error scanning|offline or inaccessible/i.test(e?.message || '')) {
          await new Promise(r => setTimeout(r, 4000))
          continue
        }
        throw e
      }
    }
    const id = created?.webdownload_id ?? created?.id
    if (id == null) return { link: null, error: 'sin id de job' }
    // Poll mylist hasta que esté cached/ready (cache hits son instantáneos).
    // Los ficheros grandes tardan minutos en bajar a la CDN de TorBox —
    // 90 iteraciones × 2s ≈ 3 min. Los enlaces "ready" antes de tiempo
    // producían un 404 al reproducir: solo se acepta download_ready:true o
    // un estado terminal explícito.
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const list = await apiFetch('/webdl/mylist', { params: { bypass_cache: 'true' } })
      const item = (Array.isArray(list) ? list : []).find(w => w?.id === id || w?.webdownload_id === id)
      const st = item?.download_state || item?.status || ''
      if (item?.download_ready === true || /completed|cached|finished|success|seeding/i.test(st)) {
        const r = await apiFetch('/webdl/requestdl', { params: { token: getTorboxApiKey(), web_id: String(id), zip_link: 'false', redirect: 'false' } })
        const link = typeof r === 'string' ? r : (r?.download_link || r?.link || r?.url || null)
        if (link) return { link, filename: item?.name || '' }
        return { link: null, error: 'requestdl sin URL' }
      }
      if (/failed|error|dead|invalid/i.test(st)) return { link: null, error: `job ${st}` }
      if (item && onProgress) {
        try { onProgress({ progress: Number(item.progress ?? 0), state: st || 'downloading' }) } catch {}
      }
      // Reproducción progresiva: con >=15% descargado se intenta el link
      // cada ~16s — si TorBox lo sirve ya, se reproduce sin esperar al 100%.
      const prog = Number(item?.progress ?? 0)
      if (item && prog >= 0.15 && prog < 1 && i % 8 === 4) {
        const early = await validatedLink('/webdl/requestdl', { web_id: String(id), zip_link: 'false' })
        if (early) return { link: early, filename: item?.name || '', early: true }
      }
      if (item?.progress != null && i % 5 === 0) console.log('[TorBox] webdl', Math.round(item.progress * 100) + '%')
    }
    // El trabajo sigue vivo en la cuenta — reintentar re-adjuntará al mismo job.
    return { link: null, error: 'La descarga sigue en curso en TorBox; reintenta en unos segundos.' }
  } catch (e) {
    console.warn('[TorBox] unlockLink fail', hostOf(url), e?.message)
    return { link: null, error: e?.message || 'unlock failed' }
  }
}

/**
 * Sube un magnet y espera al fichero listo.
 * Devuelve {link, filename} o {link:null, error}.
 */
export async function resolveMagnet(magnet, { fileFilter } = {}) {
  try {
    const created = await apiFetch('/torrents/createtorrent', { method: 'POST', body: { magnet, seed: 1 } })
    const tid = created?.torrent_id ?? created?.id
    if (tid == null) return { link: null, error: 'sin torrent_id' }
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const list = await apiFetch('/torrents/mylist', { params: { bypass_cache: 'true' } })
      const t = (Array.isArray(list) ? list : []).find(w => w?.id === tid || w?.torrent_id === tid)
      const st = t?.download_state || t?.status || ''
      if (t?.download_ready === true || /completed|cached|finished|success|seeding/i.test(st)) {
        const files = Array.isArray(t?.files) ? t.files : []
        const pick = fileFilter ? files.find(fileFilter) : null
        const file = pick || files.filter(f => /\.(mp4|mkv|avi|mov|m4v)$/i.test(f?.name || '')).sort((a, b) => (b?.size || 0) - (a?.size || 0))[0] || files.sort((a, b) => (b?.size || 0) - (a?.size || 0))[0]
        if (!file) return { link: null, error: 'sin fichero' }
        const r = await apiFetch('/torrents/requestdl', { params: { token: getTorboxApiKey(), torrent_id: String(tid), file_id: String(file.id ?? file.file_id ?? 0), zip_link: 'false', redirect: 'false' } })
        const link = typeof r === 'string' ? r : (r?.download_link || r?.link || r?.url || null)
        if (link) return { link, filename: file.name || t?.name || '' }
        return { link: null, error: 'requestdl sin URL' }
      }
      if (/failed|error|dead|invalid/i.test(st)) return { link: null, error: `torrent ${st}` }
      const prog = Number(t?.progress ?? 0)
      if (t && prog >= 0.15 && prog < 1 && i % 8 === 4) {
        const files = Array.isArray(t?.files) ? t.files : []
        const f = files.filter(x => /\.(mp4|mkv|avi|mov|m4v)$/i.test(x?.name || '')).sort((a, b) => (b?.size || 0) - (a?.size || 0))[0] || files[0]
        if (f) {
          const early = await validatedLink('/torrents/requestdl', { torrent_id: String(tid), file_id: String(f.id ?? f.file_id ?? 0), zip_link: 'false' })
          if (early) return { link: early, filename: f.name || t?.name || '', early: true }
        }
      }
    }
    return { link: null, error: 'El torrent sigue descargándose en TorBox; reintenta en unos segundos.' }
  } catch (e) {
    console.warn('[TorBox] resolveMagnet fail', e?.message)
    return { link: null, error: e?.message || 'magnet failed' }
  }
}

/**
 * Sube un NZB de usenet y espera al fichero listo.
 * Misma mecánica que resolveMagnet pero sobre los endpoints /usenet/*.
 * Devuelve {link, filename} o {link:null, error}.
 */
export async function resolveUsenet(link, { fileFilter } = {}) {
  try {
    const created = await apiFetch('/usenet/createusenetdownload', { method: 'POST', body: { link } })
    const uid = created?.usenetdownload_id ?? created?.id
    if (uid == null) return { link: null, error: 'sin usenet_id' }
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const list = await apiFetch('/usenet/mylist', { params: { bypass_cache: 'true' } })
      const t = (Array.isArray(list) ? list : []).find(w => w?.id === uid || w?.usenetdownload_id === uid)
      const st = t?.download_state || t?.status || ''
      if (t?.download_ready === true || /completed|cached|finished|success|seeding/i.test(st)) {
        const files = Array.isArray(t?.files) ? t.files : []
        const pick = fileFilter ? files.find(fileFilter) : null
        const file = pick || files.filter(f => /\.(mp4|mkv|avi|mov|m4v)$/i.test(f?.name || '')).sort((a, b) => (b?.size || 0) - (a?.size || 0))[0] || files.sort((a, b) => (b?.size || 0) - (a?.size || 0))[0]
        if (!file) return { link: null, error: 'sin fichero' }
        const r = await apiFetch('/usenet/requestdl', { params: { token: getTorboxApiKey(), usenet_id: String(uid), file_id: String(file.id ?? file.file_id ?? 0), zip_link: 'false', redirect: 'false' } })
        const dl = typeof r === 'string' ? r : (r?.download_link || r?.link || r?.url || null)
        if (dl) return { link: dl, filename: file.name || t?.name || '' }
        return { link: null, error: 'requestdl sin URL' }
      }
      if (/failed|error|dead|invalid/i.test(st)) return { link: null, error: `usenet ${st}` }
      const prog = Number(t?.progress ?? 0)
      if (t && prog >= 0.15 && prog < 1 && i % 8 === 4) {
        const files = Array.isArray(t?.files) ? t.files : []
        const f = files.filter(x => /\.(mp4|mkv|avi|mov|m4v)$/i.test(x?.name || '')).sort((a, b) => (b?.size || 0) - (a?.size || 0))[0] || files[0]
        if (f) {
          const early = await validatedLink('/usenet/requestdl', { usenet_id: String(uid), file_id: String(f.id ?? f.file_id ?? 0), zip_link: 'false' })
          if (early) return { link: early, filename: f.name || t?.name || '', early: true }
        }
      }
    }
    return { link: null, error: 'La descarga usenet sigue en curso en TorBox; reintenta en unos segundos.' }
  } catch (e) {
    console.warn('[TorBox] resolveUsenet fail', e?.message)
    return { link: null, error: e?.message || 'usenet failed' }
  }
}

// --- Search API (Orion en TorBox) ---
// Host separado con la misma Bearer key: /torrents|/usenet/<id_type>:<id>
// y /torrents/search|/usenet/search?query=. Devuelve torrents[]/nzbs[] con
// magnet|nzb, hash, cached, last_known_seeders, size, title_parsed_data.
const SEARCH_API = 'https://search-api.torbox.app'

export function isTorboxSearchEnabled() {
  try { return isTorboxEnabled() && getItemSync('octostream_torbox_search') !== 'false' } catch { return false }
}

async function searchFetch(path, params = {}) {
  const key = getTorboxApiKey()
  if (!key) return null
  const url = `${SEARCH_API}${path}?${new URLSearchParams(params).toString()}`
  try {
    const data = await httpGetJson(url, { Authorization: `Bearer ${key}` }, undefined, false, true)
    if (!data || data.success === false) return null
    return data.data
  } catch (e) {
    console.warn('[TorBox] search fail', path, e?.message)
    return null
  }
}

/**
 * Busca torrents y usenet en el índice Orion de TorBox.
 * id: IMDb 'tt123' o TMDB numérico (themoviedb_id).
 * Devuelve { torrents: [], nzbs: [], metadata } o null.
 */
export async function torboxSearch({ imdbId, tmdbId, season, episode }) {
  const idKey = imdbId ? `imdb:${imdbId}` : (tmdbId ? `themoviedb_id:${tmdbId}` : null)
  if (!idKey) return null
  const params = { check_cache: 'true', metadata: 'true' }
  if (season != null) params.season = String(season)
  if (episode != null) params.episode = String(episode)
  const [tor, usenet] = await Promise.all([
    searchFetch(`/torrents/${idKey}`, params),
    searchFetch(`/usenet/${idKey}`, params),
  ])
  const torrents = [
    ...(Array.isArray(tor?.torrents) ? tor.torrents : []),
    ...(Array.isArray(tor?.nzbs) ? tor.nzbs : []),
  ].filter(t => t?.type !== 'usenet')
  const nzbs = [
    ...(Array.isArray(usenet?.nzbs) ? usenet.nzbs : []),
    ...(Array.isArray(usenet?.torrents) ? usenet.torrents : []),
  ].filter(t => t?.type === 'usenet' || t?.nzb)
  return {
    metadata: tor?.metadata || usenet?.metadata || null,
    torrents,
    nzbs,
  }
}
