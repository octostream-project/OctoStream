// ExoPlayer wrapper for Android - uses the @octostream/exo-player Capacitor plugin.
// Handles HLS, DASH, and Widevine DRM natively without CORS issues.

import { ExoPlayer } from '@octostream/exo-player'
import { isAndroidNative, isElectron } from './platform.js'
import { sanitizeHttpUrl } from './sanitizeUrl.js'

let stateListener = null
let zapListener = null
let episodeSelectListener = null
let seasonSelectListener = null

// ─── Reproductor nativo de escritorio (mpv por IPC, electron/mpv.cjs) ───────
// Misma superficie que el plugin ExoPlayer: playStream/switchChannel/pause/
// seek/stop + eventos 'position'/'ended'/'closed'/'zap' sobre los mismos
// listeners — VideoPlayer no distingue Android de Electron-mpv.
let mpvActive = false
let mpvEmbedded = false // mpv incrustado con --wid dentro de la ventana
let mpvEventSub = null
function ensureMpvEvents() {
  if (mpvEventSub || !isElectron() || !window.octostream?.player?.onEvent) return
  mpvEventSub = window.octostream.player.onEvent((ev) => {
    if (ev?.state === 'zap') { zapListener?.(ev); return }
    if (ev?.state === 'closed') { mpvActive = false; mpvEmbedded = false }
    if (stateListener) stateListener(ev)
  })
}
const mpvApi = () => (isElectron() && mpvActive ? window.octostream?.player : null)

/** mpv embebido en la ventana de la app (controles OSC + input reenviado). */
export function isMpvEmbedded() { return mpvActive && mpvEmbedded }

/** Empuja estado/menú al OSC de mpv embebido. */
export function mpvOscState(obj) { mpvApi()?.oscState?.(obj) }
export function mpvOscMenu(obj) { mpvApi()?.oscMenu?.(obj) }
export function mpvPip(on) { return window.octostream?.pipWindow?.(on) }
export function mpvMouse(x, y) { mpvApi()?.mouse?.(x, y) }
export function mpvClick(x, y) { mpvApi()?.click?.(x, y) }
export function mpvKey(name) { mpvApi()?.key?.(name) }

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
  ExoPlayer.addListener('seasonSelected', (event) => {
    if (seasonSelectListener) seasonSelectListener(event)
  })
  ExoPlayer.addListener('castRequested', (event) => {
    console.info('[ExoPlayer] castRequested received', event?.title || '')
    if (castRequestListener) castRequestListener(event)
  })
} else if (isElectron() && window.octostream?.embed?.onState) {
  // Estados del player embebido en ventana propia (embed_webview_playing) —
  // mismo canal que el playbackState de Android para VideoPlayer.
  window.octostream.embed.onState((event) => {
    if (stateListener) stateListener(event)
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
    // Electron → mpv nativo (ventana propia controlada por IPC). Si la sesión
    // sigue viva (zap por re-render de LiveTV) se hace switch en vez de abrir.
    const p = isElectron() ? window.octostream?.player : null
    if (!p) throw new Error('ExoPlayer only available on Android native')
    const safeUrl = sanitizeHttpUrl(options.url)
    if (!safeUrl) throw new Error('URL de stream no válida')
    stateListener = onStateChange
    zapListener = options.onZap || null
    ensureMpvEvents()
    const arg = {
      url: safeUrl,
      headers: options.headers || {},
      title: options.title || '',
      startSec: options.startTime || 0,
      subtitles: options.subtitles || null,
      channels: options.channels || null,
      channelIndex: options.channelIndex ?? -1,
    }
    let r = mpvActive ? await p.switch(arg) : null
    if (r?.status !== 'playing') r = await p.open(arg)
    if (r?.status !== 'playing') {
      mpvActive = false
      mpvEmbedded = false
      throw new Error(r?.error || 'reproductor nativo no disponible')
    }
    mpvActive = true
    mpvEmbedded = r.embedded !== false // open/switch informan `embedded`
    return r
  }
  const url = sanitizeHttpUrl(options.url)
  if (!url) throw new Error('URL de stream no válida')
  stateListener = onStateChange
  zapListener = options.onZap || null
  episodeSelectListener = options.onEpisodeSelect || null
  seasonSelectListener = options.onSeasonSelect || null
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
    seasons: options.seasons || null,
    longBuffering: options.longBuffering === true,
    fastStart: options.fastStart === true,
    loadingText: options.loadingText || null,
  })
}

