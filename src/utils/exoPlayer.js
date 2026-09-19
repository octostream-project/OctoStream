// ExoPlayer wrapper for Android - uses the @octostream/exo-player Capacitor plugin.
// Handles HLS, DASH, and Widevine DRM natively without CORS issues.

import { ExoPlayer } from '@octostream/exo-player'
import { isAndroidNative } from './platform.js'
import { sanitizeUrl } from './sanitizeUrl.js'

let stateListener = null
let zapListener = null
let episodeSelectListener = null

// The native Cast button delegates to the existing web Cast implementation.
let castRequestListener = null

// Listen for playback state events from native ExoPlayer
if (isAndroidNative()) {
  ExoPlayer.addListener('playbackState', (event) => {
    // 'position' llega cada 5s durante toda la reproducción — no loguearlo:
    // en Android cada console.log cruza el bridge a logcat (spam constante).
    if (event.state !== 'position') {
      console.log('[ExoPlayer] State:', event.state, event.message || '')
    }
    if (stateListener) stateListener(event)
  })
  ExoPlayer.addListener('channelZap', (event) => {
    if (zapListener) zapListener(event)
  })
  ExoPlayer.addListener('episodeSelected', (event) => {
    if (episodeSelectListener) episodeSelectListener(event)
  })
  ExoPlayer.addListener('castRequested', (event) => {
    console.info('[ExoPlayer] castRequested received', event?.title || '')
    if (castRequestListener) castRequestListener(event)
  })
}

/**
 * Play a stream using native ExoPlayer on Android.
 * @param {Object} options - Stream options
 * @param {string} options.url - Stream URL
 * @param {string} options.streamType - 'hls', 'dash', or 'mp4'
 * @param {string} options.licenseUrl - Widevine license URL (for DASH DRM)
 * @param {Object} options.headers - HTTP headers to send with requests
 * @param {Object} options.drmHeaders - HTTP headers for the license request
 * @param {string} options.title - Title to display
 * @param {Function} onStateChange - Callback for state changes
 * @returns {Promise<Object>} - Resolves when playback starts
 */
export function setCastRequestListener(listener) {
  castRequestListener = listener
  return () => {
    if (castRequestListener === listener) castRequestListener = null
  }
}

export async function playStream(options, onStateChange) {
  if (!isAndroidNative()) {
    throw new Error('ExoPlayer only available on Android native')
  }
  const url = sanitizeUrl(options.url)
  if (!url) throw new Error('URL de stream no válida')
  stateListener = onStateChange
  zapListener = options.onZap || null
  episodeSelectListener = options.onEpisodeSelect || null
  return ExoPlayer.play({
    url,
    streamType: options.streamType || 'hls',
    direct: options.direct === true,
    licenseUrl: options.licenseUrl || null,
    headers: options.headers || {},
    drmHeaders: options.drmHeaders || {},
    title: options.title || '',
    mode: options.mode || 'vod',
    startTime: options.startTime || 0,
    channels: options.channels || null,
    channelIndex: options.channelIndex ?? -1,
    epgNow: options.epgNow || null,
    epgNext: options.epgNext || null,
    epgStart: options.epgStart || 0,
    epgEnd: options.epgEnd || 0,
    logo: options.logo || '',
    imdbId: options.imdbId || '',
    season: options.season || 0,
    episode: options.episode || 0,
    subtitles: options.subtitles || null,
    episodes: options.episodes || null,
    episodeIndex: options.episodeIndex ?? -1,
    longBuffering: options.longBuffering === true,
    loadingText: options.loadingText || null,
  })
}

/**
 * Switch the native player to a new live channel without closing the dialog.
 * Called after a 'channelZap' event once JS has resolved the new stream.
 */
export async function switchChannel(options) {
  if (!isAndroidNative()) return
  const url = sanitizeUrl(options.url)
  if (!url) return
  return ExoPlayer.switchChannel({
    url,
    streamType: options.streamType || 'hls',
    direct: options.direct === true,
    headers: options.headers || {},
    title: options.title || '',
    channelIndex: options.channelIndex ?? -1,
    epgNow: options.epgNow || null,
    epgNext: options.epgNext || null,
    epgStart: options.epgStart || 0,
    epgEnd: options.epgEnd || 0,
  })
}

/**
 * Update the live channel list / EPG in the native player without reopening it.
 * Needed because channels may load asynchronously after playback starts
 * (e.g. Details → live route) and when the EPG catalog refreshes.
 */
export async function setChannels(options) {
  if (!isAndroidNative()) return
  return ExoPlayer.setChannels({
    channels: options.channels || null,
    channelIndex: options.channelIndex ?? -1,
  })
}

/**
 * Update the season episode list in the native player without reopening it.
 * Powers the "episodes" side panel (episode zapping for series).
 */
export async function setEpisodes(options) {
  if (!isAndroidNative()) return
  return ExoPlayer.setEpisodes({
    episodes: options.episodes || null,
    episodeIndex: options.episodeIndex ?? -1,
  })
}

/**
 * Update the native loading overlay text (e.g. live torrent progress pushed
 * from the TorrentEngine progress events).
 */
export async function setLoadingText(text) {
  if (!isAndroidNative()) return
  try { await ExoPlayer.setLoadingText({ text: text || '' }) } catch {}
}

