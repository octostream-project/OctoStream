// GnulaHD channel — mirror vivo de Gnula (ww3.gnulahd.nu).
// Movies and series in Spanish (Castilian, Latin, Vose).
//
// El dominio original (gnula.one) quedó detrás de reCAPTCHA — este clon
// mantiene el catálogo con un player propio:
//   - Ficha de película: `_gnrdPid` + `_gnrdTok` inline en el HTML.
//   - Ficha de serie: cada `a.gnrd-epc` lleva data-id/data-t/data-s/data-e.
//   - Player: GET /wp-json/gnrd/v1/player?id=PID&t=TOK → {p: base64 XOR}
//     gnrdUnpack: atob → XOR con [103,78,55,100] → JSON
//     {langs:[{label,servers:[{title,src}]}], dl:[{name,lang,qual,url}]}.

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { isAlldebridSupported } from '../../alldebrid.js'

const HOST = 'https://ww3.gnulahd.nu/'
const API = `${HOST}wp-json/gnrd/v1/player`

// gnrdUnpack del propio player: atob → XOR 4-byte key → JSON.
function gnrdUnpack(b64) {
  try {
    const bin = atob(b64)
    const k = [103, 78, 55, 100]
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ k[i & 3]
    return JSON.parse(new TextDecoder('utf-8').decode(bytes))
  } catch { return null }
}

// Tarjetas: "LAT"/"CAST"/"SUB" — player API: "Latino"/"Castellano"/"Subtitulado"
const LANG_LABEL = {
  lat: 'Lat', latino: 'Lat',
  cast: 'Esp', esp: 'Esp', castellano: 'Esp', español: 'Esp', espaniol: 'Esp',
  sub: 'VOSE', subtitulado: 'VOSE', subtitulada: 'VOSE', vose: 'VOSE',
}
const langFromLabel = (l) => LANG_LABEL[String(l || '').toLowerCase().trim()] || ''

const qualFromLabel = (q) => /4k|2160/i.test(q) ? '4K' : /1080|fullhd|hd-r|hdrip|bd/i.test(q) ? '1080P' : /720|hd/i.test(q) ? '720P' : /cam|ts|scr/i.test(q) ? 'CAM' : ''

