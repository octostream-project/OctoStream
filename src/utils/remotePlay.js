// Envío de reproducción a otro OctoStream en la misma red (LAN cast).
// El receptor corre el plugin nativo SyncServer (NanoHTTPD :8765) que expone
// /ping, /play y /stop. El escaneo hace un barrido del /24 local en lotes.

import { isAndroidNative } from './platform.js'
import { httpGetJson, httpPostJson } from './httpClient.js'

let syncServerPromise = null

// Carga perezosa del plugin nativo (solo existe en Android).
// OJO: registerPlugin devuelve un Proxy y await sobre él intenta llamar a un
// método nativo "then" → se devuelve una fachada plana con los métodos.
export function getSyncServer() {
  if (!isAndroidNative()) return Promise.resolve(null)
  if (!syncServerPromise) {
    syncServerPromise = import('@optopus/sync-server')
      .then(m => {
        const p = m.default
        return {
          start: () => p.start(),
          stop: () => p.stop(),
          getIpAddress: () => p.getIpAddress(),
          setLocalData: (o) => p.setLocalData(o),
          getReceivedData: () => p.getReceivedData(),
          clearReceivedData: () => p.clearReceivedData(),
          allowDevice: (o) => p.allowDevice(o),
          getPairedDevices: () => p.getPairedDevices(),
          forgetDevices: () => p.forgetDevices(),
          addListener: (n, cb) => p.addListener(n, cb),
        }
      })
      .catch(e => {
        console.warn('[RemotePlay] Plugin no disponible:', e?.message)
        return null
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

// Barrido del /24 local en lotes paralelos. Cada host se prueba contra
// /ping con timeout corto; ~254 hosts en bloques de 32 tardan unos segundos.
export async function scanDevices(onProgress) {
  const SyncServer = await getSyncServer()
  if (!SyncServer) return []
  const { ip } = await SyncServer.getIpAddress()
  const prefix = ip.split('.').slice(0, 3).join('.')
  const hosts = []
  for (let i = 1; i <= 254; i++) {
    const h = `${prefix}.${i}`
    if (h !== ip) hosts.push(h)
  }
  const found = []
  const BATCH = 32
  for (let i = 0; i < hosts.length; i += BATCH) {
    await Promise.allSettled(hosts.slice(i, i + BATCH).map(async (host) => {
      try {
        const d = await httpGetJson(`http://${host}:8765/ping`, {}, AbortSignal.timeout(900))
        if (d?.ok) {
          found.push({ ip: host, url: `http://${host}:8765`, name: d.model || 'OctoStream' })
        }
      } catch { /* host sin OctoStream */ }
    }))
    onProgress?.(Math.min(i + BATCH, hosts.length), hosts.length)
  }
  return found
}

export async function pingDevice(deviceUrl) {
  try {
    const d = await httpGetJson(`${deviceUrl}/ping`, {}, AbortSignal.timeout(3000))
    return d?.ok === true ? d : null
  } catch { return null }
}

// Envía el stream al dispositivo remoto; allí se abre el reproductor.
// Devuelve true | 'pair' (el receptor pide aceptación al usuario) | false.
export async function sendPlay(deviceUrl, { url, title, type = 'hls', mode = 'live', imdbId, season, episode }) {
  try {
    const res = await httpPostJson(
      `${deviceUrl}/play`,
      JSON.stringify({ url, title, type, mode, imdbId, season, episode }),
      { 'Content-Type': 'application/json' },
      false,
      AbortSignal.timeout(6000)
    )
    if (res?.ok) {
      saveLastDevice({ url: deviceUrl, ip: deviceUrl.replace(/^https?:\/\//, '').split(':')[0], name: 'OctoStream' })
    }
    return res?.ok === true
  } catch (e) {
    // 403 needsPair: el receptor mostró el diálogo de aceptación.
    if (/403/.test(e?.message || '')) return 'pair'
    throw e
  }
}

// Detiene la reproducción en el dispositivo remoto.
export async function sendStop(deviceUrl) {
  try {
    const res = await httpPostJson(`${deviceUrl}/stop`, '{}', { 'Content-Type': 'application/json' }, false, AbortSignal.timeout(4000))
    return res?.ok === true
  } catch { return false }
}
