// AIOStreams channel — agregador de fuentes por IMDb ID.
//
// Dos modos soportados:
//
// A) URL de manifest (RECOMENDADO — funciona en instancias públicas como
//    aiostreams.elfhosted.com, sin contraseña). Es la URL que da el botón
//    "Copy manifest URL" de /stremio/configure:
//      {instancia}/stremio/<uuid>/<config>/manifest.json
//    Los streams van por el protocolo Stremio estándar:
//      GET {…}/stream/<movie|series>/<imdb[:s:e]>.json → {streams:[…]}
//
// B) Search API (misma que usa el addon POV de Kodi — solo instancias
//    self-hosted que la tengan activada; elfhosted la tiene desactivada):
//      GET {instancia}/api/v1/search?type=…&id=…  Basic auth uuid:password
//      data.results[]: {url, infoHash, parsedFile{…}, addon, seeders, size}
//
// Respuesta Stremio streams[]: {name, title|description, url, infoHash,
// fileIdx, sources[tracker:…], behaviorHints{proxyHeaders{request|response}}}

import { CONTENT_TYPES } from '../../../base.js'
import { safeFetchJson, withTimeout } from '../../../utils.js'
import { makeTorrentStream } from '../scraper.js'
import { detectLangFromText, extractQualityFromText } from '../meta.js'
import { withDefaultTrackers } from '../../../../utils/torrentFile.js'
import { inferStreamType } from '../../../../utils/streamType.js'
import { getItemSync } from '../../../../utils/storage.js'

const DEFAULT_INSTANCE = 'https://aiostreams.elfhosted.com'
const TIMEOUT_MS = 25000

export const AIO_KEYS = {
  instance: 'octostream_aiostreams_instance',
  uuid: 'octostream_aiostreams_uuid',
  password: 'octostream_aiostreams_password',
  manifest: 'octostream_aiostreams_manifest',
}

// Acepta la URL de manifest (…/manifest.json), la de configuración
// (…/configure) o la base (…/stremio/<uuid>/<config>) — devuelve la base
// de streams. Rechaza URLs que no llevan el segmento /stremio/.
export function manifestStreamBase(url) {
  const u = String(url || '').trim().replace(/\/+$/, '')
  if (!u) return ''
  const base = u.replace(/\/(manifest\.json|configure|stream)(\?.*)?$/i, '')
  return /\/stremio\//i.test(base) ? base : ''
}

export function aiostreamsConfig() {
  const instance = (getItemSync(AIO_KEYS.instance) || DEFAULT_INSTANCE).trim().replace(/\/+$/, '')
  const uuid = (getItemSync(AIO_KEYS.uuid) || '').trim()
  const password = getItemSync(AIO_KEYS.password) || ''
  const manifest = manifestStreamBase(getItemSync(AIO_KEYS.manifest))
  // El manifest tiene prioridad: no exige auth y funciona en instancias
  // públicas. La Search API queda como fallback para self-hosted.
  return { instance, uuid, password, manifest, enabled: Boolean(manifest || (uuid && password)) }
}