export const gnulatv = {
  id: 'gnulatv',
  name: 'Gnula',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOST,

  catalogs: [
    { id: 'gnulatv-movies', name: 'Gnula: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'gnulatv-series', name: 'Gnula: Series', type: CONTENT_TYPES.SERIES },
  ],

  // Parsea las tarjetas `a.gnrd-card` (catálogo y búsqueda comparten markup).
  _parseCards(html, forcedType) {
    const items = []
    const seen = new Set()
    for (const m of findMultipleMatches(html, '<a class="gnrd-card" href="([^"]+)"[^>]*title="([^"]+)"')) {
      const itemUrl = m[1]
      if (!itemUrl || !itemUrl.includes('/ver/') || seen.has(itemUrl)) continue
      seen.add(itemUrl)
      items.push({
        id: `gnulatv:${itemUrl}`,
        // Las tarjetas no distinguen tipo — getMeta lo corrige por los episodios
        type: forcedType || CONTENT_TYPES.MOVIE,
        name: decodeEntities(m[2]).trim(),
        title: decodeEntities(m[2]).trim(),
        poster: null,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }
    // Pósters: el title va en el <a>, la <img> dentro — segunda pasada sobre
    // el bloque de cada tarjeta para no perderlos.
    for (const m of findMultipleMatches(html, '(<a class="gnrd-card" href="[^"]+"[\\s\\S]*?</a>)')) {
      const cardUrl = findSingleMatch(m[1], 'href="([^"]+)"')
      const item = items.find(it => it.url === cardUrl)
      if (!item || item.poster) continue
      const img = findSingleMatch(m[1], '<img[^>]*(?:data-src|src)="([^"]+)"')
      if (img) item.poster = absoluteUrl(img, HOST)
    }
    return items
  },

  async getCatalog({ id, skip = 0, top = 50 }) {
    const base = id === 'gnulatv-movies' ? `${HOST}ver/peliculas/`
      : id === 'gnulatv-series' ? `${HOST}ver/series/`
      : null
    if (!base) return []
    const type = id === 'gnulatv-series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE

    const page = Math.floor(skip / 50) + 1
    const html = await fetchHtml(`${base}?page=${page}`)
    if (!html) return []
    return this._parseCards(html, type).slice(0, top)
  },

  async getMeta({ id }) {
    const url = id.replace(/^gnulatv:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    const title = decodeEntities(
      findSingleMatch(html, 'gnrd-sr">([^<]+)')
      || (findSingleMatch(html, '<title>(.*?)</title>') || '').replace(/\s*\(\d{4}\).*$/, '').trim()
    ).trim()
    const poster = findSingleMatch(html, '<meta[^>]*property="og:image"[^>]*content="([^"]+)"')
    const description = decodeEntities(findSingleMatch(html, '<meta name="description" content="([^"]+)"'))
    const year = findSingleMatch(html, '(\\d{4})')

    // Episodios: a.gnrd-epc lleva pid+token propios → getStreams los usa directo
    const episodes = []
    for (const m of findMultipleMatches(html, '<a class="gnrd-epc" href="([^"]+)" data-id="(\\d+)" data-t="([^"]+)" data-s="(\\d+)" data-e="(\\d+)"[^>]*>([\\s\\S]*?)</a>')) {
      const [, epUrl, pid, tok, s, e, body] = m
      const epTitle = decodeEntities(findSingleMatch(body, 'gnrd-epc-title">([^<]+)') || '').trim()
      const overview = decodeEntities(findSingleMatch(body, 'gnrd-epc-ov">([^<]+)') || '').trim()
      const season = parseInt(s, 10)
      const episode = parseInt(e, 10)
      episodes.push({
        id: `gnulatv:ep:${pid}:${tok}`,
        name: epTitle || `S${season}E${episode}`,
        title: epTitle || `Episodio ${episode}`,
        overview,
        season,
        episode,
        url: epUrl,
      })
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)

    const isSeries = episodes.length > 0
    const meta = {
      id,
      type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: title || url,
      title: title || url,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      description: description || '',
      year: year ? parseInt(year, 10) : null,
      url,
      pluginId: 'plurtasko',
    }
    if (isSeries) meta.episodes = episodes
    return meta
  },

  // Player API: pid+token → streams de todos los idiomas + descargas debrid.
  async _playerStreams(pid, tok, referer, debridEnabled) {
    const res = await fetch(`${API}?id=${pid}&t=${encodeURIComponent(tok)}`, {
      headers: { 'Referer': referer },
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    }).catch(() => null)
    if (!res?.ok) return []
    const raw = await res.json().catch(() => null)
    const data = raw?.p ? gnrdUnpack(raw.p) : raw
    if (!data) return []

    const streams = []
    for (const lang of data.langs || []) {
      const l = langFromLabel(lang.label)
      for (const srv of lang.servers || []) {
        const src = srv.src
        if (!src || !/^https?:/i.test(src)) continue
        const server = this._detectServer(src)
        if (!server) continue
        streams.push({
          name: `${server}${l ? ` (${l})` : ''}`,
          url: src,
          streamType: normalizeServer(server),
          quality: '',
          server,
          lang: l,
          pluginName: 'Gnula',
          pluginId: 'plurtasko',
        })
      }
    }
    // Descargas (1fichier, megaup…) solo como enlaces debrid cuando hay key
    if (debridEnabled) {
      for (const d of data.dl || []) {
        const src = d.url
        if (!src || !/^https?:/i.test(src) || !isAlldebridSupported(src)) continue
        const l = langFromLabel(d.lang)
        const server = String(d.name || 'descarga').toLowerCase()
        streams.push({
          name: `${server}${l ? ` (${l})` : ''}`,
          url: src,
          streamType: 'embed',
          quality: qualFromLabel(d.qual),
          server,
          lang: l,
          pluginName: 'Gnula',
          pluginId: 'plurtasko',
        })
      }
    }
    return streams
  },

  async getStreams({ id, debridEnabled }) {
    // Episodio de serie: el id ya lleva pid+token
    const epMatch = id.match(/^gnulatv:ep:(\d+):(.+)$/)
    if (epMatch) return this._playerStreams(epMatch[1], epMatch[2], HOST, debridEnabled)

    const url = id.replace(/^gnulatv:/, '')
    const html = await fetchHtml(url)
    if (!html) return []

    const pid = findSingleMatch(html, '_gnrdPid=(\\d+)')
    const tok = findSingleMatch(html, '_gnrdTok="([^"]+)"')
    if (!pid || !tok) return []
    return this._playerStreams(pid, tok, url, debridEnabled)
  },

  _detectServer(url) {
    const u = url.toLowerCase()
    if (/vidara/.test(u)) return 'vidara'
    if (/byse|bysevepoin/.test(u)) return 'byse'
    if (/savefiles/.test(u)) return 'savefiles'
    if (/streamwish|streamsss|sbspeed|sbplay|watchsb|lvturbo/.test(u)) return 'streamwish'
    if (/filemoon|filelions|fmoon/.test(u)) return 'filemoon'
    if (/vidhide/.test(u)) return 'vidhide'
    if (/voe|voex/.test(u)) return 'voe'
    if (/fastream/.test(u)) return 'fastream'
    if (/streamtape/.test(u)) return 'streamtape'
    if (/doodstream|dood\./.test(u)) return 'doodstream'
    if (/upstream/.test(u)) return 'upstream'
    if (/mixdrop/.test(u)) return 'mixdrop'
    if (/uqload/.test(u)) return 'uqload'
    if (/mp4upload/.test(u)) return 'mp4upload'
    if (/yourupload/.test(u)) return 'yourupload'
    if (/ok\.ru|odnoklassniki/.test(u)) return 'okru'
    if (/kwik/.test(u)) return 'kwik'
    if (/vidmoly/.test(u)) return 'vidmoly'
    if (/vidoza/.test(u)) return 'vidoza'
    if (/supervideo/.test(u)) return 'supervideo'
    if (/lulustream/.test(u)) return 'lulustream'
    if (/sendvid/.test(u)) return 'sendvid'
    if (/turbovid/.test(u)) return 'turbovid'
    if (/\.mp4|\.mkv|\.m3u8/.test(u)) return 'directo'
    // Host desconocido: dominio como nombre para no perder el enlace
    try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0] } catch { return '' }
  },

  async search({ query, type }) {
    const html = await fetchHtml(`${HOST}?s=${encodeURIComponent(query)}`)
    if (!html) return []
    let items = this._parseCards(html)
    // Las tarjetas no marcan tipo: para filtrar por series/pelis hay que
    // abrir cada ficha y mirar si tiene episodios (paralelo, cap 8).
    if (!type || !items.length) return items
    const checked = await Promise.all(items.slice(0, 8).map(async it => {
      const meta = await this.getMeta({ id: it.id }).catch(() => null)
      return meta?.episodes?.length ? { ...it, type: CONTENT_TYPES.SERIES } : it
    }))
    // Verificados del tipo pedido + el resto sin verificar (getMeta corrige el
    // tipo al abrir la ficha — mejor mostrarlos que perder resultados).
    return checked.filter(it => it.type === type).concat(items.slice(8))
  },
}
