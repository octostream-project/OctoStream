// HTTP client that works across platforms.
// On Android (Capacitor), uses CapacitorHttp to bypass CORS restrictions.
// On Electron/web, uses standard fetch (Electron strips CORS in main process).
// All functions accept an optional AbortSignal for request cancellation.

import { CapacitorHttp } from '@capacitor/core'
import { isAndroidNative } from './platform.js'
import { CloudProxy } from './cloudProxy.js'

// Hosts com geobloqueio (directos TDT/RTVE/Atresmedia/Mediaset e ads).
// Com o túnel Riseup activo, os pedidos sairiam por França e o CDN
// bloqueava/ligava a URL a uma IP estrangeira. CapacitorHttp não consegue
// atar sockets a uma rede, por isso estes hosts vão por
// CloudProxy.directFetch — HttpURLConnection aberto na Network física
// (requer allowBypass() no VpnService.Builder).
const GEO_HOST_RE = /(^|\.)(tdtspain\.com|tdtchannels\.com|rtve\.es|mediaset\.net|mediasetinfinity\.es|atresplayer\.com|atresmedia\.com|dai\.google\.com|doubleclick\.net|hdfull\.[a-z]{2,10})$/i
function isGeoHost(url) {
  try { return GEO_HOST_RE.test(new URL(url).hostname) } catch { return false }
}
// Bootstrap de Riseup: generar el .ovpn exige salir a riseup.net ANTES de
// que exista el túnel. Si estas peticiones esperan al CONNECTED se produce
// un deadlock (el túnel no puede subir sin el perfil que están pidiendo) —
// deben salir directas siempre.
const VPN_BOOTSTRAP_HOST_RE = /(^|\.)riseup\.net$/i
function isVpnBootstrapHost(url) {
  try { return VPN_BOOTSTRAP_HOST_RE.test(new URL(url).hostname) } catch { return false }
}
// Gate fail-closed: cuando Riseup está configurado para auto-conectar, no
// permitimos que requests IP-bound escapen por la red física antes del CONNECTED.
export async function waitForVpnTunnel(maxMs = 30000, { required = false } = {}) {
  if (!isAndroidNative()) return
  if (!required) {
    try {
      if (localStorage.getItem('octostream_riseup_autoconnect') !== 'true') return
    } catch { return }
  }
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    let st
    try {
      st = await CloudProxy.riseupTunnelStatus()
    } catch {
      const error = new Error('Riseup VPN status unavailable; request blocked to prevent IP leak')
      error.code = 'VPN_NOT_CONNECTED'
      throw error
    }
    if (st?.connected) return
    await new Promise(r => setTimeout(r, 400))
  }
  const error = new Error('Riseup VPN is not connected; request blocked to prevent IP leak')
  error.code = 'VPN_NOT_CONNECTED'
  throw error
}
async function nativeRequest(opts) {
  if (opts.bypassVpn || isGeoHost(opts.url)) {
    try {
      const r = await CloudProxy.directFetch(opts)
      if (r && typeof r.status === 'number') return r
    } catch { /* sem rede física ou host fora da lista: cai no CapacitorHttp */ }
  }
  if (!isVpnBootstrapHost(opts.url)) await waitForVpnTunnel()
  return CapacitorHttp.request(opts)
}

const DEFAULT_UA = 'OctoStream/1.0'

// Default timeout so requests can't hang forever when no signal is passed.
// AbortSignal.timeout needs WebView ~103+; we fall back to a manual controller.
const REQUEST_TIMEOUT_MS = 20000
const NATIVE_TIMEOUTS = { connectTimeout: 15000, readTimeout: REQUEST_TIMEOUT_MS }
function defaultTimeoutSignal() {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }
  } catch { /* older WebViews */ }
  return undefined
}
function effectiveSignal(signal) {
  return signal || defaultTimeoutSignal()
}

// Señal que aborta cuando lo hace la externa o al cumplirse `ms`.
// Para sondas de dominio: un candidato caído no puede bloquear los demás
// durante los 20s del timeout por defecto.
export function shortSignal(signal, ms) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error(`probe timeout ${ms}ms`)), ms)
  const onOuterAbort = () => {
    clearTimeout(timer) // abort temprano: no dejar el timer vivo hasta ms
    ctl.abort(signal.reason)
  }
  if (signal?.aborted) onOuterAbort()
  else signal?.addEventListener('abort', onOuterAbort, { once: true })
  return ctl.signal
}