export async function setNextEpisode(options) {
  if (!isAndroidNative()) return
  return ExoPlayer.setNextEpisode({
    title: options.title || '',
    seriesName: options.seriesName || '',
    season: options.season || 0,
    episode: options.episode || 0,
    poster: options.poster || '',
    autoPlay: options.autoPlay !== false,
  })
}

export async function pausePlayback() {
  if (!isAndroidNative()) return
  return ExoPlayer.pause()
}

export async function resumePlayback() {
  if (!isAndroidNative()) return
  return ExoPlayer.resume()
}

export async function stopPlayback() {
  if (!isAndroidNative()) return
  stateListener = null
  zapListener = null
  episodeSelectListener = null
  return ExoPlayer.stop()
}

export async function seekTo(positionSec) {
  if (!isAndroidNative()) return
  return ExoPlayer.seekTo({ position: positionSec })
}

export async function setPlaybackRate(rate) {
  if (!isAndroidNative()) return
  return ExoPlayer.setPlaybackRate({ rate })
}

export function isExoPlayerAvailable() {
  return isAndroidNative()
}

/**
 * Show an embed page in a visible native WebView on Android.
 * The user can interact with the page (solve captchas, click play).
 * When a direct video URL (.mp4/.m3u8) is detected, the WebView closes
 * and playback switches to ExoPlayer automatically.
 * @param {string} url - Embed URL to show
 * @param {string} title - Title for the player
 * @returns {Promise<{status: string, url?: string, streamType?: string}>}
 */
export async function playEmbed(url, title = '', referer = '', playback = false) {
  if (!isAndroidNative()) {
    throw new Error('ExoPlayer playEmbed only available on Android native')
  }
  const safeUrl = sanitizeUrl(url)
  if (!safeUrl) throw new Error('URL de embed no válida')
  const safeRef = referer ? sanitizeUrl(referer) : null
  return ExoPlayer.playEmbed({
    url: safeUrl,
    title,
    referer: safeRef || undefined,
    playback: playback === true,
  })
}

// Asigna el callback global de playbackState sin abrir el player — lo usa el
// flujo de embeds, donde ExoPlayer lo abre el propio nativo tras resolver.
export function setPlaybackStateListener(cb) {
  stateListener = cb || null
}

/**
 * Resolve an embed invisibly on Android (lightweight FlareSolverr-style).
 * A hidden WebView runs the provider's JS challenge (Cloudflare/captcha),
 * auto-plays the video and intercepts the direct media URL from network
 * requests. Falls back to 'failed' if the challenge needs user interaction.
 * @param {string} url - Embed URL to resolve
 * @param {number} [timeout] - Timeout in ms (min 5000, default 20000)
 * @returns {Promise<{status: 'resolved'|'failed'|'busy', url?: string, streamType?: string, referer?: string, cookies?: string}>}
 */
export async function resolveEmbed(url, timeout = 20000, referer = '') {
  if (!isAndroidNative()) return { status: 'failed' }
  const safeUrl = sanitizeUrl(url)
  if (!safeUrl) return { status: 'failed' }
  const safeRef = referer ? sanitizeUrl(referer) : null
  try {
    return await ExoPlayer.resolveEmbed({ url: safeUrl, timeout, referer: safeRef || undefined })
  } catch {
    return { status: 'failed' }
  }
}

/**
 * Reproduce en ExoPlayer una media URL resuelta de un embed cuyo CDN solo la
 * sirve al propio documento del proveedor (p.ej. tiestep/DLive). El nativo
 * levanta un relay local: un WebView oculto cargado en el origen del embed
 * hace los fetch() reales y los sirve a ExoPlayer vía http://127.0.0.1.
 * @param {string} url - Media URL resuelta (m3u8)
 * @param {string} referer - URL/origen del documento del embed
 * @param {string} title - Título para el player
 * @param {string} mode - 'live' | 'vod'
 * @returns {Promise<{status: 'playing'|'failed'}>}
 */
export async function playRelay(url, referer = '', title = '', mode = 'live') {
  if (!isAndroidNative()) return { status: 'failed' }
  const safeUrl = sanitizeUrl(url)
  if (!safeUrl) return { status: 'failed' }
  const safeRef = referer ? sanitizeUrl(referer) : null
  try {
    return await ExoPlayer.playRelay({ url: safeUrl, referer: safeRef || undefined, title, mode })
  } catch {
    return { status: 'failed' }
  }
}

/**
 * Abre la pantalla de "Proyección inalámbrica" de Android (Miracast).
 * No se puede conectar Miracast programáticamente — el sistema tiene una
 * pantalla propia donde el usuario elige el receptor.
 */
export async function openMiracast() {
  if (!isAndroidNative()) return null
  try {
    return await ExoPlayer.openMiracast()
  } catch {
    return null
  }
}

/**
 * Busca una TV DLNA en la red local y le envía la URL del stream.
 * Devuelve { sent, device } — sent=false si no se encontró ninguna TV.
 */
export async function openDlna(url, title) {
  if (!isAndroidNative() || !url) return { sent: false }
  try {
    return await ExoPlayer.openDlna({ url, title: title || 'OctoStream' })
  } catch {
    return { sent: false }
  }
}
