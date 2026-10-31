// Envío de reproducción a otro OctoStream en la misma red (LAN cast).
// El receptor corre el plugin nativo SyncServer (NanoHTTPD :8765) que expone
// /ping, /play y /stop. El escaneo hace un barrido del /24 local en lotes.

import { isAndroidNative } from './platform.js'
import { httpGetJson, httpPostJson } from './httpClient.js'
import { isValidWatchPartyState } from './watchParty.js'
// Import ESTÁTICO del plugin — registra 'SyncServer' al cargar la app. El
// import dinámico en frío (chunk + __vite__mapDeps) es frágil en WebViews
// de TV antiguos: si fallaba, getSyncServer() devolvía null → el panel de
// sync quedaba en "Buscando…" eterno y el dispositivo ni se anunciaba.
import SyncServerPlugin from '@optopus/sync-server'

let syncServerPromise = null

// Carga perezosa del backend de sync: plugin nativo en Android, servidor
// Node en el proceso principal en Electron (mismo contrato de métodos).
// OJO: registerPlugin devuelve un Proxy y await sobre él intenta llamar a un
// método nativo "then" → se devuelve una fachada plana con los métodos.
export function getSyncServer() {
  if (typeof window !== 'undefined' && window.octostream?.isElectron && window.octostream?.sync) {
    if (!syncServerPromise) {
      const s = window.octostream.sync
      syncServerPromise = Promise.resolve({
        start: () => s.start(),
        stop: () => s.stop(),
        getIpAddress: () => s.getDeviceInfo(),
        setLocalData: (o) => s.setLocalData(o),
        getReceivedData: () => s.getReceivedData(),
        clearReceivedData: () => s.clearReceivedData(),
        allowDevice: (o) => s.allowDevice(o),
        getPairedDevices: () => s.getPairedDevices(),
        forgetDevices: () => s.forgetDevices(),
        getDeviceInfo: () => s.getDeviceInfo(),
        getDiscoveredDevices: () => s.getDiscoveredDevices(),
        answerPair: (o) => s.answerPair(o),
        addListener: (n, cb) => {
          const off = s.on((ev) => { if (ev?.name === n) cb(ev.data ?? {}) })
          return Promise.resolve({ remove: off })
        },
      })
    }
    return syncServerPromise
  }
  if (!isAndroidNative()) return Promise.resolve(null)
  if (!syncServerPromise) {
    const p = SyncServerPlugin
    syncServerPromise = Promise.resolve({
      start: () => p.start(),
      stop: () => p.stop(),
      getIpAddress: () => p.getIpAddress(),
      setLocalData: (o) => p.setLocalData(o),
      getReceivedData: () => p.getReceivedData(),
      clearReceivedData: () => p.clearReceivedData(),
      allowDevice: (o) => p.allowDevice(o),
      getPairedDevices: () => p.getPairedDevices(),
      forgetDevices: () => p.forgetDevices(),
      getDeviceInfo: () => p.getDeviceInfo(),
      getDiscoveredDevices: () => p.getDiscoveredDevices(),
      answerPair: (o) => p.answerPair(o),
      addListener: (n, cb) => p.addListener(n, cb),
    })
  }
  return syncServerPromise
}

const LAST_DEVICE_KEY = 'octostream_last_cast_device'