/**
 * Switch the native player to a new live channel without closing the dialog.
 * Called after a 'channelZap' event once JS has resolved the new stream.
 */
export async function switchChannel(options) {
  if (!isAndroidNative()) {
    const p = mpvApi()
    if (!p) return
    const url = sanitizeHttpUrl(options.url)
    if (!url) return
    return p.switch({
      url,
      headers: options.headers || {},
      title: options.title || '',
      channelIndex: options.channelIndex ?? -1,
    })
  }
  const url = sanitizeHttpUrl(options.url)
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
  if (!isAndroidNative()) {
    mpvApi()?.setChannels({
      channels: options.channels || null,
      channelIndex: options.channelIndex ?? -1,
    })
    return
  }
  return ExoPlayer.setChannels({
    channels: options.channels || null,
    channelIndex: options.channelIndex ?? -1,
  })
}

/**
 * Update the season episode list in the native player without reopening it.
 * Powers the "episodes" side panel (episode zapping for series) and answers
 * 'seasonSelected' — `season` tells the panel which chip the list belongs to.
 */
export async function setEpisodes(options) {
  if (!isAndroidNative()) return
  return ExoPlayer.setEpisodes({
    episodes: options.episodes || null,
    episodeIndex: options.episodeIndex ?? -1,
    season: options.season || 0,
  })
}

/**
 * Update the native loading overlay text (e.g. live torrent progress pushed
 * from the TorrentEngine progress events).
 */
export async function setLoadingText(text) {
  if (!isAndroidNative()) {
    // mpv: texto en pantalla (OSD) — el progreso del torrent se ve igual.
    if (text) mpvApi()?.showText(text)
    return
  }
  try { await ExoPlayer.setLoadingText({ text: text || '' }) } catch { /* noop */ }
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
  if (!isAndroidNative()) { mpvApi()?.pause(); return }
  return ExoPlayer.pause()
}

export async function resumePlayback() {
  if (!isAndroidNative()) { mpvApi()?.resume(); return }
  return ExoPlayer.resume()
}

export async function stopPlayback() {
  if (!isAndroidNative()) {
    // En Electron cierra las ventanas/relays de embed que quedaran abiertos
    // y la sesión mpv nativa si estaba activa.
    if (isElectron()) {
      stateListener = null
      window.octostream?.embed?.closeAll?.().catch?.(() => {})
      if (mpvActive) {
        mpvActive = false
        window.octostream?.player?.stop?.().catch?.(() => {})
      }
    }
    return
  }
  stateListener = null
  zapListener = null
  episodeSelectListener = null
  return ExoPlayer.stop()
}

/**
 * Abre un segundo ExoPlayer en mini-ventana flotante (PiP interno).
 * El mini conserva el audio; el player principal queda muteado mientras el
 * PiP esté activo. Tap/OK en el mini intercambia los contenidos.
 */
export async function playPip(options) {
  if (!isAndroidNative()) return { status: 'unsupported' }
  const url = sanitizeHttpUrl(options?.url)
  if (!url) return { status: 'failed' }
  try {
    return await ExoPlayer.playPip({
      url,
      streamType: options.streamType || 'hls',
      direct: options.direct === true,
      headers: options.headers || {},
      title: options.title || '',
    })
  } catch {
    return { status: 'failed' }
  }
}

/** Cierra el mini-player PiP y restaura el audio del principal. */
export async function stopPip() {
  if (!isAndroidNative()) return
  try { await ExoPlayer.stopPip() } catch { /* noop */ }
}

/** Indica si hay un mini-player PiP reproduciendo. */
export async function isPipActive() {
  if (!isAndroidNative()) return false
  try {
    const r = await ExoPlayer.isPipActive()
    return r?.active === true
  } catch {
    return false
  }
}

export async function seekTo(positionSec) {
  if (!isAndroidNative()) {
    if (Number.isFinite(positionSec)) mpvApi()?.seek(positionSec)
    return
  }
  return ExoPlayer.seekTo({ position: positionSec })
}

