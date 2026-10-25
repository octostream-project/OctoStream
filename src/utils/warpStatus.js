// Shared WARP/Aether connection status helper.
// Used by Home.jsx, LiveTV.jsx, Details.jsx, Search.jsx to block requests
// until WARP is ready, preventing IP leaks in ALL scenarios:
// - App startup: WARP connects first, then catalogs load
// - Background→Foreground (repose): WARP reconnects, then requests proceed
// - Manual disconnect: requests blocked, only TDT Spain works (direct)
// - Desktop/Electron dev: Aether SOCKS5 on 127.0.0.1:1819 acts as WARP

import { isAndroidNative } from './platform.js'
import { CloudProxy } from './cloudProxy.js'

let _connected = false
let _connecting = false
let _listeners = []
let _pollTimer = null
let _refreshing = null
let _reconnecting = null
const _waiters = new Set()

// Whether the user wants WARP to come up automatically. When disabled,
// requests must NOT be gated on the tunnel at all.
export function warpAutoConnectEnabled() {
  try { return localStorage.getItem('octostream_warp_autoconnect') !== 'false' } catch { return true }
}

// Kill-switch estricto (ajuste): si el túnel cae, el proxy muerto se
// conserva y TODA petición falla en vez de salir por la IP real.
export function warpStrictEnabled() {
  try { return localStorage.getItem('octostream_warp_strict') === 'true' } catch { return false }
}

let _strictApplied = null
async function applyStrictSetting() {
  if (!isAndroidNative()) return
  const want = warpStrictEnabled()
  if (_strictApplied === want) return
  _strictApplied = want
  try { await CloudProxy.setStrictMode(want) } catch {}
}

// On non-Android (Electron/desktop), the Electron main process routes
// renderer traffic through the Aether SOCKS5 proxy (127.0.0.1:1819) when it
// is present. We detect "WARP connected" by probing a Cloudflare endpoint
// that only resolves through the tunnel. This keeps the anti-leak gating
// consistent across platforms: pages wait for WARP before loading catalogs.
async function probeDesktopWarp() {
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 4000)
    const response = await fetch('https://cloudflare.com/cdn-cgi/trace', {
      signal: controller.signal,
      cache: 'no-store',
    })
    const trace = await response.text()
    clearTimeout(t)
    return response.ok && /(?:^|\n)warp=on(?:\n|$)/.test(trace)
  } catch {
    return false
  }
}

function notifyWaiters(connected) {
  if (!connected) return
  for (const resolve of _waiters) resolve(true)
  _waiters.clear()
}

function setConnected(connected) {
  const changed = _connected !== connected
  _connected = connected
  notifyWaiters(connected)
  if (!changed) return
  for (const listener of _listeners) {
    try { listener(connected) } catch {}
  }
}

async function refresh() {
  if (_refreshing) return _refreshing
  if (!isAndroidNative()) {
    // Electron: estado real del proceso aether vía IPC (connecting incluido);
    // fallback al probe cloudflare.com/trace si no hay bridge (web).
    const bridge = window.octostream?.cloudProxy
    _refreshing = (bridge ? bridge.getStatus().then(s => ({ up: !!s.connected, connecting: !!s.connecting })) : probeDesktopWarp().then(up => ({ up, connecting: false })))
      .then(({ up, connecting }) => {
        _connecting = connecting
        setConnected(up)
        return _connected
      })
      .catch(() => {
        setConnected(false)
        return false
      })
      .finally(() => { _refreshing = null })
    return _refreshing
  }
  // Fachada estática (import dinámico en frío = regresión del "Conectando
  // WARP" eterno de la 1.61 en WebViews de TV antiguos).
  _refreshing = Promise.resolve()
    .then(() => applyStrictSetting())
    .then(() => CloudProxy.getStatus())
    .then(status => {
      _connecting = !!status.connecting
      setConnected(!!status.connected)
      return _connected
    })
    .catch(() => {
      setConnected(false)
      return false
    })
    .finally(() => { _refreshing = null })
  return _refreshing
}

function schedulePoll(delay = 0) {
  if (_pollTimer || _listeners.length === 0) return
  _pollTimer = setTimeout(async () => {
    _pollTimer = null
    await refresh()
    schedulePoll(_connected ? 60000 : 10000)
  }, delay)
}

function stopPolling() {
  if (_pollTimer) clearTimeout(_pollTimer)
  _pollTimer = null
}

export function isWarpConnected() {
  return _connected
}

