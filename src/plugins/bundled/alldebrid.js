// AllDebrid integration - uses AllDebrid API v4 to unlock embed links and stream torrents.
// Requires an AllDebrid account and API key (configurable in Settings).
//
// API docs: https://docs.alldebrid.com/
// API base: https://api.alldebrid.com/v4/
//
// Flow:
//   1. User provides API key in Settings
//   2. When a streamwish/filemoon/vidhide/etc. embed fails to resolve,
//      we send the embed URL to AllDebrid's /link/unlock endpoint
//   3. AllDebrid returns a direct streaming URL from their servers
//   4. ExoPlayer/HLS.js plays the direct URL
//   5. For torrents/magnets, we upload the magnet and poll for status

import { getItemSync, removeItemSync } from '../../utils/storage.js'
import { pickTorrentEntries } from '../../utils/torrentPick.js'
import { httpGetJson, httpPostJson, waitForVpnTunnel } from '../../utils/httpClient.js'

const API_BASE = 'https://api.alldebrid.com/v4'
// /v4/magnet/status está discontinuado: el estado de magnets vive en v4.1.
const API_BASE_41 = 'https://api.alldebrid.com/v4.1'
const AGENT = 'octostream_stream'

// Solo host para logs: las URLs de unlock llevan token en el query.
const hostOf = (u) => { try { return new URL(u).host } catch { return 'unknown' } }

// Las llamadas a AllDebrid prefieren el túnel Riseup en Android: el provider
// registra la IP de salida y liga los links desbloqueados a ella. Soft-wait:
// si el túnel está caído la petición sale por WARP/física — la consistencia
// se mantiene porque unlock y playback salen por el mismo egress. El gate
// duro anterior impedía usar AllDebrid sin Riseup configurado.
async function apiGetJson(url) {
  try { await waitForVpnTunnel(20000) } catch {}
  return httpGetJson(url, {}, undefined, false, true)
}

// PIN flow: handshake de autenticación — a diferencia de /link/unlock no
// genera URLs ligadas a la IP de salida. Espera al túnel si el usuario lo
// tiene en autoconnect, pero NO bloquea el PIN cuando la VPN está caída:
// vincular la cuenta no puede exigir tener la VPN ya configurada.
async function apiGetJsonPin(url) {
  try { await waitForVpnTunnel(15000) } catch {}
  try {
    return await httpGetJson(url, {}, undefined, false, false)
  } catch (e) {
    if (e?.code !== 'VPN_NOT_CONNECTED' && e?.code !== 'WARP_NOT_CONNECTED') throw e
    // Túnel caído o mal configurado: el PIN sale por la física.
    return httpGetJson(url, {}, undefined, true, false)
  }
}

// RealDebrid fue eliminado del proyecto: limpia el token persistido de
// instalaciones viejas para que no quede credencial huérfana en el dispositivo.
try { removeItemSync('octostream_realdebrid_token') } catch {}

// Dedup inflight + caché corta de desbloqueos. Details y Plurtasko pueden
// resolver la misma URL a la vez (y el picker se reabre a menudo): compartir
// la promesa y cachear el resultado 2 min evita quemar llamadas a la API.
// Los links desbloqueados de AllDebrid son válidos durante horas.
const unlockInflight = new Map()
const unlockCache = new Map()
const UNLOCK_CACHE_TTL = 2 * 60 * 1000
const magnetInflight = new Map()
const magnetCache = new Map()

// Get API key from localStorage
export function getAlldebridApiKey() {
  try {
    return getItemSync('octostream_alldebrid_key') || ''
  } catch {
    return ''
  }
}

export function isAlldebridEnabled() {
  return !!getAlldebridApiKey()
}