export function getLastDevice() {
  try {
    const raw = localStorage.getItem(LAST_DEVICE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function saveLastDevice(device) {
  try { localStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(device)) } catch {}
}

// ── Identidad propia y tokens de emparejamiento ──────────────────────────
// Estilo LocalSend: cada dispositivo tiene deviceId + alias ("Pulpo Sabio")
// + fingerprint. Al emparejar, el receptor emite un token que el emisor
// guarda y manda como X-Pair-Token — la autorización es por identidad, no
// por IP (sobrevive a cambios de DHCP y no es falsificable con la IP sola).

export async function getDeviceInfo() {
  const SyncServer = await getSyncServer()
  if (!SyncServer?.getDeviceInfo) return null
  try { return await SyncServer.getDeviceInfo() } catch { return null }
}

const TOKENS_KEY = 'octostream_pair_tokens'
function loadTokens() {
  try { return JSON.parse(localStorage.getItem(TOKENS_KEY) || '{}') } catch { return {} }
}
function saveToken(deviceId, info) {
  try {
    const t = loadTokens()
    t[deviceId] = { token: info.token, alias: info.alias || '', fingerprint: info.fingerprint || '' }
    localStorage.setItem(TOKENS_KEY, JSON.stringify(t))
  } catch {}
}
export function forgetTokens() {
  try { localStorage.removeItem(TOKENS_KEY) } catch {}
}

// Dispositivos vistos por UDP broadcast (anuncio automático estilo LocalSend).
export async function getDiscovered() {
  const SyncServer = await getSyncServer()
  if (!SyncServer?.getDiscoveredDevices) return []
  try {
    const res = await SyncServer.getDiscoveredDevices()
    return (res?.devices || []).map(d => ({
      ip: d.ip, url: d.url, name: d.alias || 'OctoStream',
      alias: d.alias, deviceId: d.deviceId, fingerprint: d.fingerprint,
    }))
  } catch { return [] }
}

// Combina un timeout propio con un signal externo (AbortSignal.any no está
// en WebViews antiguos — sin él se pierde el timeout pero no la cancelación).
function linkSignal(signal, timeoutMs) {
  const t = AbortSignal.timeout(timeoutMs)
  if (!signal) return t
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([t, signal]) : signal
}

// /pair: el receptor responde {pending:true} mientras el usuario decide;
// se re-pregunta hasta aceptar ({ok, token}), rechazar (403), cancelar o
// agotar el tiempo. Devuelve true | 'denied' | 'aborted' | 'unsupported'.
export async function pairDevice(deviceUrl, devId, signal) {
  const me = await getDeviceInfo()
  if (!me?.deviceId) return 'unsupported'
  const deadline = Date.now() + 75000
  while (Date.now() < deadline && !signal?.aborted) {
    let res
    try {
      res = await httpPostJson(
        `${deviceUrl}/pair`,
        JSON.stringify({ deviceId: me.deviceId, alias: me.alias, fingerprint: me.fingerprint }),
        { 'Content-Type': 'application/json' },
        false,
        linkSignal(signal, 6000)
      )
    } catch (e) {
      if (signal?.aborted) return 'aborted'
      if (/404/.test(e?.message || '')) return 'unsupported'
      // Error de red puntual: reintentar mientras quede tiempo.
      await new Promise(r => setTimeout(r, 1500))
      continue
    }
    if (res?.ok && res.token) {
      saveToken(devId || res.deviceId, res)
      return true
    }
    if (res?.pending) {
      await new Promise(r => setTimeout(r, 1500))
      continue
    }
    return 'denied'
  }
  return signal?.aborted ? 'aborted' : 'denied'
}

async function authHeaders(deviceUrl, device) {
  const devId = device?.deviceId
  const token = devId ? loadTokens()[devId]?.token : null
  const me = token ? await getDeviceInfo() : null
  if (!token || !me?.deviceId) return null
  return { 'X-Device-Id': me.deviceId, 'X-Pair-Token': token }
}

// ── Descubrimiento ───────────────────────────────────────────────────────
// UDP broadcast primero (instantáneo); barrido del /24 después para cazar
// dispositivos con versiones viejas que no anuncian.
export async function scanDevices(onProgress) {
  const SyncServer = await getSyncServer()
  if (!SyncServer) return []
  // Anuncio propio inmediato + espera corta para que respondan los demás.
  await new Promise(r => setTimeout(r, 800))
  const found = new Map()
  for (const d of await getDiscovered()) found.set(d.ip, d)
  const info = await SyncServer.getIpAddress()
  // Barrer TODOS los /24 locales, no solo el primero: en dispositivos
  // multi-interfaz (TV con Ethernet+WiFi, PC con VPN/Docker) el primer IPv4
  // puede ser el del adaptador equivocado y el barrido nunca alcanzaba a
  // los demás OctoStream. 'ips' lo exponen los backends nuevos; 'ip' solo
  // queda como fallback de versiones viejas.
  const ips = Array.isArray(info?.ips) && info.ips.length ? info.ips : (info?.ip ? [info.ip] : [])
  const prefixes = [...new Set(ips
    .filter(ip => typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip))
    .map(ip => ip.split('.').slice(0, 3).join('.')))]
  if (!prefixes.length) return [...found.values()]
  const localSet = new Set(ips)
  const hosts = []
  for (const prefix of prefixes) {
    for (let i = 1; i <= 254; i++) {
      const h = `${prefix}.${i}`
      if (!localSet.has(h) && !found.has(h)) hosts.push(h)
    }
  }
  const BATCH = 32
  for (let i = 0; i < hosts.length; i += BATCH) {
    await Promise.allSettled(hosts.slice(i, i + BATCH).map(async (host) => {
      try {
        const d = await httpGetJson(`http://${host}:8765/ping`, {}, AbortSignal.timeout(900))
        if (d?.ok) {
          found.set(host, {
            ip: host, url: `http://${host}:8765`,
            name: d.alias || d.model || 'OctoStream',
            alias: d.alias, deviceId: d.deviceId, fingerprint: d.fingerprint,
          })
        }
      } catch { /* host sin OctoStream */ }
    }))
    onProgress?.(Math.min(i + BATCH, hosts.length), hosts.length)
  }
  return [...found.values()]
}

export async function pingDevice(deviceUrl) {
  try {
    const d = await httpGetJson(`${deviceUrl}/ping`, {}, AbortSignal.timeout(3000))
    return d?.ok === true ? d : null
  } catch { return null }
}

// Envía el stream al dispositivo remoto; allí se abre el reproductor.
// Devuelve true | 'pair' (aceptar en el otro dispositivo y reintentar)
// | 'denied' (rechazado) | false.
// Con token de emparejamiento va autenticado; sin él intenta /pair primero
// (diálogo con alias+fingerprint en el receptor) y reintenta solo.
export async function sendPlay(deviceUrl, { url, title, type = 'hls', mode = 'live', imdbId, season, episode, partyId }, device = null, signal = null) {
  const body = JSON.stringify({ url, title, type, mode, imdbId, season, episode, partyId })
  const devId = device?.deviceId || null
  const headers = { 'Content-Type': 'application/json' }
  try {
    let auth = await authHeaders(deviceUrl, device)
    // Sin token pero con identidad remota conocida: emparejar primero —
    // /pair queda pendiente hasta que el usuario acepta en la otra pantalla.
    if (!auth && devId) {
      const p = await pairDevice(deviceUrl, devId, signal)
      if (p === true) auth = await authHeaders(deviceUrl, device)
      else if (p === 'denied') return 'denied'
      else if (p === 'aborted') return false
      // 'unsupported': receptor viejo → flujo legacy por IP abajo
    }
    const res = await httpPostJson(
      `${deviceUrl}/play`, body,
      auth ? { ...headers, ...auth } : headers,
      false, linkSignal(signal, 6000)
    )
    if (res?.ok) {
      // URL() maneja IPv6 ([::1]) y puertos; replace+split(':') los rompía.
      let ip = deviceUrl
      try { ip = new URL(deviceUrl).hostname } catch { /* deviceUrl sin esquema: se guarda tal cual */ }
      saveLastDevice({
        url: deviceUrl, ip,
        name: device?.alias || device?.name || 'OctoStream', deviceId: devId,
      })
    }
    return res?.ok === true
  } catch (e) {
    // 403 needsPair: receptor legacy mostró el diálogo de aceptación.
    if (/403/.test(e?.message || '')) return 'pair'
    throw e
  }
}

// Detiene la reproducción en el dispositivo remoto.
export async function sendStop(deviceUrl, device = null) {
  try {
    const auth = await authHeaders(deviceUrl, device)
    const res = await httpPostJson(
      `${deviceUrl}/stop`, '{}',
      { 'Content-Type': 'application/json', ...(auth || {}) },
      false, AbortSignal.timeout(4000))
    return res?.ok === true
  } catch { return false }
}

// Sync autenticado: GET/POST /sync con token; si falta, empareja primero.
// Devuelve los datos (pull) | true (push) | 'pair' | 'denied' | lanza error.
async function syncRequest(deviceUrl, device, method, data, signal) {
  let auth = await authHeaders(deviceUrl, device)
  if (!auth && device?.deviceId) {
    const p = await pairDevice(deviceUrl, device.deviceId, signal)
    if (p === true) auth = await authHeaders(deviceUrl, device)
    else if (p === 'denied') return 'denied'
    else if (p === 'aborted') throw new DOMException('Sync abortado', 'AbortError')
  }
  const headers = { 'Content-Type': 'application/json', ...(auth || {}) }
  if (method === 'GET') {
    return await httpGetJson(`${deviceUrl}/sync`, headers, linkSignal(signal, 10000))
  }
  await httpPostJson(`${deviceUrl}/sync`, JSON.stringify(data), headers, false, linkSignal(signal, 10000))
  return true
}

export const pullSync = (deviceUrl, device, signal) => syncRequest(deviceUrl, device, 'GET', undefined, signal)
export const pushSync = (deviceUrl, device, data, signal) => syncRequest(deviceUrl, device, 'POST', data, signal)

// Reuses authenticated /sync for tiny watch-party clock updates. This sends
// playback metadata only (no stream URL) and therefore preserves the same
// pairing/token/Origin protections as ordinary LAN sync.
export function sendWatchPartyState(device, state, signal) {
  const url = device?.url || (device?.ip ? `http://${device.ip}:8765` : '')
  if (!url) return Promise.resolve(false)
  const payload = {
    kind: 'octostream-watch-party',
    version: 1,
    partyId: state?.partyId,
    command: 'state',
    mediaKey: String(state?.mediaKey || ''),
    title: String(state?.title || ''),
    position: Number(state?.position),
    playing: state?.playing,
    sentAt: Number(state?.sentAt),
  }
  if (!isValidWatchPartyState(payload)) return Promise.resolve(false)
  return pushSync(url, device, payload, signal).then(result => result === true).catch(() => false)
}
