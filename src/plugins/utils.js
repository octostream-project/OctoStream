// Shared helpers for plugin implementations.
// These wrappers use the platform-aware HTTP client so that plugins work
// on web, Electron and Android without CORS issues.

import { httpGetJson, httpGetText } from '../utils/httpClient.js'
import { sanitizeUrl } from '../utils/sanitizeUrl.js'

/**
 * Replace `{key}` placeholders in a URL template with encoded values.
 */
export function replaceParams(url, params) {
  let result = url
  Object.entries(params).forEach(([key, value]) => {
    const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(`\\{${safeKey}\\}`, 'g'), encodeURIComponent(String(value)))
  })
  return result
}

/**
 * Fetch JSON safely through the platform-aware HTTP client.
 * Returns null or the parsed JSON on error instead of throwing.
 */
export async function safeFetchJson(url, headers = {}, signal) {
  const safeUrl = sanitizeUrl(url)
  if (!safeUrl) return null
  try {
    return await httpGetJson(safeUrl, headers, signal)
  } catch (e) {
    return null
  }
}

/**
 * Fetch JSON and throw on network/parse errors (keeps old contract).
 */
export async function fetchJson(url, headers = {}, signal) {
  const safeUrl = sanitizeUrl(url)
  if (!safeUrl) throw new Error('Unsafe or invalid URL')
  return httpGetJson(safeUrl, headers, signal)
}

/**
 * Fetch text safely through the platform-aware HTTP client.
 */
export async function safeFetchText(url, headers = {}, signal) {
  const safeUrl = sanitizeUrl(url)
  if (!safeUrl) return null
  try {
    return await httpGetText(safeUrl, headers, signal)
  } catch (e) {
    return null
  }
}

/**
 * Race a promise against a timeout.
 */
export function withTimeout(promise, ms, message = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ])
}

/**
 * Like withTimeout but actually cancels the work: `fn` receives an
 * AbortSignal that fires on timeout or when `outerSignal` aborts, so
 * plugins that honor signals stop the in-flight request instead of
 * letting it consume bandwidth after the caller gave up.
 */
export function withCancelTimeout(fn, ms, outerSignal, message = 'Operation timed out') {
  const ctrl = new AbortController()
  const onOuter = () => ctrl.abort()
  if (outerSignal?.aborted) ctrl.abort()
  else outerSignal?.addEventListener('abort', onOuter, { once: true })
  let timer
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new Error(message)) }, ms)
  })
  const workP = Promise.resolve().then(() => fn(ctrl.signal))
  return Promise.race([workP, timeoutP]).finally(() => {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuter)
  })
}