// ¿Hay algún servicio debrid usable? La clave local de AllDebrid o una
// instancia AIOStreams configurada (su cuenta lleva el debrid dentro del
// manifest). Sin ninguna, toda la UI relacionada (entradas procesándose,
// popup de descarga, streams streamType 'debrid') se oculta.
export function hasAnyDebrid() {
  try {
    if (getItemSync('octostream_alldebrid_key')) return true
    if (getItemSync('octostream_aiostreams_manifest')) return true
    if (getItemSync('octostream_aiostreams_uuid')) return true
  } catch { /* storage inaccesible */ }
  return false
}

// --- PIN flow (device code authentication) ---
// 1. Get a PIN code from AllDebrid
// 2. User enters PIN at https://alldebrid.com/pin/?pin=XXXX
// 3. Poll /pin/check until activated=true
// 4. Save the returned apikey

// Get a PIN code. Returns { pin, check, expires_in, user_url } or null.
export async function getPin() {
  try {
    const url = `${API_BASE}/pin/get?agent=${AGENT}`
    const data = await apiGetJsonPin(url)
    if (data.status !== 'success') throw new Error(data.error?.message || 'Unknown error')
    return {
      pin: data.data.pin,
      check: data.data.check,
      expires_in: data.data.expires_in,
      user_url: data.data.user_url,
    }
  } catch (e) {
    console.warn('[AllDebrid] getPin failed:', e?.message)
    return null
  }
}

// Check PIN status. Returns { activated, apikey } or null.
export async function checkPin(pin, check) {
  try {
    const url = `${API_BASE}/pin/check?agent=${AGENT}&pin=${encodeURIComponent(pin)}&check=${encodeURIComponent(check)}`
    const data = await apiGetJsonPin(url)
    if (data.status !== 'success') throw new Error(data.error?.message || 'Unknown error')
    return {
      activated: data.data.activated === true,
      apikey: data.data.apikey || '',
    }
  } catch (e) {
    console.warn('[AllDebrid] checkPin failed:', e?.message)
    return null
  }
}

// Build API URL with agent and apikey
function apiUrl(endpoint, params = {}, base = API_BASE) {
  const url = new URL(`${base}${endpoint}`)
  url.searchParams.set('agent', AGENT)
  const key = getAlldebridApiKey()
  if (key) url.searchParams.set('apikey', key)
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  })
  return url.toString()
}

// Fetch JSON from AllDebrid API (with automatic re-authentication on bad API key)
// method 'POST' envía params como form-urlencoded en el body (algunos
// endpoints como /link/delayed solo aceptan POST).
async function apiFetch(endpoint, params = {}, retry = true, method = 'GET', base = API_BASE) {
  const key = getAlldebridApiKey()
  if (!key) throw new Error('AllDebrid API key not configured')

  // AllDebrid binds unlocked URLs to the request IP. Prefiere el túnel
  // cuando está arriba (soft-wait, igual que apiGetJson).
  const url = apiUrl(endpoint, method === 'GET' ? params : {}, base)
  let data
  if (method === 'POST') {
    try { await waitForVpnTunnel(20000) } catch {}
    data = await httpPostJson(
      url,
      new URLSearchParams(params).toString(),
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      true,
    )
  } else {
    data = await apiGetJson(url)
  }
  if (!data || typeof data !== 'object') throw new Error('AllDebrid API returned invalid JSON')
  if (data.status !== 'success') {
    const code = data.error?.code || ''
    // On bad API key, clear it and re-authenticate via PIN flow
    if (code === 'AUTH_BAD_APIKEY' && retry) {
      console.warn('[AllDebrid] API key invalid, clearing for re-authentication')
      try { removeItemSync('octostream_alldebrid_key') } catch {}
      throw new Error('AllDebrid: API key invalid, please re-authenticate')
    }
    const msg = data.error?.message || 'Unknown AllDebrid error'
    throw new Error(`AllDebrid: ${msg}`)
  }
  return data.data
}

