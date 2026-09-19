// HTTP client that works across platforms.
// On Android (Capacitor), uses CapacitorHttp to bypass CORS restrictions.
// On Electron/web, uses standard fetch (Electron strips CORS in main process).
// All functions accept an optional AbortSignal for request cancellation.

import { CapacitorHttp } from '@capacitor/core'
import { isAndroidNative } from './platform.js'

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
  if (signal?.aborted) ctl.abort(signal.reason)
  else signal?.addEventListener('abort', () => ctl.abort(signal.reason), { once: true })
  setTimeout(() => ctl.abort(new Error(`probe timeout ${ms}ms`)), ms)
  return ctl.signal
}

/**
 * Fetch JSON with platform-aware HTTP client.
 * @param {string} url
 * @param {Object} headers
 * @param {AbortSignal} [signal] - optional abort signal (web/fetch only)
 */
export async function httpGetJson(url, headers = {}, signal) {
  signal = effectiveSignal(signal)
  if (isAndroidNative()) {
    try {
      const isGz = url.endsWith('.gz')
      const response = await CapacitorHttp.request({
        ...NATIVE_TIMEOUTS,
        method: 'GET',
        url,
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        responseType: isGz ? 'blob' : 'text',
      })
      if (response.status >= 400) {
        const err = new Error(`HTTP ${response.status}`)
        err.httpStatus = response.status
        throw err
      }

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
    } catch (e) {
      if (e?.name === 'AbortError' || e?.httpStatus) throw e
      const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, signal })
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`)
        err.httpStatus = res.status
        throw err
      }
      try { return await res.json() } catch { throw new Error('Respuesta no es JSON válido') }
    }
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
export async function httpPostJson(url, body, headers = {}, form = false, signal) {
  signal = effectiveSignal(signal)
  if (isAndroidNative()) {
    const response = await CapacitorHttp.request({
        ...NATIVE_TIMEOUTS,
      method: 'POST',
      url,
      headers: { 'User-Agent': DEFAULT_UA, ...headers },
      data: form ? body : (typeof body === 'string' ? JSON.parse(body) : body),
      responseType: 'json',
    })
    if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
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
export async function httpGetText(url, headers = {}, signal) {
  const { data } = await httpGetWithHeaders(url, headers, signal)
  return data
}

/**
 * GET text and return both body text and response headers.
 * Used for login flows that need to capture Set-Cookie headers.
 */
export async function httpGetWithHeaders(url, headers = {}, signal) {
  signal = effectiveSignal(signal)
  if (isAndroidNative()) {
    try {
      const response = await CapacitorHttp.request({
        ...NATIVE_TIMEOUTS,
        method: 'GET',
        url,
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        responseType: 'text',
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
      const response = await CapacitorHttp.request({
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
      const response = await CapacitorHttp.request({
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
      const response = await CapacitorHttp.request({
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
      const response = await CapacitorHttp.request({
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