// Comprobador de conexión para Ajustes → Debrid → AIOStreams.
// Con manifest: GET …/stream/movie/tt0137523.json y cuenta streams.
// Con uuid+password: GET /api/v1/search (Fight Club, siempre indexada).
export async function testAiostreamsConnection({ instance, uuid, password, manifest } = {}) {
  const cfg = aiostreamsConfig()
  const man = manifestStreamBase(manifest ?? getItemSync(AIO_KEYS.manifest))
  const inst = ((instance ?? cfg.instance) || DEFAULT_INSTANCE).trim().replace(/\/+$/, '')
  const u = (uuid ?? cfg.uuid).trim()
  const p = password ?? cfg.password
  const { httpGetText } = await import('../../../../utils/httpClient.js')

  if (man) {
    try {
      // 1) El manifest declara qué recursos sirve la config — si no hay
      //    'stream', la URL no es de un addon de streams o está mal pegada.
      const manText = await withTimeout(httpGetText(`${man}/manifest.json`), TIMEOUT_MS, 'aiostreams timeout')
      // CapacitorHttp puede devolver el JSON ya parseado como objeto.
      let manJson = typeof manText === 'object' && manText !== null ? manText : null
      if (!manJson) {
        try { manJson = JSON.parse(manText) } catch { /* no-JSON */ }
      }
      if (!manJson) {
        // La petición respondió pero no trajo JSON: HTML de error del
        // proxy/WARP, página de Cloudflare o cuerpo cortado. No es un
        // problema de la URL — lo registramos para poder verlo en logcat.
        console.warn('[aiostreams] manifest no-JSON:', String(manText).slice(0, 120))
        return { ok: false, error: 'El manifest respondió algo que no es JSON (página de error o respuesta cortada) — si tienes VPN/WARP activa, prueba con ella apagada' }
      }
      if (!Array.isArray(manJson.resources)) {
        return { ok: false, error: 'La URL no es un manifest válido (debe acabar en /manifest.json)' }
      }
      const servesStreams = manJson.resources.some(r => (r.name || r) === 'stream')
      if (!servesStreams) {
        return { ok: false, error: 'Este manifest no sirve streams — revisa tu configuración en /stremio/configure' }
      }

      // 2) Sonda real con 2 títulos muy populares — si ambos dan 0 la
      //    config existe pero sus providers/filtros no devuelven nada.
      //    Un JSON cortado (proxy/WARP trunca respuestas grandes) NO debe
      //    contar como "0 fuentes": es un error de transporte.
      let results = 0
      for (const id of ['tt0137523', 'tt0468569']) {
        const text = await withTimeout(
          httpGetText(`${man}/stream/movie/${id}.json`),
          TIMEOUT_MS,
          'aiostreams timeout'
        )
        let json = typeof text === 'object' && text !== null ? text : null
        if (!json) {
          try { json = JSON.parse(text) } catch { /* cortado/no-JSON */ }
        }
        if (!json || !Array.isArray(json.streams)) {
          return { ok: false, error: 'La respuesta llegó incompleta o no es JSON — si tienes VPN/WARP activa, prueba con ella apagada' }
        }
        results += json.streams.length
      }
      const hint = results === 0
        ? ' — la conexión funciona pero tu config no devuelve fuentes; revisa providers activados y filtros en /stremio/configure'
        : ''
      return { ok: true, results, hint }
    } catch (e) {
      return { ok: false, error: diagError(e) }
    }
  }

  if (!/^https?:\/\//i.test(inst)) {
    return { ok: false, error: 'Instancia inválida: debe empezar por http(s)://' }
  }
  if (!u || !p) {
    return { ok: false, error: 'Falta la URL de manifest o el par UUID + contraseña' }
  }
  const url = `${inst}/api/v1/search?type=movie&id=tt0137523&requiredFields=parsedFile`
  try {
    const text = await withTimeout(
      httpGetText(url, { Authorization: `Basic ${btoa(`${u}:${p}`)}` }),
      TIMEOUT_MS,
      'aiostreams timeout'
    )
    let results = 0
    try {
      const json = JSON.parse(text)
      if (json?.success === false && /search api is disabled/i.test(String(json?.error))) {
        return { ok: false, error: 'La instancia tiene la Search API desactivada — usa la URL de manifest' }
      }
      results = json?.data?.results?.length ?? 0
    } catch { /* HTML/no-JSON */ }
    return { ok: true, results }
  } catch (e) {
    return { ok: false, error: diagError(e) }
  }
}

function diagError(e) {
  const msg = String(e?.message || e)
  if (/HTTP 401/.test(msg)) return 'UUID o contraseña incorrectos (401)'
  if (/HTTP 403/.test(msg)) return 'Acceso denegado (403) — la instancia puede tener la Search API desactivada'
  if (/HTTP 404/.test(msg)) return 'Endpoint no encontrado (404) — revisa la URL de manifest/instancia'
  if (/timeout|ETIMEDOUT/i.test(msg)) return 'La instancia no responde (timeout)'
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME/i.test(msg)) return 'Dominio de la instancia no resuelve'
  return `No se pudo conectar: ${msg}`
}

