// RealDebrid integration - uses RealDebrid API to unlock links and stream torrents.
// Requires a RealDebrid account and API token (configurable in Settings).
//
// API docs: https://api.real-debrid.com/
// API base: https://api.real-debrid.com/rest/1.0/
//
// RealDebrid supports: voe.sx, mixdrop, streamtape, upstream, and many file hosts.
// It does NOT support: streamwish, filemoon, vidhide, fastream, hanerix.

import { getItemSync, setItemSync } from '../../utils/storage.js'
import { pickTorrentEntries } from '../../utils/torrentPick.js'

const API_BASE = 'https://api.real-debrid.com/rest/1.0'

// Solo host para logs: las URLs de unlock llevan token en el query.
const hostOf = (u) => { try { return new URL(u).host } catch { return 'unknown' } }

// Timeout por defecto: sin él un endpoint colgado bloquea la resolución
// (el withTimeout del manager abandona la espera pero el fetch sigue vivo).
const fetchT = (url, opts = {}) => fetch(url, {
  ...opts,
  signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
})

// Get API token from localStorage
export function getRealdebridToken() {
  try {
    return getItemSync('octostream_realdebrid_token') || ''
  } catch {
    return ''
  }
}

export function isRealdebridEnabled() {
  return !!getRealdebridToken()
}

// --- Device code flow (OAuth2 for mobile devices) ---
// Uses the opensource client_id X245A4XAIBGVM
// 1. Get a device code from RealDebrid
// 2. User enters code at https://real-debrid.com/device
// 3. Poll /token until access_token is returned
// 4. Save the access token

const RD_OAUTH_BASE = 'https://api.real-debrid.com/oauth/v2'
const RD_CLIENT_ID = 'X245A4XAIBGVM' // Public opensource client_id

// Get device code. Returns { device_code, user_code, interval, expires_in, verification_url } or null.
export async function getDeviceCode() {
  try {
    const url = `${RD_OAUTH_BASE}/device/code?client_id=${RD_CLIENT_ID}&new_credentials=yes`
    const res = await fetchT(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return {
      device_code: data.device_code,
      user_code: data.user_code,
      interval: data.interval || 5,
      expires_in: data.expires_in || 1800,
      verification_url: data.verification_url || 'https://real-debrid.com/device',
    }
  } catch (e) {
    console.warn('[RealDebrid] getDeviceCode failed:', e?.message)
    return null
  }
}

// Poll for credentials. Returns { client_id, client_secret } or { pending: true } if not yet authorized.
export async function getDeviceCredentials(deviceCode) {
  try {
    const url = `${RD_OAUTH_BASE}/device/credentials?client_id=${RD_CLIENT_ID}&code=${encodeURIComponent(deviceCode)}`
    const res = await fetchT(url)
    if (!res.ok) {
      // 403 = authorization pending, keep polling
      if (res.status === 403) return { pending: true }
      throw new Error(`HTTP ${res.status}`)
    }
    const data = await res.json()
    if (data.client_id && data.client_secret) {
      return {
        client_id: data.client_id,
        client_secret: data.client_secret,
      }
    }
    return { pending: true }
  } catch (e) {
    console.warn('[RealDebrid] getDeviceCredentials failed:', e?.message)
    return null
  }
}

// Exchange device code + credentials for an access token.
// Returns { access_token, refresh_token } or null.
// Also saves client_id/client_secret and refresh_token for automatic refresh.
export async function getDeviceToken(clientId, clientSecret, deviceCode) {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: deviceCode,
      grant_type: 'http://oauth.net/grant_type/device/1.0',
    })
    const res = await fetchT(`${RD_OAUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (data.access_token) {
      // Save credentials for automatic token refresh
      try {
        setItemSync('octostream_realdebrid_client_id', clientId)
        setItemSync('octostream_realdebrid_client_secret', clientSecret)
        setItemSync('octostream_realdebrid_token', data.access_token)
        if (data.refresh_token) setItemSync('octostream_realdebrid_refresh', data.refresh_token)
      } catch {}
      return { access_token: data.access_token, refresh_token: data.refresh_token || '' }
    }
    return null
  } catch (e) {
    console.warn('[RealDebrid] getDeviceToken failed:', e?.message)
    return null
  }
}

// Get refresh token from localStorage
export function getRealdebridRefreshToken() {
  try {
    return getItemSync('octostream_realdebrid_refresh') || ''
  } catch {
    return ''
  }
}

// Get client_id/secret from localStorage (saved during device flow)
export function getRealdebridClientId() {
  try {
    return getItemSync('octostream_realdebrid_client_id') || ''
  } catch {
    return ''
  }
}

export function getRealdebridClientSecret() {
  try {
    return getItemSync('octostream_realdebrid_client_secret') || ''
  } catch {
    return ''
  }
}

// Refresh the access token using the stored refresh token.
// Returns new { access_token, refresh_token } or null.
export async function refreshToken() {
  const refreshTokenVal = getRealdebridRefreshToken()
  const clientId = getRealdebridClientId() || RD_CLIENT_ID
  const clientSecret = getRealdebridClientSecret()
  if (!refreshTokenVal || !clientSecret) return null
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: refreshTokenVal,
      grant_type: 'http://oauth.net/grant_type/device/1.0',
    })
    const res = await fetchT(`${RD_OAUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (data.access_token) {
      try {
        setItemSync('octostream_realdebrid_token', data.access_token)
        if (data.refresh_token) setItemSync('octostream_realdebrid_refresh', data.refresh_token)
      } catch {}
      return { access_token: data.access_token, refresh_token: data.refresh_token || refreshTokenVal }
    }
    return null
  } catch (e) {
    console.warn('[RealDebrid] refreshToken failed:', e?.message)
    return null
  }
}

