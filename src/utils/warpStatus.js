// Shared WARP/Aether connection status helper.
// Used by Home.jsx, LiveTV.jsx, Details.jsx, Search.jsx to block requests
// until WARP is ready, preventing IP leaks in ALL scenarios:
// - App startup: WARP connects first, then catalogs load
// - Background→Foreground (repose): WARP reconnects, then requests proceed
// - Manual disconnect: requests blocked, only TDT Spain works (direct)
// - Desktop/Electron dev: Aether SOCKS5 on 127.0.0.1:1819 acts as WARP

import { isAndroidNative } from './platform.js'

let _connected = false
let _connecting = false
let _listeners = []
let _pollTimer = null
let _refreshing = null
const _waiters = new Set()

// Whether the user wants WARP to come up automatically. When disabled,
// requests must NOT be gated on the tunnel at all.
export function warpAutoConnectEnabled() {
  try { return localStorage.getItem('octostream_warp_autoconnect') !== 'false' } catch { return true }
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
    // Desktop/Electron: detect Aether/WARP via the Electron session proxy.
    _refreshing = probeDesktopWarp()
      .then(up => {
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
  _refreshing = import('@octostream/cloud-proxy')
    .then(({ CloudProxy }) => CloudProxy.getStatus())
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
    const probe = async () => {
      for (let i = 0; i < 3 && !settled; i++) {
        await refresh()
        if (_connected || _connecting) return // handshake in progress → wait for it
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