// Poll /link/delayed until AllDebrid finishes generating the download link.
// Hosts like 1fichier return {delayed: id} from /link/unlock when the file
// isn't cached on their servers. status: 1=processing, 2=ready(+link), 3=error.
async function waitDelayed(delayedId, timeoutMs = 120000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const data = await apiFetch('/link/delayed', { id: delayedId }, true, 'POST')
    if (data?.status === 2 && data.link) return data.link
    if (data?.status === 3) return null
    // 1.5s: el endpoint es barato (POST liviano) y los delayed de 1fichier
    // suelen resolverse en segundos — con 5s se perdía medio paso de media.
    await new Promise(r => setTimeout(r, 1500))
  }
  return null
}

// Unlock a link (embed URL from streamwish, filemoon, etc.)
// Returns { link, filename, filesize, streamable, id } or null on failure.
// `link` is the direct, already-unlocked URL. data.streams entries are NOT
// returned: they are still-restricted variants that need /link/streaming.
export async function unlockLink(linkUrl) {
  const hit = unlockCache.get(linkUrl)
  if (hit && Date.now() - hit.t < UNLOCK_CACHE_TTL) return hit.res
  unlockCache.delete(linkUrl)
  let p = unlockInflight.get(linkUrl)
  if (!p) {
    p = unlockLinkRemote(linkUrl)
    unlockInflight.set(linkUrl, p)
    p.finally(() => { if (unlockInflight.get(linkUrl) === p) unlockInflight.delete(linkUrl) })
  }
  const res = await p
  if (res?.link) unlockCache.set(linkUrl, { t: Date.now(), res })
  return res
}

async function unlockLinkRemote(linkUrl) {
  try {
    const data = await apiFetch('/link/unlock', { link: linkUrl })
    if (!data) return { link: null, error: 'no_data' }
    let link = data.link
    if (!link && data.delayed) {
      link = await waitDelayed(data.delayed)
    }
    if (!link) return { link: null, error: 'not_ready' }
    return {
      link,
      filename: data.filename || '',
      filesize: data.filesize || 0,
      streamable: data.streamable !== false,
      id: data.linkid || data.id || null,
    }
  } catch (e) {
    console.warn('[AllDebrid] unlockLink failed:', e?.message, hostOf(linkUrl))
    return { link: null, error: e?.message || 'unknown' }
  }
}

// /magnet/instant: disponibilidad inmediata por infoHash/magnet, sin subir
// nada a la cuenta. Devuelve Map<infoHash, boolean> o null si la API falla —
// el caller decide entonces no marcar nada (mejor no ocultar fuentes buenas).
export async function instantAvailability(hashes) {
  const hs = [...new Set((hashes || []).map(h => String(h || '').toLowerCase()).filter(h => /^[0-9a-f]{32,40}$/.test(h)))]
  if (!hs.length || !isAlldebridEnabled()) return null
  try {
    // Sin waitForVpnTunnel: es una consulta de solo lectura (no genera URLs
    // ligadas a IP como /link/unlock) — esperar al túnel solo retrasaba
    // el marcado de "descargando" en la lista.
    const body = hs.map(h => `magnets[]=${encodeURIComponent(`magnet:?xt=urn:btih:${h}`)}`).join('&')
    // El endpoint existe en v4 y v4.1 — se prueban ambas por si la
    // instancia de la API cambia de versión.
    let data = null
    for (const base of [API_BASE_41, API_BASE]) {
      const url = apiUrl('/magnet/instant', {}, base)
      const res = await httpPostJson(url, body, { 'Content-Type': 'application/x-www-form-urlencoded' }, true)
      if (res?.status === 'success') { data = res; break }
    }
    if (!Array.isArray(data?.data?.magnets)) return null
    const out = new Map()
    for (const m of data.data.magnets) {
      const h = String(m?.hash || m?.magnet || '').toLowerCase()
      const match = h.match(/[0-9a-f]{32,40}/)
      if (match) out.set(match[0], m?.instant === true)
    }
    return out
  } catch (e) {
    console.warn('[AllDebrid] instant check failed:', e?.message)
    return null
  }
}