export const aiostreams = {
  id: 'aiostreams',
  name: 'AIOStreams',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: DEFAULT_INSTANCE,

  // Sin catálogo ni búsqueda por nombre: solo responde por IMDb ID.
  async getStreamsByImdb({ imdbId, type, season, episode, signal }) {
    const cfg = aiostreamsConfig()
    if (!imdbId || !cfg.enabled) return []
    const isSeries = type !== CONTENT_TYPES.MOVIE
    const stremioType = isSeries ? 'series' : 'movie'
    const id = isSeries ? `${imdbId}:${season || 1}:${episode || 1}` : imdbId

    if (cfg.manifest) {
      const endpoint = `${cfg.manifest}/stream/${stremioType}/${encodeURIComponent(id)}.json`
      // Las respuestas de AIOStreams son grandes (MBs con muchos addons) —
      // por WARP/proxy pueden llegar truncadas, así que un null reintenta
      // una vez antes de rendirse.
      let data = await withTimeout(
        safeFetchJson(endpoint, {}, signal),
        TIMEOUT_MS,
        'aiostreams timeout'
      )
      if (!data && !signal?.aborted) {
        data = await withTimeout(
          safeFetchJson(endpoint, {}, signal),
          TIMEOUT_MS,
          'aiostreams timeout'
        )
      }
      if (!data) console.warn(`[aiostreams] stream fetch failed or truncated for ${id}`)
      const list = Array.isArray(data?.streams) ? data.streams : []
      const mapped = list.map(stremioToStream)
      _processingCount = mapped.filter(s => s && s.processing).length
      return mapped.filter(Boolean)
    }

    const url = `${cfg.instance}/api/v1/search?type=${stremioType}&id=${encodeURIComponent(id)}&requiredFields=parsedFile`
    const headers = { Authorization: `Basic ${btoa(`${cfg.uuid}:${cfg.password}`)}` }
    const data = await withTimeout(
      safeFetchJson(url, headers, signal),
      TIMEOUT_MS,
      'aiostreams timeout'
    )
    const list = Array.isArray(data?.data?.results) ? data.data.results : []
    const mapped = list.map(searchToStream)
    _processingCount = mapped.filter(s => s && s.processing).length
    return mapped.filter(Boolean)
  },
}

// Nº de fuentes aún procesándose en el último fetch — index.js lo usa
// para saber si la ficha debe re-pedir la lista aunque esté vacía.
let _processingCount = 0
export function aioProcessingCount() { return _processingCount }

// ── Respuesta protocolo Stremio ────────────────────────────────────────────
// streams[]: {name, title|description, url?, infoHash?, fileIdx?,
//             sources["tracker:…"|"dht:…"], behaviorHints{proxyHeaders}}
// Extrae de la descripción formateada de AIOStreams los datos que la UI
// necesita: caché del debrid ("⚡Ready (AD)" / "⏳Not Ready (AD)"), addon
// origen (🔍), indexador (📡) y tamaño (📦).
function parseAioDescription(desc) {
  const t = String(desc || '')
  const cached = /not ready|⏳|downloading/i.test(t) ? false
    : /ready|cached|⚡/i.test(t) ? true : undefined
  const addon = (t.match(/🔍\s*([^\n]+)/)?.[1] || '').trim()
  const indexer = (t.match(/📡\s*([^\n]+)/)?.[1] || '').trim()
  const size = (t.match(/📦\s*([\d.,]+\s*[GMTK]i?B)/i)?.[1] || '').trim()
  return { cached, addon, indexer, size }
}

