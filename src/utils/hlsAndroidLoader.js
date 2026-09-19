// Custom HLS.js loader for Android that uses CapacitorHttp to bypass CORS
// Resolves relative URLs against the original manifest URL

import { CapacitorHttp } from '@capacitor/core'
import { isAndroidNative } from './platform.js'

// Track the base URL for resolving relative URLs
let manifestBaseUrl = null

export function setManifestBaseUrl(url) {
  manifestBaseUrl = url
}

function resolveUrl(relative, base) {
  if (!relative) return relative
  if (/^https?:\/\//.test(relative)) return relative
  if (!base) return relative
  try {
    // Standard URL resolution: resolve relative URLs against the full base URL
    // e.g. "hls_drm/alta/v_alta.m3u8" against "https://ztnr.rtve.es/ztnr/7054955.m3u8"
    // gives "https://ztnr.rtve.es/ztnr/hls_drm/alta/v_alta.m3u8"
    return new URL(relative, base).href
  } catch {
    return relative
  }
}

// Solo host:puerto para logs — las URLs HLS firmadas llevan tokens en el query.
function hostOf(u) {
  try { return new URL(u).host } catch { return 'unknown' }
}

/**
 * Custom HLS.js loader for Android using CapacitorHttp.
 * Bypasses CORS by making native HTTP requests.
 */
export function createAndroidHlsLoader(requestHeaders = {}) {
  if (!isAndroidNative()) return null

  // Capture the base URL at creation time so concurrent loaders don't share
  // the module-level manifestBaseUrl (a second stream would overwrite it and
  // break relative segment resolution for the first).
  const capturedBaseUrl = manifestBaseUrl

  class CapacitorHlsLoader {
    constructor(config) {
      this.config = config
      this.aborted = false
      this.timeoutHandle = null
      this.stats = {
        aborted: false,
        loaded: 0,
        retry: 0,
        total: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: { start: 0, first: 0, end: 0 },
        parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 },
      }
      this.context = null
      this.callbacks = null
    }

    load(context, config, callbacks) {
      this.context = context
      this.callbacks = callbacks
      this.aborted = false
      this.stats.loading.start = performance.now()

      // Resolve URL relative to manifest base
      const baseUrl = capturedBaseUrl || context.url
      const url = resolveUrl(context.url, baseUrl)

      console.log('[HLS-Android] Loading:', hostOf(url), 'type:', context.type)

      const headers = {}
      if (context.rangeStart !== undefined && context.rangeEnd !== undefined) {
        headers.Range = `bytes=${context.rangeStart}-${context.rangeEnd}`
      }

      const isText = context.type === 'manifest' || context.type === 'level' || context.type === 'audioTrack' || context.type === 'subtitleTrack'

      // CapacitorHttp does not support AbortController, so use a client-side timeout
      const timeoutMs = this.config?.timeout || 30000
      this.timeoutHandle = setTimeout(() => {
        this.aborted = true
        console.error('[HLS-Android] Timeout:', hostOf(url))
        this.stats.loading.end = performance.now()
        this._reportError({ type: 'networkError', details: { code: 0, text: 'Request timeout' } }, url)
      }, timeoutMs)

      CapacitorHttp.request({
        method: 'GET',
        url,
        headers: { ...requestHeaders, ...headers },
        responseType: isText ? 'text' : 'arraybuffer',
        connectTimeout: Math.min(timeoutMs, 15000),
        readTimeout: timeoutMs,
      }).then(response => {
        this._clearTimeout()
        if (this.aborted) return

        this.stats.loading.end = performance.now()
        this.stats.loading.first = this.stats.loading.start

        if (response.status >= 400) {
          console.error('[HLS-Android] HTTP error:', response.status, hostOf(url))
          this._reportError({ type: 'networkError', details: { code: response.status, text: `HTTP ${response.status}` } }, url)
          return
        }

        let data = response.data || ''
        if (!isText && typeof data === 'string') {
          // CapacitorHttp returns base64-encoded data for arraybuffer responseType
          // Convert base64 to ArrayBuffer reliably
          try {
            const cleanBase64 = data.replace(/\s/g, '')
            const binaryString = atob(cleanBase64)
            const len = binaryString.length
            const bytes = new Uint8Array(len)
            for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i)
            data = bytes.buffer
          } catch (e) {
            console.error('[HLS-Android] base64 decode error:', e?.message, 'dataLen:', data.length, 'host:', hostOf(url))
            this._reportError({ type: 'networkError', details: { code: 0, text: 'base64 decode failed' } }, url)
            return
          }
        }

        if (!isText && !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
          console.error('[HLS-Android] Unexpected response type:', typeof data, hostOf(url))
          this._reportError({ type: 'networkError', details: { code: 0, text: 'unexpected response type' } }, url)
          return
        }

        const dataLen = data.byteLength || data.length || 0
        this.stats.loaded = dataLen
        this.stats.total = dataLen
        this.stats.chunkCount = 1

        // Update the context URL to the resolved URL so HLS.js can resolve relative URLs
        context.url = url

        console.log('[HLS-Android] OK:', response.status, 'len:', dataLen, 'type:', context.type)

        // Call onSuccess with the format HLS.js expects
        callbacks.onSuccess(
          { url, data },
          this.stats,
          context,
          response
        )
      }).catch(err => {
        this._clearTimeout()
        if (this.aborted) return
        console.error('[HLS-Android] Request error:', err?.message || err, hostOf(url))
        this.stats.loading.end = performance.now()
        this._reportError({ type: 'networkError', details: { code: 0, text: String(err?.message || err) } }, url)
      })
    }

    _clearTimeout() {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle)
        this.timeoutHandle = null
      }
    }

    _reportError(error, url) {
      if (!this.callbacks) return
      try {
        this.callbacks.onError(error, this.context, null, this.stats)
      } catch (e) {
        console.error('[HLS-Android] Error reporting failed:', e?.message, hostOf(url))
      }
    }

    abort() {
      this.aborted = true
      this._clearTimeout()
      this.stats.aborted = true
    }

    destroy() {
      this.aborted = true
      this._clearTimeout()
      this.stats.aborted = true
      this.callbacks = null
      this.context = null
    }
  }

  return CapacitorHlsLoader
}