// Upload a magnet link and return the magnet ID
export async function uploadMagnet(magnetUrl) {
  try {
    const data = await apiFetch('/magnet/upload', { magnet: magnetUrl })
    if (!data || !data.magnets || !data.magnets.length) return null
    return data.magnets[0].id
  } catch (e) {
    console.warn('[AllDebrid] uploadMagnet failed:', e?.message)
    return null
  }
}

// Árbol `files` de v4.1 ({n,s,l} con subcarpetas {n,e:[…]}) → lista plana
// con la misma forma que devolvía el viejo /v4/magnet/status (link/name/size).
function flattenMagnetFiles(files, out = []) {
  for (const f of files || []) {
    if (f.l) out.push({ link: f.l, name: f.n || '', size: f.s || 0 })
    if (Array.isArray(f.e)) flattenMagnetFiles(f.e, out)
  }
  return out
}

// Check magnet status. Returns { status, links, filename } when ready.
// status: 'processing' | 'ready' | 'error'
// v4.1: statusCode 0-3 procesando, 4 listo, >=5 error. Los links restringidos
// vienen en el árbol `files` (o en /magnet/files si falta).
export async function getMagnetStatus(magnetId) {
  try {
    const data = await apiFetch('/magnet/status', { id: magnetId }, true, 'GET', API_BASE_41)
    const mags = data?.magnets
    // Con `id` concreto `magnets` es un objeto; sin filtro, un array.
    const mag = Array.isArray(mags) ? mags[0] : mags
    if (!mag || mag.error) return { status: 'error' }
    if (mag.statusCode === 4) {
      let links = flattenMagnetFiles(mag.files)
      if (!links.length) {
        const files = await apiFetch('/magnet/files', { 'id[]': magnetId }, true, 'GET', API_BASE_41)
        links = flattenMagnetFiles(files?.magnets?.[0]?.files)
      }
      return {
        status: 'ready',
        links,
        filename: mag.filename || '',
        size: mag.size || 0,
      }
    }
    if (mag.statusCode >= 5) return { status: 'error' }
    return {
      status: 'processing',
      progress: mag.processingPerc ??
        (mag.size ? Math.min(99, Math.round((mag.downloaded || 0) * 100 / mag.size)) : 0),
    }
  } catch (e) {
    console.warn('[AllDebrid] getMagnetStatus failed:', e?.message)
    // api_error = fallo de red/API (transitorio) — resolveMagnetRemote no
    // debe borrar el magnet ante esto; solo ante error REAL del magnet.
    return { status: 'api_error' }
  }
}

// Todos los magnets de la cuenta (cola + listos) — permite emparejar por
// infoHash los "descargando" que subió la instancia AIOStreams.
export async function listMagnets() {
  try {
    const data = await apiFetch('/magnet/status', {}, true, 'GET', API_BASE_41)
    return Array.isArray(data?.magnets) ? data.magnets : []
  } catch {
    return []
  }
}

// Delete a magnet from AllDebrid
export async function deleteMagnet(magnetId) {
  try {
    await apiFetch('/magnet/delete', { id: magnetId })
  } catch {
    // ignore
  }
}

// Upload magnet and wait for it to be ready (polls every 2s, up to 60s)
// Returns array of direct streaming links or null.
// opts.season/episode: en packs de temporada desbloquea solo el archivo del
// episodio pedido (fileIdx estilo Peerflix) en vez de todos los links.
export async function resolveMagnet(magnetUrl, timeoutMs = 60000, opts = {}) {
  // Dedup por magnet+episodio: dos resoluciones concurrentes del mismo torrent
  // comparten upload + polling en vez de subir el magnet dos veces. La caché
  // corta evita re-subirlo si el usuario reabre el mismo episodio.
  const key = `${magnetUrl}|${opts.season ?? ''}|${opts.episode ?? ''}`
  const hit = magnetCache.get(key)
  if (hit && Date.now() - hit.t < UNLOCK_CACHE_TTL) return hit.res
  magnetCache.delete(key)
  let p = magnetInflight.get(key)
  if (!p) {
    p = resolveMagnetRemote(magnetUrl, timeoutMs, opts)
    magnetInflight.set(key, p)
    p.finally(() => { if (magnetInflight.get(key) === p) magnetInflight.delete(key) })
  }
  const res = await p
  if (res?.length) magnetCache.set(key, { t: Date.now(), res })
  return res
}