/**
 * Fetch JSON with platform-aware HTTP client.
 * @param {string} url
 * @param {Object} headers
 * @param {AbortSignal} [signal] - optional abort signal (web/fetch only)
 */
export async function httpGetJson(url, headers = {}, signal, bypassVpn = false, strictNative = false) {
  signal = effectiveSignal(signal)
  if (isAndroidNative()) {
    const isGz = url.endsWith('.gz')
    let response
    try {
      response = await nativeRequest({
        ...NATIVE_TIMEOUTS,
        method: 'GET',
        url,
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        responseType: isGz ? 'blob' : 'text',
        bypassVpn,
      })
      if (response.status >= 400) {
        const err = new Error(`HTTP ${response.status}`)
        err.httpStatus = response.status
        throw err
      }
    } catch (e) {
      if (strictNative || e?.code === 'VPN_NOT_CONNECTED') throw e
      if (e?.name === 'AbortError' || e?.httpStatus) throw e
      const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, signal })
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`)
        err.httpStatus = res.status
        throw err
      }
      try { return await res.json() } catch { throw new Error('Respuesta no es JSON válido') }
    }
    // Parseo FUERA del try de red: un cuerpo no-JSON no debe reintentar la
    // petición (antes el catch lo recogía y hacía un segundo fetch idéntico).
    if (isGz) {
      let blob
      if (response.data instanceof Blob) {
        blob = response.data
      } else if (typeof response.data === 'string') {
        try {
          const binary = atob(response.data)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          blob = new Blob([bytes])
        } catch {
          blob = new Blob([response.data])
        }
      } else {
        blob = response.data
      }
      if (typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('gzip')
        const decompressed = blob.stream().pipeThrough(ds)
        const text = await new Response(decompressed).text()
        try { return JSON.parse(text) } catch { throw new Error('Respuesta gzip no es JSON válido') }
      }
      throw new Error('DecompressionStream not available for gzip')
    }

    const data = response.data || ''
    try { return typeof data === 'string' ? JSON.parse(data) : data }
    catch { throw new Error('Respuesta no es JSON válido') }
  }

  const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, signal })
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    err.httpStatus = res.status
    throw err
  }
  try { return await res.json() } catch { throw new Error('Respuesta no es JSON válido') }
}

/**
 * POST JSON with platform-aware HTTP client.
 */
export async function httpPostJson(url, body, headers = {}, form = false, signal, bypassVpn = false) {
  signal = effectiveSignal(signal)
  if (isAndroidNative()) {
    const response = await nativeRequest({
        ...NATIVE_TIMEOUTS,
      bypassVpn,
      method: 'POST',
      url,
      headers: { 'User-Agent': DEFAULT_UA, ...headers },
      // parseBodyForCapacitor respeta strings form-urlencode y deja pasar
      // texto no-JSON — antes JSON.parse() lanzaba SyntaxError con esos bodies.
      data: form ? body : parseBodyForCapacitor(body, headers),
      responseType: 'json',
    })
    if (response.status >= 400) {
      const err = new Error(`HTTP ${response.status}`)
      err.httpStatus = response.status
      throw err
    }
    try { return typeof response.data === 'string' ? JSON.parse(response.data) : response.data }
    catch { throw new Error('Respuesta no es JSON válido') }
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': DEFAULT_UA, ...headers },
    body: form ? body : JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  try { return await response.json() } catch { throw new Error('Respuesta no es JSON válido') }
}

/**
 * Fetch text with platform-aware HTTP client.
 */
export async function httpGetText(url, headers = {}, signal, bypassVpn = false) {
  const { data } = await httpGetWithHeaders(url, headers, signal, bypassVpn)
  return data
}

/**
 * GET text and return both body text and response headers.
 * Used for login flows that need to capture Set-Cookie headers.
 */
export async function httpGetWithHeaders(url, headers = {}, signal, bypassVpn = false) {
  signal = effectiveSignal(signal)
  if (isAndroidNative()) {
    try {
      const response = await nativeRequest({
        ...NATIVE_TIMEOUTS,
        method: 'GET',
        url,
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        responseType: 'text',
        bypassVpn,
      })
      if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
      return { data: response.data || '', headers: response.headers || {} }
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const hdrs = {}
      res.headers.forEach((v, k) => { hdrs[k] = v })
      return { data: text, headers: hdrs }
    }
  }
  const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  const hdrs = {}
  res.headers.forEach((v, k) => { hdrs[k] = v })
  return { data: text, headers: hdrs }
}

/**
 * POST text/form with platform-aware HTTP client. Returns text response.
 */
// Return the body ready for CapacitorHttp: form-encoded strings go raw
// (CapacitorHttp would otherwise serialize objects as JSON and break form
// POSTs); JSON strings are parsed into objects.
function parseBodyForCapacitor(body, headers = {}) {
  if (typeof body !== 'string') return body
  if (headers['Content-Type']?.includes('form')) return body
  try { return JSON.parse(body) } catch { return body }
}

export async function httpPostText(url, body, headers = {}, signal) {
  signal = effectiveSignal(signal)
  if (isAndroidNative()) {
    try {
      const response = await nativeRequest({
        ...NATIVE_TIMEOUTS,
        method: 'POST',
        url,
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        data: parseBodyForCapacitor(body, headers),
        responseType: 'text',
      })
      if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
      return response.data
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        body,
        signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    }
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': DEFAULT_UA, ...headers },
    body,
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/**
 * POST text/form and return both body text and response headers.
 * Used for login flows that need to capture Set-Cookie headers.
 */
export async function httpPostWithHeaders(url, body, headers = {}, signal) {
  signal = effectiveSignal(signal)
  if (isAndroidNative()) {
    try {
      const response = await nativeRequest({
        ...NATIVE_TIMEOUTS,
        method: 'POST',
        url,
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        data: parseBodyForCapacitor(body, headers),
        responseType: 'text',
      })
      if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
      return { data: response.data || '', headers: response.headers || {} }
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        body,
        signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const hdrs = {}
      res.headers.forEach((v, k) => { hdrs[k] = v })
      return { data: text, headers: hdrs }
    }
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': DEFAULT_UA, ...headers },
    body,
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  const hdrs = {}
  res.headers.forEach((v, k) => { hdrs[k] = v })
  return { data: text, headers: hdrs }
}

// Un blob de CapacitorHttp es base64; cualquier otra cosa significa que el
// servidor mintió el Content-Type (p.ej. "application/json" sobre binario) y
// Capacitor decodificó el cuerpo como texto, corrompiendo los bytes.
const isBase64 = (s) => typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s)

async function fetchBlobFallback(url, headers, signal) {
  const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

/**
 * Fetch blob/binary with platform-aware HTTP client.
 */
export async function httpGetBlob(url, headers = {}, signal) {
  signal = effectiveSignal(signal)
  if (isAndroidNative()) {
    try {
      const response = await nativeRequest({
        ...NATIVE_TIMEOUTS,
        method: 'GET',
        url,
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        responseType: 'blob',
      })
      if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
      if (isBase64(response.data)) return response.data
      // Contenido corrupto por decodificación de texto: reintentar con fetch
      // (los endpoints afectados exponen CORS abierto).
      try {
        return await (await fetchBlobFallback(url, headers, signal)).blob()
      } catch (fe) {
        if (fe?.name === 'AbortError') throw fe
        return response.data
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e
    }
  }

  const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.blob()
}

/**
 * Fetch blob/binary and return both body and response headers.
 * Needed by providers that return session tokens in headers (e.g. FCTV).
 */
export async function httpGetBlobWithHeaders(url, headers = {}, signal) {
  signal = effectiveSignal(signal)
  if (isAndroidNative()) {
    try {
      const response = await nativeRequest({
        ...NATIVE_TIMEOUTS,
        method: 'GET',
        url,
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        responseType: 'blob',
      })
      if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
      if (isBase64(response.data)) return { data: response.data, headers: response.headers || {} }
      // Mismo fallback de fetch que httpGetBlob (CORS abierto en el endpoint).
      try {
        const res = await fetchBlobFallback(url, headers, signal)
        const hdrs = { ...(response.headers || {}) }
        res.headers.forEach((v, k) => { hdrs[k] = v })
        return { data: await res.blob(), headers: hdrs }
      } catch (fe) {
        if (fe?.name === 'AbortError') throw fe
        return { data: response.data, headers: response.headers || {} }
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e
    }
  }

  const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const hdrs = {}
  res.headers.forEach((v, k) => { hdrs[k] = v })
  return { data: await res.blob(), headers: hdrs }
}