// Idioma del archivo real: primero el filename de behaviorHints (lleva los
// códigos del release, "…ESP.LATINO…"), luego el bingeGroup (nombres en
// inglés: "Spanish", "English"…) y por último la descripción.
function detectAioLang(s) {
  const filename = s.behaviorHints?.filename || ''
  const binge = String(s.behaviorHints?.bingeGroup || '').split('|').slice(1).join(' ')
  const desc = String(s.description || s.title || '')
  // Un archivo con pistas ESP+LATINO no es "Esp" puro: es multi-audio.
  if (/\b(esp|cast|spanish)\b/i.test(`${filename} ${binge}`) && /\b(lat|latino)\b/i.test(`${filename} ${binge}`)) return 'Dual'
  return detectLangFromText(filename) || detectLangFromText(binge) || detectLangFromText(desc)
}

function stremioToStream(s) {
  const name = String(s.name || 'AIOStreams')
  const label = String(s.title || s.description || '').split('\n')[0].trim()
  const info = `${name} ${label}`
  const meta = parseAioDescription(s.description)
  const lang = detectAioLang(s)
  const quality = extractQualityFromText(info) || 'HD'
  const headers = s.behaviorHints?.proxyHeaders?.request
    || s.behaviorHints?.proxyHeaders?.response
    || undefined
  // "🚀 FHD" como server no dice nada; mejor el addon/indexador real.
  const serverLabel = [meta.indexer, meta.addon].filter(Boolean).join(' · ') || name
  // Título del release real: behaviorHints.filename lleva el nombre del
  // archivo/torrent ("Movie.Name.1080p.BluRay.x264-GRP"). Eso es lo que el
  // usuario quiere ver como nombre del stream — el origen (PirateBay…)
  // queda como info secundaria en `server`.
  const release = String(s.behaviorHints?.filename || '').trim() || label

  // Magnet/URL calculados antes del check de caché: la entrada
  // "descargando" también los necesita — pulsarla lanza la descarga.
  const hash = (s.infoHash || '').toLowerCase()
  const validHash = /^[0-9a-f]{32,40}$/.test(hash)
  let magnet = ''
  if (hash && validHash) {
    magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(release || name)}`
    for (const src of s.sources || []) {
      const tr = String(src).replace(/^tracker:/, '')
      if (/^https?:|^udp:/.test(tr)) magnet += `&tr=${encodeURIComponent(tr)}`
    }
    if (s.fileIdx != null) magnet += `&so=${s.fileIdx}`
  }
  const pageUrl = String(s.url || s.externalUrl || '')
  const okUrl = /^https?:/i.test(pageUrl) ? pageUrl : ''

  // No cacheado ("⏳ Not Ready"): el debrid aún lo está descargando — no
  // es reproducible pero se muestra atenuado con su título, y pulsarlo
  // envía el magnet a AllDebrid (o pide la URL de la instancia, que es lo
  // que dispara el procesamiento) para "ponerlo a descargar". Cuando el
  // debrid termine reaparece ya cacheado en el siguiente re-poll.
  if (meta.cached === false) {
    return {
      processing: true,
      name: `${release || serverLabel}${lang ? ` (${lang})` : ''} ${quality}`,
      server: serverLabel,
      lang,
      quality,
      title: release,
      releaseTitle: release || undefined,
      size: meta.size || undefined,
      _magnet: magnet || undefined,
      _triggerUrl: okUrl || undefined,
      pluginName: 'AIOStreams',
      channelName: 'AIOStreams',
      pluginId: 'plurtasko',
    }
  }

  if (hash) {
    if (!validHash) return null
    const stream = makeTorrentStream(serverLabel, withDefaultTrackers(magnet), quality, release)
    stream.name = `${release || serverLabel}${lang ? ` (${lang})` : ''} ${quality}`
    stream.lang = lang
    stream.title = release
    stream.releaseTitle = release || undefined
    stream.headers = headers
    stream.cached = meta.cached
    stream.size = meta.size || undefined
    stream.pluginName = 'AIOStreams'
    stream.channelName = 'AIOStreams'
    return stream
  }

  if (!okUrl) return null
  return {
    name: `${release || serverLabel}${lang ? ` (${lang})` : ''} ${quality}`,
    url: okUrl,
    streamType: inferStreamType(okUrl, 'mp4'),
    quality,
    server: serverLabel,
    lang,
    title: release,
    releaseTitle: release || undefined,
    headers,
    size: meta.size || undefined,
    cached: meta.cached ?? (Boolean(s.behaviorHints?.cached) || undefined),
    pluginName: 'AIOStreams',
    channelName: 'AIOStreams',
    pluginId: 'plurtasko',
  }
}

// ── Respuesta Search API (self-hosted) ─────────────────────────────────────
function searchToStream(item) {
  const parsed = item.parsedFile || {}
  const release = item.filename || item.folderName || ''
  const service = (item.service || 'direct').toLowerCase()
  const addon = item.addon || item.indexer || 'AIOStreams'
  const label = service !== 'direct' ? `${service} · ${addon}` : addon
  const seeders = Number(item.seeders) || 0
  const bytes = Number(item.size) || 0
  const sizeLabel = bytes >= 1073741824
    ? `${(bytes / 1073741824).toFixed(1)} GB`
    : bytes > 0 ? `${Math.max(1, Math.round(bytes / 1048576))} MB` : ''
  const quality = extractQualityFromText(
    `${parsed.resolution || ''} ${parsed.quality || ''} ${release}`
  ) || 'HD'
  const lang = detectLangFromText(
    `${(parsed.languages || []).join(' ')} ${release}`
  )
  // Igual que en stremioToStream: "not ready" se muestra atenuado con su
  // título hasta que el debrid termine — pulsarla sube el magnet a
  // AllDebrid para ponerla a descargar.
  if (item.cached === false) {
    const h = (item.infoHash || '').toLowerCase()
    return {
      processing: true,
      name: `${release || label}${lang ? ` (${lang})` : ''} ${quality}${sizeLabel ? ` ${sizeLabel}` : ''}`,
      server: label,
      lang,
      quality,
      title: release,
      releaseTitle: release || undefined,
      size: sizeLabel || undefined,
      _magnet: /^[0-9a-f]{32,40}$/.test(h)
        ? `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(release || label)}`
        : undefined,
      pluginName: 'AIOStreams',
      channelName: 'AIOStreams',
      pluginId: 'plurtasko',
    }
  }

  // P2P: OctoStream sí reproduce torrents locales (POV los descartaba porque
  // Kodi solo juega debrid) — magnet por infoHash con trackers por defecto.
  const hash = (item.infoHash || '').toLowerCase()
  if (item.type === 'p2p' || (!item.url && hash)) {
    if (!/^[0-9a-f]{40}$/.test(hash)) return null
    const magnet = withDefaultTrackers(
      `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(release || addon)}`
    )
    const stream = makeTorrentStream(label, magnet, quality, release)
    stream.name = `${release || label}${lang ? ` (${lang})` : ''} ${quality}${seeders ? ` 👤${seeders}` : ''}${sizeLabel ? ` ${sizeLabel}` : ''}`
    stream.lang = lang
    stream.title = release
    stream.releaseTitle = release || undefined
    stream.seeds = seeders
    stream.seasonPack = Boolean(parsed.seasonPack) || undefined
    stream.pluginName = 'AIOStreams'
    stream.channelName = 'AIOStreams'
    return stream
  }

  // debrid/http: URL directa ya desbloqueada por la instancia.
  const url = String(item.url || '')
  if (!/^https?:/i.test(url)) return null
  return {
    name: `${release || label}${lang ? ` (${lang})` : ''} ${quality}${sizeLabel ? ` ${sizeLabel}` : ''}`,
    url,
    streamType: inferStreamType(url, 'mp4'),
    quality,
    server: label,
    lang,
    title: release,
    releaseTitle: release || undefined,
    headers: item.type === 'http' && item.requestHeaders ? item.requestHeaders : undefined,
    viaDebrid: service !== 'direct',
    cached: Boolean(item.cached) || undefined,
    pluginName: 'AIOStreams',
    channelName: 'AIOStreams',
    pluginId: 'plurtasko',
  }
}