export function waitForWarp(timeoutMs = 15000) {
  if (_connected) return Promise.resolve(true)
  // User opted out of WARP → don't gate requests on the tunnel at all.
  if (!warpAutoConnectEnabled()) return Promise.resolve(false)
  // On desktop/Electron, refresh() probes the Aether/WARP session proxy.
  // On Android, refresh() queries the native VPN plugin.
  return new Promise(resolve => {
    let settled = false
    const finish = connected => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      _waiters.delete(onConnected)
      resolve(connected)
    }
    const onConnected = () => finish(true)
    const timeout = setTimeout(() => finish(_connected), timeoutMs)
    _waiters.add(onConnected)
    // Give up early when the tunnel is neither up nor handshaking, instead
    // of burning the whole timeout on every page load. A few spaced probes
    // still cover the startup window where App.jsx is about to call
    // connect() but getStatus() has not observed "connecting" yet.
    let reconnectTried = false
    const probe = async () => {
      for (let i = 0; i < 3 && !settled; i++) {
        await refresh()
        if (_connected || _connecting) return // handshake in progress → wait for it
        // A mitad de sesión el túnel puede marcarse caído (la sonda del
        // puerto local del ExoPlayer llama a markDisconnected()) y nadie lo
        // reconectaba hasta reabrir la app. Relanzar connect() una vez: el
        // plugin mata el aether ahogado y levanta uno nuevo (~2s).
        // Single-flight: varios waiters concurrentes comparten el mismo
        // connect() — antes cada uno lanzaba el suyo (6 arranques a la vez).
        if (!reconnectTried && isAndroidNative() && warpAutoConnectEnabled()) {
          reconnectTried = true
          if (!_reconnecting) {
            _reconnecting = CloudProxy.connect()
              .catch(() => {})
              .finally(() => { _reconnecting = null; refresh() })
          }
        }
        if (i < 2) await new Promise(r => setTimeout(r, 700))
      }
      finish(false)
    }
    probe()
  })
}

export function resetWarpReady() {
  setConnected(false)
}

export function subscribeWarpStatus(listener) {
  if (!_listeners.includes(listener)) _listeners.push(listener)
  try { listener(_connected) } catch {}
  schedulePoll(0)
  return () => {
    _listeners = _listeners.filter(item => item !== listener)
    if (_listeners.length === 0) stopPolling()
  }
}

export async function refreshWarpStatus() {
  return refresh()
}

// Detalle del túnel para el indicador de Ajustes: transporte activo
// (masque / masque-h2 / wg), guardián foreground y racha de muertes.
// En Electron el bridge devuelve el estado del proceso aether del main.
export async function getWarpDetails() {
  try {
    if (!isAndroidNative()) {
      const bridge = window.octostream?.cloudProxy
      const st = bridge ? await bridge.getStatus().catch(() => ({})) : {}
      return { connected: !!st.connected, connecting: !!st.connecting, protocol: st.protocol || '', guard: false, tunnelFails: 0, exitLoc: st.exitLoc || '', remote: st.remote || '', shareLan: !!st.shareLan }
    }
    const st = await CloudProxy.getStatus()
    return {
      connected: !!st?.connected,
      connecting: !!st?.connecting,
      protocol: st?.protocol || '',
      guard: !!st?.guard,
      tunnelFails: st?.tunnelFails || 0,
      strict: !!st?.strict,
      reconnects: st?.reconnects || 0,
      uptimeMs: st?.uptimeMs || 0,
      error: st?.error || '',
      exitLoc: st?.exitLoc || '',
      exitIp: st?.exitIp || '',
      exitCountry: st?.exitCountry || '',
      exitColo: st?.exitColo || '',
      remote: st?.remote || '',
      shareLan: !!st?.shareLan,
    }
  } catch {
    return null
  }
}

// ─── Test de fuga de IP ─────────────────────────────────────────────────
// Compara la IP que sale por la ruta normal de la app (proxy WARP) con la
// de la red física. Es la prueba honesta de "sin fugas": si ambas
// coinciden, el tráfico sale por la IP real aunque WARP diga conectado.
export async function checkIpLeak() {
  const parseTrace = text => ({
    ip: (String(text).match(/(?:^|\n)ip=([^\n]+)/) || [])[1] || '',
    loc: (String(text).match(/(?:^|\n)loc=([^\n]+)/) || [])[1] || '',
    colo: (String(text).match(/(?:^|\n)colo=([^\n]+)/) || [])[1] || '',
    warp: (String(text).match(/(?:^|\n)warp=([^\n]+)/) || [])[1] || '',
  })
  const URL = 'https://cloudflare.com/cdn-cgi/trace'
  const result = { tunnel: null, direct: null }
  // Ruta normal de la app (CapacitorHttp → proxy WARP en Android).
  try {
    if (isAndroidNative()) {
      const { CapacitorHttp } = await import('@capacitor/core')
      const r = await CapacitorHttp.get({ url: URL, responseType: 'text', connectTimeout: 8000, readTimeout: 8000 })
      result.tunnel = parseTrace(r.data || '')
    } else {
      const r = await fetch(URL, { cache: 'no-store' })
      result.tunnel = parseTrace(await r.text())
    }
  } catch (e) {
    result.tunnel = { error: e?.message || 'sin respuesta' }
  }
  // Red física (directFetch con bypass — solo Android; en escritorio la
  // sesión entera va por el proxy y no hay ruta directa separada).
  if (isAndroidNative()) {
    try {
      const r = await CloudProxy.directFetch({ url: URL, bypassVpn: true, responseType: 'text' })
      result.direct = parseTrace(r.data || '')
    } catch (e) {
      result.direct = { error: e?.message || 'sin respuesta' }
    }
  }
  return result
}
