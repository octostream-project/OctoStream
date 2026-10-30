// HTTP helpers for TDT Spain (platform-aware).

import {
  httpGetJson,
  httpGetText,
  httpPostJson as httpPostJsonImpl,
  httpPostText as httpPostTextImpl,
} from '../../../utils/httpClient.js'
import { logWarn } from '../../../utils/logger.js'
import { isAndroidNative } from '../../../utils/platform.js'
import { proxied } from './constants.js'

export async function fetchGzJson(url) {
  const fetchUrl = proxied(url)
  try {
    return await httpGetJson(fetchUrl, { 'Accept-Encoding': 'gzip' }, undefined, true)
  } catch (e) {
    if (typeof DecompressionStream !== 'undefined' && !isAndroidNative()) {
      try {
        const res = await fetch(fetchUrl, {
          signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const ds = new DecompressionStream('gzip')
        const decompressed = res.body.pipeThrough(ds)
        const text = await new Response(decompressed).text()
        return JSON.parse(text)
      } catch (e2) {
        logWarn('TDT Spain fetchGzJson decompress failed', String(e2?.message || e2))
      }
    }
    throw e
  }
}

export async function fetchJson(url, headers = {}) {
  return httpGetJson(proxied(url), headers, undefined, true)
}

export async function fetchText(url, headers = {}) {
  return httpGetText(proxied(url), headers, undefined, true)
}

export function httpPostJson(url, body, headers = {}, form = false, signal) {
  return httpPostJsonImpl(url, body, headers, form, signal, true)
}

export function httpPostText(url, body, headers = {}, signal) {
  return httpPostTextImpl(url, body, headers, signal, true)
}