export async function setPlaybackRate(rate) {
  if (!isAndroidNative()) { mpvApi()?.setRate(rate); return }
  return ExoPlayer.setPlaybackRate({ rate })
}

export function isExoPlayerAvailable() {
  return isAndroidNative()
}

/**
 * ¿Hay reproductor nativo (mpv) usable en escritorio? Async porque la
 * detección del binario vive en el proceso principal. VideoPlayer la usa
 * para elegir entre mpv y el player web — con DRM Widevine siempre web.
 */
export async function isDesktopPlayerAvailable() {
  const p = isElectron() ? window.octostream?.player : null
  if (!p) return false
  try { return (await p.status())?.available === true } catch { return false }
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
export async function playEmbed(url, title = '', referer = '', playback = false, waitUntil = 0) {
  if (!isAndroidNative()) {
    // Electron: ventana BrowserWindow propia (electron/embed.cjs) — misma
    // superficie: playback:true reproduce dentro de la ventana hasta que el
    // usuario la cierra; playback:false resuelve al detectar el vídeo.
    if (isElectron() && window.octostream?.embed?.play) {
      const safeUrl = sanitizeHttpUrl(url)
      if (!safeUrl) throw new Error('URL de embed no válida')
      const safeRef = referer ? sanitizeHttpUrl(referer) : null
      return window.octostream.embed.play({
        url: safeUrl, title, referer: safeRef || undefined,
        playback: playback === true, waitUntil: waitUntil || 0,
      })
    }
    throw new Error('ExoPlayer playEmbed only available on Android native')
  }
  const safeUrl = sanitizeHttpUrl(url)
  if (!safeUrl) throw new Error('URL de embed no válida')
  const safeRef = referer ? sanitizeHttpUrl(referer) : null
  return ExoPlayer.playEmbed({
    url: safeUrl,
    title,
    referer: safeRef || undefined,
    playback: playback === true,
    waitUntil: waitUntil || 0,
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
  if (!isAndroidNative()) {
    // Electron: resolver headless con BrowserWindow oculta (electron/embed.cjs)
    // — ejecuta el challenge JS, auto-reproduce y captura la media URL por red.
    if (isElectron() && window.octostream?.embed?.resolve) {
      const safeUrl = sanitizeHttpUrl(url)
      if (!safeUrl) return { status: 'failed' }
      const safeRef = referer ? sanitizeHttpUrl(referer) : null
      try {
        return await window.octostream.embed.resolve({ url: safeUrl, timeout, referer: safeRef || undefined })
      } catch {
        return { status: 'failed' }
      }
    }
    return { status: 'failed' }
  }
  const safeUrl = sanitizeHttpUrl(url)
  if (!safeUrl) return { status: 'failed' }
  const safeRef = referer ? sanitizeHttpUrl(referer) : null
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
  if (!isAndroidNative()) {
    // Electron: relay de origen (electron/embed.cjs) — devuelve la URL
    // loopback /embed-relay que el player web reproduce directamente
    // (en Android la reproduce el propio ExoPlayer nativo).
    if (isElectron() && window.octostream?.embed?.relay) {
      const safeUrl = sanitizeHttpUrl(url)
      if (!safeUrl) return { status: 'failed' }
      const safeRef = referer ? sanitizeHttpUrl(referer) : null
      try {
        return await window.octostream.embed.relay({ url: safeUrl, referer: safeRef || undefined, mode })
      } catch {
        return { status: 'failed' }
      }
    }
    return { status: 'failed' }
  }
  const safeUrl = sanitizeHttpUrl(url)
  if (!safeUrl) return { status: 'failed' }
  const safeRef = referer ? sanitizeHttpUrl(referer) : null
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
  if (!url) return { sent: false }
  // Electron: SSDP + AVTransport en electron/dlna.cjs — misma superficie.
  if (isElectron()) {
    try {
      return await window.octostream?.cast?.dlna?.({ url, title: title || 'OctoStream' }) || { sent: false }
    } catch {
      return { sent: false }
    }
  }
  if (!isAndroidNative()) return { sent: false }
  try {
    return await ExoPlayer.openDlna({ url, title: title || 'OctoStream' })
  } catch {
    return { sent: false }
  }
}
