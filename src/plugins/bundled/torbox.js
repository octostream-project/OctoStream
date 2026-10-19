// TorBox (torbox.app) — integración debrid paralela a AllDebrid.
// API v1: https://api.torbox.app/v1/api — auth `Authorization: Bearer <key>`.
// Enlaces de hoster (1fichier, etc.): webdl createtorrent → poll mylist →
// requestdl. Magnets: torrents createtorrent → mylist → requestdl (file_id).
// TorBox no bloquea IPs de VPN, pero se mantiene el gate required para que
// unlock y stream salgan por la misma IP (el propio túnel de Riseup).

import { httpGetJson, httpPostJson, waitForVpnTunnel } from '../../utils/httpClient.js'
import { getItemSync } from '../../utils/storage.js'

const API = 'https://api.torbox.app/v1/api'

const hostOf = (u) => { try { return new URL(u).host } catch { return 'unknown' } }

export function getTorboxApiKey() {
  try { return getItemSync('octostream_torbox_key') || '' } catch { return '' }
}

export function isTorboxEnabled() {
  return !!getTorboxApiKey()
}

export function clearTorboxToken() {
  try { localStorage.removeItem('octostream_torbox_key') } catch {}
}

async function apiFetch(path, { method = 'GET', params = {}, body, timeoutMs = 20000 } = {}) {
  const key = getTorboxApiKey()
  if (!key) throw new Error('No hay API key de TorBox')
  await waitForVpnTunnel(30000, { required: true })
  const url = `${API}${path}?${new URLSearchParams(params).toString()}`
  const headers = { Authorization: `Bearer ${key}` }
  const data = method === 'POST'
    ? await httpPostJson(url, body || {}, headers, false, undefined, false, true)
    : await httpGetJson(url, headers, undefined, false, true)
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
export async function unlockLink(url) {
  try {
    const created = await apiFetch('/webdl/createwebdownload', { method: 'POST', body: { link: url } })
    const id = created?.webdownload_id ?? created?.id
    if (id == null) return { link: null, error: 'sin id de job' }
    // Poll mylist hasta que esté cached/ready (cache hits son instantáneos)
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const list = await apiFetch('/webdl/mylist', { params: { bypass_cache: 'true' } })
      const item = (Array.isArray(list) ? list : []).find(w => w?.id === id || w?.webdownload_id === id)
      const st = item?.download_state || item?.status || ''
      if (/cached|completed|finished|success/i.test(st)) {
        const r = await apiFetch('/webdl/requestdl', { params: { token: getTorboxApiKey(), web_id: String(id), zip: 'false' } })
        const link = typeof r === 'string' ? r : (r?.download_link || r?.link || r?.url || null)
        if (link) return { link, filename: item?.name || '' }
        return { link: null, error: 'requestdl sin URL' }
      }
      if (/failed|error|dead|invalid/i.test(st)) return { link: null, error: `job ${st}` }
    }
    return { link: null, error: 'timeout esperando job' }
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
      if (/cached|completed|finished|success/i.test(st)) {
        const files = Array.isArray(t?.files) ? t.files : []
        const pick = fileFilter ? files.find(fileFilter) : null
        const file = pick || files.filter(f => /\.(mp4|mkv|avi|mov|m4v)$/i.test(f?.name || '')).sort((a, b) => (b?.size || 0) - (a?.size || 0))[0] || files.sort((a, b) => (b?.size || 0) - (a?.size || 0))[0]
        if (!file) return { link: null, error: 'sin fichero' }
        const r = await apiFetch('/torrents/requestdl', { params: { token: getTorboxApiKey(), torrent_id: String(tid), file_id: String(file.id ?? file.file_id ?? 0), zip: 'false' } })
        const link = typeof r === 'string' ? r : (r?.download_link || r?.link || r?.url || null)
        if (link) return { link, filename: file.name || t?.name || '' }
        return { link: null, error: 'requestdl sin URL' }
      }
      if (/failed|error|dead|invalid/i.test(st)) return { link: null, error: `torrent ${st}` }
    }
    return { link: null, error: 'timeout esperando torrent' }
  } catch (e) {
    console.warn('[TorBox] resolveMagnet fail', e?.message)
    return { link: null, error: e?.message || 'magnet failed' }
  }
}
