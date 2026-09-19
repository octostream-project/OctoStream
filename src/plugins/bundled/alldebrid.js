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

const API_BASE = 'https://api.alldebrid.com/v4'
const AGENT = 'octostream_stream'

// Solo host para logs: las URLs de unlock llevan token en el query.
const hostOf = (u) => { try { return new URL(u).host } catch { return 'unknown' } }

// Timeout por defecto: sin él un endpoint colgado bloquea la resolución
// (el withTimeout del manager abandona la espera pero el fetch sigue vivo).
const fetchT = (url, opts = {}) => fetch(url, {
  ...opts,
  signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
})

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

// --- PIN flow (device code authentication) ---
// 1. Get a PIN code from AllDebrid
// 2. User enters PIN at https://alldebrid.com/pin/?pin=XXXX
// 3. Poll /pin/check until activated=true
// 4. Save the returned apikey

// Get a PIN code. Returns { pin, check, expires_in, user_url } or null.
export async function getPin() {
  try {
    const url = `${API_BASE}/pin/get?agent=${AGENT}`
    const res = await fetchT(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
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
    const res = await fetchT(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
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
function apiUrl(endpoint, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`)
  url.searchParams.set('agent', AGENT)
  const key = getAlldebridApiKey()
  if (key) url.searchParams.set('apikey', key)
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  })
  return url.toString()
}

// Fetch JSON from AllDebrid API (with automatic re-authentication on bad API key)
async function apiFetch(endpoint, params = {}, retry = true) {
  const key = getAlldebridApiKey()
  if (!key) throw new Error('AllDebrid API key not configured')

  const url = apiUrl(endpoint, params)
  const res = await fetchT(url)
  if (!res.ok) throw new Error(`AllDebrid API error: ${res.status}`)

  const data = await res.json()
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

// Unlock a link (embed URL from streamwish, filemoon, etc.)
// Returns { link, filename, filesize, streamable, id, streams } or null on failure.
// streams is an array of { link, quality, ext } for quality-specific options.
export async function unlockLink(linkUrl) {
  try {
    const data = await apiFetch('/link/unlock', { link: linkUrl })
    if (!data || !data.link) return null
    // Extract quality-specific streams if available
    const streams = []
    if (data.streams && Array.isArray(data.streams)) {
      for (const s of data.streams) {
        if (s.link) {
          streams.push({
            link: s.link,
            quality: s.quality ? String(s.quality) + 'p' : '',
            ext: s.ext || '',
          })
        }
      }
    }
    return {
      link: data.link,
      filename: data.filename || '',
      filesize: data.filesize || 0,
      streamable: data.streamable !== false,
      id: data.linkid || data.id || null,
      streams,
    }
  } catch (e) {
    console.warn('[AllDebrid] unlockLink failed:', e?.message, hostOf(linkUrl))
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

// Check magnet status. Returns { status, links, filename } when ready.
// status: 'processing' | 'ready' | 'error'
export async function getMagnetStatus(magnetId) {
  try {
    const data = await apiFetch('/magnet/status', { id: magnetId })
    if (!data || !data.magnets || !data.magnets.length) return { status: 'error' }
    const mag = data.magnets[0]
    if (mag.status === 'Ready') {
      const links = (mag.links || []).map(l => l.link)
      return {
        status: 'ready',
        links,
        filename: mag.filename || '',
        size: mag.size || 0,
      }
    }
    return { status: 'processing', progress: mag.downloadPercent || 0 }
  } catch (e) {
    console.warn('[AllDebrid] getMagnetStatus failed:', e?.message)
    return { status: 'error' }
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

// Upload magnet and wait for it to be ready (polls every 3s, up to 60s)
// Returns array of direct streaming links or null.
export async function resolveMagnet(magnetUrl, timeoutMs = 60000) {
  const magnetId = await uploadMagnet(magnetUrl)
  if (!magnetId) return null

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await getMagnetStatus(magnetId)
    if (status.status === 'ready' && status.links?.length) {
      // Los links de /magnet/status son restringidos: hay que pasarlos por
      // /link/unlock para obtener la URL final reproducible.
      const direct = []
      for (const l of status.links) {
        const unlocked = await unlockLink(l)
        direct.push(unlocked?.link || l)
      }
      deleteMagnet(magnetId).catch(() => {})
      return direct.length ? direct : null
    }
    if (status.status === 'error') {
      deleteMagnet(magnetId).catch(() => {})
      return null
    }
    // Still processing, wait and retry
    await new Promise(r => setTimeout(r, 3000))
  }
  // Timeout: NO borrar el magnet — AllDebrid sigue bajándolo en su servidor y
  // queda cacheado para la próxima petición (igual que el fix de RealDebrid).
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
  'simfileshare.net', 'world-files.com',
  // Mixdrop (AllDebrid supports it)
  'mixdrop.co', 'mixdrop.to', 'mixdrop.sx',
  // Streamtape
  'streamtape.com', 'streamtape.to',
]

export function isAlldebridSupported(url) {
  if (!url) return false
  const lower = url.toLowerCase()
  return SUPPORTED_DOMAINS.some(d => lower.includes(d))
}