// Fetch JSON from RealDebrid API (with automatic token refresh on bad_token)
async function apiFetch(endpoint, options = {}, retry = true) {
  let token = getRealdebridToken()
  if (!token) throw new Error('RealDebrid token not configured')

  const url = `${API_BASE}${endpoint}`
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  const res = await fetchT(url, { ...options, headers })
  if (!res.ok) {
    if (res.status === 401 && retry) {
      // Try refreshing the token
      const refreshed = await refreshToken()
      if (refreshed) {
        // Retry with new token
        return apiFetch(endpoint, options, false)
      }
      throw new Error('RealDebrid: Invalid token (refresh failed)')
    }
    // El body suele traer el código real (infringing_file, unavailable_file...)
    let code = `HTTP ${res.status}`
    try {
      const j = JSON.parse(await res.text())
      if (j?.error) code = j.error
    } catch {}
    throw new Error(`RealDebrid: ${code}`)
  }

  const text = await res.text()
  if (!text) return null
  const data = JSON.parse(text)
  // Check for bad_token error in response body
  if (data.error === 'bad_token' && retry) {
    const refreshed = await refreshToken()
    if (refreshed) {
      return apiFetch(endpoint, options, false)
    }
    throw new Error('RealDebrid: bad_token (refresh failed)')
  }
  return data
}

// Unlock a link. Returns { link, filename, filesize, streamable, id, alternatives } or null.
// alternatives is an array of { link, quality } for multiple quality options.
export async function unlockLink(linkUrl) {
  try {
    const body = `link=${encodeURIComponent(linkUrl)}`
    const data = await apiFetch('/unrestrict/link', {
      method: 'POST',
      body,
    })
    if (!data || !data.download) return { link: null, error: data?.error || 'no_download' }
    // Extract alternative quality links if available
    const alternatives = []
    if (data.alternative && Array.isArray(data.alternative)) {
      for (const alt of data.alternative) {
        if (alt.download) {
          alternatives.push({
            link: alt.download,
            quality: alt.quality || '',
          })
        }
      }
    }
    return {
      link: data.download,
      filename: data.filename || '',
      filesize: data.filesize || 0,
      streamable: data.streamable === 1,
      id: data.id || null,
      alternatives,
    }
  } catch (e) {
    console.warn('[RealDebrid] unlockLink failed:', e?.message, hostOf(linkUrl))
    return { link: null, error: e?.message || 'unknown' }
  }
}

// Add a magnet and return the torrent ID
export async function addMagnet(magnetUrl) {
  try {
    const body = `magnet=${encodeURIComponent(magnetUrl)}`
    const data = await apiFetch('/torrents/addMagnet', {
      method: 'POST',
      body,
    })
    if (!data || !data.id) return null
    return data.id
  } catch (e) {
    console.warn('[RealDebrid] addMagnet failed:', e?.message)
    return null
  }
}

// Get torrent info. Returns { status, files, links } when ready.
export async function getTorrentInfo(torrentId) {
  try {
    const data = await apiFetch(`/torrents/info/${torrentId}`)
    if (!data) return { status: 'error' }
    const files = (data.files || []).map(f => ({
      id: f.id,
      name: f.path || '',
      size: f.bytes || 0,
      selected: f.selected === 1,
    }))
    if (data.status === 'downloaded') {
      return {
        status: 'ready',
        links: data.links || [],
        files,
        filename: data.filename || '',
        progress: data.progress || 0,
        rawStatus: data.status,
      }
    }
    return {
      status: 'processing',
      progress: data.progress || 0,
      files,
      rawStatus: data.status,
    }
  } catch (e) {
    console.warn('[RealDebrid] getTorrentInfo failed:', e?.message)
    return { status: 'error' }
  }
}

// Select files and get download links
export async function selectFiles(torrentId, fileId = 'all') {
  try {
    const body = `files=${fileId}`
    await apiFetch(`/torrents/selectFiles/${torrentId}`, {
      method: 'POST',
      body,
    })
  } catch (e) {
    console.warn('[RealDebrid] selectFiles failed:', e?.message)
  }
}