async function resolveMagnetRemote(magnetUrl, timeoutMs, opts) {
  const magnetId = await uploadMagnet(magnetUrl)
  if (!magnetId) return null

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await getMagnetStatus(magnetId)
    if (status.status === 'ready' && status.links?.length) {
      // Los links de /magnet/status son restringidos: hay que pasarlos por
      // /link/unlock para obtener la URL final reproducible. En paralelo —
      // en serie cada unlock sumaba un round-trip extra por archivo.
      const picked = pickTorrentEntries(status.links, opts) || status.links
      // Sin fallback a picked[i].link: ese es el enlace RESTRINGIDO del host
      // (1fichier.com/?…), no es reproducible — devolverlo creaba streams que
      // "no cargan". Solo URLs ya desbloqueadas; si ninguna abre, null.
      const direct = (await Promise.all(picked.map(l => unlockLink(l.link))))
        .map(u => u?.link).filter(Boolean)
      deleteMagnet(magnetId).catch(() => {})
      return direct.length ? direct : null
    }
    if (status.status === 'error') {
      deleteMagnet(magnetId).catch(() => {})
      return null
    }
    // Still processing, wait and retry
    await new Promise(r => setTimeout(r, 2000))
  }
  // Timeout: NO borrar el magnet — AllDebrid sigue bajándolo en su servidor y
  // queda cacheado para la próxima petición.
  return null
}

// Check if AllDebrid supports a given server/URL
// Based on actual API /hosts endpoint response.
// AllDebrid does NOT support: nitroflare, uptobox, clicknupload, mexa.sh, streamwish, filemoon, vidhide, voe, fastream, doodstream, etc.
// AllDebrid DOES support: 1fichier, rapidgator, turbobit, mega, katfile, filefactory, and other file hosts.
const SUPPORTED_DOMAINS = [
  // 1fichier
  '1fichier.com', '1fichier', 'megadl.fr', 'alterupload.com',
  // Rapidgator
  'rapidgator.net', 'rg.to', 'rapidgator.asia',
  // Turbobit
  'turbobit.net', 'wayupload.com', 'turbobit.cloud',
  // Hitfile
  'hitfile.net', 'hitfile.com',
  // Mega
  'mega.nz', 'mega.co.nz',
  // File hosts
  'alfafile.net', 'file.al', 'file-upload.com', 'filedot.to', 'filedot.xyz',
  'filerio.in', 'filespace.com', 'filezip.cc', 'katfile.com', 'prefiles.com',
  'simfileshare.net', 'world-files.com', 'filefactory.com',
  // Mixdrop (AllDebrid supports it)
  'mixdrop.co', 'mixdrop.to', 'mixdrop.sx',
  // Streamtape
  'streamtape.com', 'streamtape.to',
]

export function isAlldebridSupported(url) {
  if (!url) return false
  // Match por hostname real: el substring anterior casaba dominios lookalike
  // (p.ej. 1fichier.evil.com o notstreamtape.com). Dominios con punto →
  // coincidencia exacta o subdominio; '1fichier' suelto cubre mirrors
  // 1fichier.xyz/etc. como etiqueta completa del host.
  let hostname = ''
  try { hostname = new URL(url).hostname.toLowerCase() } catch { return false }
  const parts = hostname.split('.')
  return SUPPORTED_DOMAINS.some(d =>
    d.includes('.')
      ? hostname === d || hostname.endsWith('.' + d)
      // Etiqueta suelta: solo como dominio registrable (1fichier.<tld>) o
      // subdominio directo de él — 1fichier.evil.com ya NO casa.
      : parts[parts.length - 2] === d)
}