// Delete a torrent
export async function deleteTorrent(torrentId) {
  try {
    await apiFetch(`/torrents/delete/${torrentId}`, { method: 'DELETE' })
  } catch {
    // ignore
  }
}

// Resolve magnet to direct streaming links (polls every 3s, up to 60s).
// opts.season/episode: en packs de temporada se selecciona solo el archivo del
// episodio pedido (fileIdx estilo Peerflix) en vez de bajar el torrent entero.
export async function resolveMagnet(magnetUrl, timeoutMs = 60000, opts = {}) {
  const torrentId = await addMagnet(magnetUrl)
  if (!torrentId) return null

  let selectRetries = 0
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const info = await getTorrentInfo(torrentId)
    if (info.status === 'ready' && info.links?.length) {
      // links[] se corresponde con los files marcados selected, en orden.
      const selected = (info.files || []).filter(f => f.selected)
      const picked = pickTorrentEntries(selected, opts) || []
      const wantedIdx = new Set(picked.map(f => selected.indexOf(f)))
      const links = info.links.filter((_, i) => !wantedIdx.size || wantedIdx.has(i))
      const directLinks = []
      for (const link of links) {
        const unrestricted = await unlockLink(link)
        if (unrestricted?.link) directLinks.push(unrestricted.link)
      }
      deleteTorrent(torrentId).catch(() => {})
      return directLinks.length ? directLinks : null
    }
    if (info.status === 'error') {
      deleteTorrent(torrentId).catch(() => {})
      return null
    }
    if (info.rawStatus === 'waiting_files_selection' && selectRetries < 6) {
      selectRetries++
      const picked = pickTorrentEntries(info.files || [], opts)
      const ids = picked?.length ? picked.map(f => f.id).join(',') : 'all'
      await selectFiles(torrentId, ids)
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  // Timeout: NO borrar el torrent — RD sigue descargándolo en su servidor y
  // queda cacheado para la próxima petición. Borrarlo aquí hacía que un
  // torrent no cacheado nunca llegara a estarlo → siempre caía a P2P.
  return null
}

// RealDebrid supported domains (official list)
// Source: https://real-debrid.com/streaming
// RealDebrid does NOT support: doodstream, supervideo, dropstream, streamwish, filemoon, vidhide, fastream
const SUPPORTED_DOMAINS = [
  // 1Fichier
  '1fichier.com', '1fichier', 'megadl.fr', 'alterupload.com', 'cjoint.net',
  'desfichiers.com', 'dfichiers.com', 'mesfichiers.org', 'piecejointe.net',
  'pjointe.com', 'tenvoi.com', 'dl4free.com',
  // 4Shared
  '4shared.com', '4s.io',
  // BRupload
  'brupload.net',
  // ClicknUpload
  'clicknupload.com', 'clicknupload.me', 'clicknupload.org', 'clicknupload.click',
  // Dailymotion
  'dailymotion.com', 'dai.ly',
  // DailyUploads
  'dailyuploads.net',
  // DDownload / DDL.to
  'ddownload.com', 'ddl.to',
  // Dropbox
  'dropbox.com',
  // file.al
  'file.al',
  // Filefactory
  'filefactory.com',
  // Filespace
  'filespace.com',
  // Filestore
  'filestore.to',
  // Filextras
  'filextras.com',
  // Gigapeta
  'gigapeta.com',
  // Google Drive
  'drive.google.com', 'docs.google.com',
  // HexUpload / HexLoad
  'hexupload.net', 'hexload.com',
  // Hitfile
  'hitfile.net', 'hitfile.com', 'hitf.to',
  // iCloud Drive
  'icloud.com',
  // Isra.cloud
  'isra.cloud',
  // KatFile
  'katfile.com', 'katfile.cloud', 'katfile.online',
  // Mediafire
  'mediafire.com',
  // Mega
  'mega.nz', 'mega.co.nz',
  // Nitroflare
  'nitroflare.com',
  // Prefiles
  'prefiles.com',
  // RapidGator
  'rapidgator.net', 'rg.to', 'rapidgator.asia',
  // Terabytez
  'terabytez.org',
  // Turbobit
  'turbobit.net', 'wayupload.com', 'turbobit.cloud',
  // Uploady
  'uploady.io',
  // Vimeo
  'vimeo.com', 'player.vimeo.com',
  // Voe
  'voe.sx', 'voe-unblock.com', 'voeunblock.com', 'voe-unblock.net',
  'un-block-voe.net', 'voe-un-block.com',
  // Wipfiles
  'wipfiles.net',
  // Mixdrop (also supported)
  'mixdrop.co', 'mixdrop.to', 'mixdrop.sx', 'mixdrop.ag',
  // Streamtape (also supported)
  'streamtape.com', 'streamtape.to',
  // Upstream (also supported)
  'upstream.to',
]

export function isRealdebridSupported(url) {
  if (!url) return false
  const lower = url.toLowerCase()
  return SUPPORTED_DOMAINS.some(d => lower.includes(d))
}
