import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'
import { getItemSync } from '../../utils/storage.js'

const TDT_URL = 'https://www.tdtspain.com/canales/canalesv2.json'
const EPG_URL = 'https://www.tdtspain.com/epg/TV.json.gz'
const U7D_URL = 'https://www.tdtspain.com/u7d/u7dv1.json'

function applyProxy(url) {
  const proxy = (getItemSync('octo_tdt_proxy') || '').trim()
  if (!proxy) return url
  if (!proxy.includes('{url}')) return url
  return proxy.replace('{url}', encodeURIComponent(url))
}

let cachedChannels = null
let cacheTime = 0
const CACHE_TTL = 30 * 60 * 1000

let cachedEpg = null
let cachedEpgDate = null
let cachedEpgRaw = null
let cachedEpgRawTime = 0
const EPG_CACHE_TTL = 60 * 60 * 1000

let cachedU7dConfig = null
let cachedU7dConfigTime = 0
const U7D_CONFIG_CACHE_TTL = 60 * 60 * 1000
const u7dItemCache = new Map()

function slugify(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function slugifyCatalog(name) {
  return 'tdt-' + slugify(name)
}

function parseXmltvDate(str) {
  if (!str) return null
  const m = str.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`)
}

// Helper: fetch via IPC en Electron (sin CORS), fallback a fetch normal en web
async function smartFetch(url, options = {}) {
  if (typeof window !== 'undefined' && window.octo?.octoFetch) {
    const result = await window.octo.octoFetch(url, options)
    if (result.error) throw new Error(result.error)
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.json,
      text: async () => result.text,
    }
  }
  // Fallback para web
  const res = await fetch(url, options)
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json(),
    text: () => res.text(),
  }
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// callSign de Mediaset por nombre de canal (extraído de u7dv1.json de tdtspain.com)
const MEDIASET_CALLSIGNS = {
  telecinco: 'T5',
  cuatro: 'CT',
  fdf: 'FD',
  energy: 'EN',
  divinity: 'DV',
  boing: 'BO',
  bemad: 'BM',
}

// Resolver stream de Atresplayer (stream11)
// Flujo real de atresplayer.com (2 pasos):
// 1. client/v1/url?href=<path> -> devuelve href a client/v1/page/live/<id>
// 2. player/v1/live/<id> -> devuelve sourcesLive (directo) y sourcesStartOver (catch-up)
async function resolveAtresplayer(channelUrl) {
  try {
    const path = new URL(channelUrl).pathname
    const urlRes = await smartFetch(`https://api.atresplayer.com/client/v1/url?href=${encodeURIComponent(path)}`, {
      headers: { 'Origin': 'https://www.atresplayer.com', 'Referer': channelUrl, 'User-Agent': UA },
    })
    if (!urlRes.ok) throw new Error(`URL resolve HTTP ${urlRes.status}`)
    const urlData = await urlRes.json()
    const pageHref = urlData.href || ''
    const idMatch = pageHref.match(/\/live\/([a-f0-9]+)$/)
    if (!idMatch) throw new Error('No se pudo extraer el ID del canal')
    const channelId = idMatch[1]

    const playerRes = await smartFetch(`https://api.atresplayer.com/player/v1/live/${channelId}`, {
      headers: { 'Origin': 'https://www.atresplayer.com', 'Referer': channelUrl, 'User-Agent': UA },
    })
    if (!playerRes.ok) throw new Error(`Player HTTP ${playerRes.status}`)
    const playerData = await playerRes.json()

    // Preferir hls+ssai (server-side ad insertion, sin marcadores SCTE-35 que confunden a HLS.js
    // y provocan repeticiones/cortes en la reproducción). Fallback al HLS estándar si no existe.
    const ssaiHls = (playerData.sourcesLive || []).find(s => s.type === 'application/hls+ssai')
    const liveHls = (playerData.sourcesLive || []).find(s => s.type === 'application/vnd.apple.mpegurl')
    const streamUrl = ssaiHls?.src || liveHls?.src || playerData.sourcesLive?.[0]?.src
    if (!streamUrl) {
      console.warn('[TDT] Atresplayer: no live source found', playerData)
      return null
    }

    // sourcesStartOver permite reproducir desde un momento anterior (catch-up)
    const startOverHls = (playerData.sourcesStartOver || []).find(s => s.type === 'application/vnd.apple.mpegurl')

    return {
      liveUrl: streamUrl,
      startOverUrl: startOverHls?.src || null,
      hasStartOver: !!startOverHls,
    }
  } catch (e) {
    console.error('[TDT] Atresplayer resolve error', e)
    return null
  }
}

// Resolver stream de Mediaset (stream10)
// Flujo real de mediasetinfinity.es (3 pasos):
// 1. idm/v3.0/anonymous/login con client_id aleatorio -> beToken
// 2. playback/v3.0/check con streamType=LIVE y channelCode=<callSign> -> mediaSelector.url
// 3. Fetch del mediaSelector (SMIL) con auth=beToken -> parsear <ref src="...">
async function resolveMediaset(channelUrl) {
  try {
    const channelMatch = channelUrl.match(/\/directo\/([^/]+)/)
    const channelName = (channelMatch ? channelMatch[1] : '').toLowerCase()
    const callSign = MEDIASET_CALLSIGNS[channelName]
    if (!callSign) {
      console.warn('[TDT] Mediaset: callSign desconocido para', channelName)
      return null
    }

    const deviceId = 'octostream-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    const loginRes = await smartFetch('https://services-ott-prod-fe.mediaset.net/esp/idm/v3.0/anonymous/login', {
      method: 'POST',
      headers: { 'Origin': 'https://www.mediasetinfinity.es', 'Referer': 'https://www.mediasetinfinity.es/', 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ client_id: deviceId, appName: 'web//mediasetplay-web/1.2.1-d1b2024' }),
    })
    if (!loginRes.ok) throw new Error(`Login HTTP ${loginRes.status}`)
    const loginData = await loginRes.json()
    const beToken = loginData.response?.beToken
    if (!beToken) throw new Error('Login sin beToken')

    const checkRes = await smartFetch('https://services-ott-prod-fe.mediaset.net/esp/playback/v3.0/check', {
      method: 'POST',
      headers: {
        'Origin': 'https://www.mediasetinfinity.es',
        'Referer': 'https://www.mediasetinfinity.es/',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${beToken}`,
        'User-Agent': UA,
      },
      body: JSON.stringify({ assetType: 'live', streamType: 'LIVE', channelCode: callSign }),
    })
    if (!checkRes.ok) throw new Error(`Check HTTP ${checkRes.status}`)
    const checkData = await checkRes.json()
    const selectorUrl = checkData.response?.mediaSelector?.url
    if (!selectorUrl) {
      console.warn('[TDT] Mediaset: sin mediaSelector', checkData)
      return null
    }

    const smilRes = await smartFetch(`${selectorUrl}?format=SMIL&formats=M3U&balance=true&auto=true&tracking=true&delivery=Streaming&targetPlatform=browser&auth=${encodeURIComponent(beToken)}`, {
      headers: { 'Origin': 'https://www.mediasetinfinity.es', 'Referer': 'https://www.mediasetinfinity.es/', 'User-Agent': UA },
    })
    if (!smilRes.ok) throw new Error(`SMIL HTTP ${smilRes.status}`)
    const smilText = await smilRes.text()

    // Parsear el SMIL buscando el primer <ref> sin isException=true
    const refMatches = [...smilText.matchAll(/<ref\s+src="([^"]+)"[^>]*>([\s\S]*?)<\/ref>|<ref\s+src="([^"]+)"\s*\/>/g)]
    for (const m of refMatches) {
      const src = m[1] || m[3]
      const body = m[2] || ''
      if (src && !body.includes('isException') && !src.includes('cortesia') && !src.includes('errorFiles')) {
        return { liveUrl: src, startOverUrl: null, hasStartOver: false }
      }
    }
    console.warn('[TDT] Mediaset: SMIL sin stream válido (posible geo-bloqueo)', smilText.slice(0, 300))
    return null
  } catch (e) {
    console.error('[TDT] Mediaset resolve error', e)
    return null
  }
}

function extractYoutubeId(url) {
  const patterns = [
    /v=([a-zA-Z0-9_-]{11})/,
    /\/live\/([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m && m[1]) return m[1]
  }
  return null
}

async function loadChannels() {
  if (cachedChannels && Date.now() - cacheTime < CACHE_TTL) {
    return cachedChannels
  }
  const res = await smartFetch(TDT_URL, {
    headers: { 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()

  const channels = []
  const channelList = data.canales || []

  for (const ch of channelList) {
    if (ch.ocultar === '1') continue
    const id = `tdt-${slugify(ch.id || ch.name)}`
    const group = (ch.group || 'Nacionales').split(';')[0]
    const streamType = ch.streamtype || ''
    const url = ch.url || ''
    const logo = ch.logo || ch.logocolor || ''

    let resolvedStreamType = 'hls'
    let format = 'm3u8'

    if (streamType === 'stream11') {
      resolvedStreamType = 'atresplayer'
      format = 'atresplayer'
    } else if (streamType === 'stream10') {
      resolvedStreamType = 'mediaset'
      format = 'mediaset'
    } else if (streamType === 'youtube') {
      const ytId = extractYoutubeId(url)
      resolvedStreamType = 'iframe'
      format = 'youtube'
      if (ytId) {
        // URL ya resuelta a embed de YouTube
      }
    } else if (url.includes('.m3u8')) {
      resolvedStreamType = 'hls'
      format = 'm3u8'
    } else if (url.includes('.mpd')) {
      resolvedStreamType = 'dash'
      format = 'mpd'
    } else {
      resolvedStreamType = 'hls'
      format = 'm3u8'
    }

    channels.push({
      id,
      name: ch.name,
      type: CONTENT_TYPES.CHANNEL,
      poster: logo,
      logo,
      description: `Canal TDT - ${group} (Spain)`,
      ambit: group,
      country: 'Spain',
      epgId: ch.epgid || ch.id || '',
      streamType: resolvedStreamType,
      streamUrl: url,
      format,
      headers: ch.headers || {},
    })
  }

  cachedChannels = channels
  cacheTime = Date.now()
  const mediasetCount = channels.filter(ch => ch.streamType === 'mediaset').length
  console.log('[TDT] Loaded channels:', channels.length, 'Mediaset:', mediasetCount)
  return channels
}

// Cargar EPG raw (sin filtrar por día)
async function loadEpgRaw() {
  if (cachedEpgRaw && Date.now() - cachedEpgRawTime < EPG_CACHE_TTL) {
    return cachedEpgRaw
  }
  try {
    const res = await smartFetch(EPG_URL, {
      headers: { 'User-Agent': UA },
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const text = await res.text()
    let jsonText = text
    if (text.charCodeAt(0) === 0x1f && text.charCodeAt(1) === 0x8b) {
      try {
        const ds = new DecompressionStream('gzip')
        const decompressed = new Response(new Blob([text]).stream().pipeThrough(ds))
        jsonText = await decompressed.text()
      } catch {}
    }
    const data = JSON.parse(jsonText)
    cachedEpgRaw = data
    cachedEpgRawTime = Date.now()
    return data
  } catch (e) {
    console.error('[TDT] loadEpgRaw error', e)
    return null
  }
}

// Obtener programas EPG de un canal para los últimos N días
async function getEpgProgramsForU7d(channelId, daysBack = 7) {
  const epgData = await loadEpgRaw()
  if (!epgData) return []
  const channels = await loadChannels()
  const ch = channels.find(c => c.id === channelId)
  if (!ch || !ch.epgId) return []
  const epgId = ch.epgId
  const epgIdLower = epgId.toLowerCase()
  const chEpg = epgData.find(c => (c.name || '') === epgId || (c.name || '').toLowerCase() === epgIdLower)
  if (!chEpg) return []

  const now = Date.now()
  const past = now - daysBack * 24 * 3600 * 1000
  const programs = []
  for (const ev of chEpg.events || []) {
    const startMs = ev.hi * 1000
    if (startMs < past || startMs > now) continue
    const start = new Date(startMs)
    const end = new Date(ev.hf * 1000)
    programs.push({
      id: 'u7d-epg-' + ch.id + '-' + ev.hi,
      title: ev.t || 'Sin título',
      description: ev.d || '',
      startTimestamp: ev.hi,
      startTime: ev.hi,
      endTimestamp: ev.hf,
      poster: ev.c || ev.ch || ch.logo,
      logo: ch.logo,
      channelId: ch.id,
      channelName: ch.name,
      epgOnly: true,
      streamType: 'epg-info',
    })
  }
  return programs.sort((a, b) => (b.startTimestamp || 0) - (a.startTimestamp || 0))
}

const AMBIT_PRIORITY = [
  'Nacionales',
  'Informativos',
  'Deportes',
  'Infantiles',
  'Entretenimiento',
  'Cine',
  'Series',
  'Comunidades',
  'Internacionales',
  'Autonómicos',
]

async function getCatalogs() {
  const channels = await loadChannels()
  const ambits = new Map()
  for (const ch of channels) {
    if (!ambits.has(ch.ambit)) ambits.set(ch.ambit, new Set())
    ambits.get(ch.ambit).add(ch.id)
  }
  const allAmbits = Array.from(ambits.keys())
  const sortedAmbits = allAmbits.sort((a, b) => {
    const ia = AMBIT_PRIORITY.indexOf(a)
    const ib = AMBIT_PRIORITY.indexOf(b)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return a.localeCompare(b)
  })
  return sortedAmbits.map(ambit => ({
    id: slugifyCatalog(ambit),
    name: ambit,
    type: CONTENT_TYPES.CHANNEL,
    ambit,
  }))
}

// === U7D (Últimos 7 días) ===

// Cargar configuración u7d desde tdtspain.com
async function loadU7dConfig() {
  if (cachedU7dConfig && Date.now() - cachedU7dConfigTime < U7D_CONFIG_CACHE_TTL) {
    return cachedU7dConfig
  }
  try {
    const res = await smartFetch(U7D_URL, {
      headers: { 'User-Agent': UA },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    cachedU7dConfig = data
    cachedU7dConfigTime = Date.now()
    return data
  } catch (e) {
    console.error('[TDT] U7D config error', e)
    return null
  }
}

// Obtener catálogos u7d (canales con contenido de 7 días)
async function getU7dCatalogs() {
  const config = await loadU7dConfig()
  if (!config) return []

  const u7dConf = config.U7dConf || {}
  const channels = await loadChannels()

  // Cargar EPG para verificar qué canales tienen programación
  const epgData = await loadEpgRaw()
  const epgChannelNames = new Set()
  if (epgData) {
    for (const ch of epgData) {
      if (ch.name) epgChannelNames.add(ch.name)
    }
  }

  const catalogs = []
  for (const [epgName, conf] of Object.entries(u7dConf)) {
    const u7dtype = conf.u7dtype || ''
    // Soportamos: stream11 (Atresplayer, HLS sin DRM), stream1 (RTVE, iframe), stream10 (Mediaset, iframe)
    if (!['stream11', 'stream1', 'stream10'].includes(u7dtype)) continue

    const channel = channels.find(ch => ch.epgId === epgName)
    if (!channel) continue

    // Saltar canales sin EPG
    if (epgChannelNames.size > 0 && !epgChannelNames.has(epgName)) continue

    const isNational = (channel.ambit || '').toLowerCase() === 'nacionales'
    catalogs.push({
      id: `u7d-${slugify(channel.name)}`,
      name: `${channel.name} - 7 días`,
      type: CONTENT_TYPES.LIVE,
      channelId: channel.id,
      channelName: channel.name,
      channelLogo: channel.logo,
      channelAmbit: channel.ambit || '',
      u7dType: u7dtype,
      u7dData: conf.u7ddata || '',
      u7dCallSign: conf.idchannel || '',
      isNational,
    })
  }

  // Ordenar: canales nacionales primero, luego alfabéticamente por nombre
  catalogs.sort((a, b) => {
    if (a.isNational && !b.isNational) return -1
    if (!a.isNational && b.isNational) return 1
    return a.channelName.localeCompare(b.channelName)
  })

  console.log('[TDT] U7D catalogs:', catalogs.length, catalogs.map(c => c.name).join(', '))
  return catalogs
}

// Parsear fecha RTVE YYYYMMDDHHMMSS a timestamp
function parseRteDate(bt) {
  if (!bt || bt.length < 14) return 0
  const y = parseInt(bt.slice(0, 4), 10)
  const mo = parseInt(bt.slice(4, 6), 10) - 1
  const d = parseInt(bt.slice(6, 8), 10)
  const h = parseInt(bt.slice(8, 10), 10)
  const mi = parseInt(bt.slice(10, 12), 10)
  const s = parseInt(bt.slice(12, 14), 10)
  return Math.floor(new Date(y, mo, d, h, mi, s).getTime() / 1000)
}

// Formatear timestamp a hora legible
function formatEmissionTime(ts) {
  if (!ts) return ''
  const d = new Date(typeof ts === 'number' ? ts * 1000 : ts)
  if (isNaN(d.getTime())) return ''
  const day = d.getDate().toString().padStart(2, '0')
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const hours = d.getHours().toString().padStart(2, '0')
  const mins = d.getMinutes().toString().padStart(2, '0')
  return day + '/' + month + ' ' + hours + ':' + mins
}

// Construir URL completa de imagen Atresplayer (base path + /default.jpg)
function buildAtresplayerImageUrl(imageObj) {
  if (!imageObj) return ''
  const basePath = imageObj.pathHorizontal || imageObj.pathVertical || imageObj.images?.HORIZONTAL?.path || imageObj.images?.VERTICAL?.path || ''
  if (!basePath) return ''
  return basePath.endsWith('/') ? basePath + 'default.jpg' : basePath + '/default.jpg'
}

// Obtener contenido u7d para un canal específico (EPG 7 días + catch-up)
async function getU7dContent(channelId, skip = 0, top = 500, skipDetails = false) {
  const catalogs = await getU7dCatalogs()
  const cat = catalogs.find(c => c.id === channelId || c.channelId === channelId)
  if (!cat) return []

  // Base: programas EPG de los últimos 7 días (24h por día)
  const epgPrograms = await getEpgProgramsForU7d(cat.channelId, 7)
  if (epgPrograms.length === 0) return []

  // Mapa por timestamp para fusionar con catch-up
  const itemsByTs = new Map()
  for (const p of epgPrograms) {
    itemsByTs.set(p.startTimestamp, { ...p, type: CONTENT_TYPES.LIVE, contentId: '', streamType: 'epg-info', epgOnly: true })
  }

  try {
    if (cat.u7dType === 'stream11') {
      // Atresplayer: fetch recordings from row API (todas las páginas)
      const baseUrl = cat.u7dData.replace(/page=\d+/, 'page=0').replace(/size=\d+/, 'size=100')
      let page = 0
      let totalRows = []
      while (page < 10) {
        const pageUrl = baseUrl.replace(/page=\d+/, 'page=' + page)
        const res = await smartFetch(pageUrl, {
          headers: { 'Origin': 'https://www.atresplayer.com', 'Referer': 'https://www.atresplayer.com/', 'User-Agent': UA },
        })
        if (!res.ok) break
        const data = await res.json()
        const rows = data.itemRows || []
        totalRows.push(...rows)
        if (!data.pageInfo?.hasNext) break
        page++
      }

      for (const item of totalRows) {
        const startTimestamp = item.startTime || 0
        if (!startTimestamp) continue
        const existing = itemsByTs.get(startTimestamp)
        const emissionTime = formatEmissionTime(startTimestamp)
        const poster = buildAtresplayerImageUrl(item.image) || cat.channelLogo
        if (existing) {
          existing.title = item.title || existing.title
          existing.poster = poster || existing.poster
          existing.description = emissionTime ? 'Emitido: ' + emissionTime : existing.description
          existing.contentId = item.contentId
          existing.streamType = 'atresplayer-recording'
          existing.epgOnly = false
        } else {
          itemsByTs.set(startTimestamp, {
            id: 'u7d-item-' + item.contentId,
            title: item.title || 'Sin título',
            type: CONTENT_TYPES.LIVE,
            poster: poster || cat.channelLogo,
            logo: cat.channelLogo,
            description: emissionTime ? 'Emitido: ' + emissionTime : 'Emitido en TV',
            contentId: item.contentId,
            startTime: startTimestamp,
            startTimestamp,
            streamType: 'atresplayer-recording',
            epgOnly: false,
          })
        }
      }
    } else if (cat.u7dType === 'stream1') {
      // RTVE: fetch schedule from API (7 días en lugar de 5)
      let rtveUrl = cat.u7dData.replace(/pastDays=\d+/, 'pastDays=7')
      const res = await smartFetch(rtveUrl, {
        headers: { 'User-Agent': UA },
      })
      if (res.ok) {
        const data = await res.json()
        const items = data.items || []
        for (const item of items) {
          const startTimestamp = parseRteDate(item.begintime || '')
          if (!startTimestamp) continue
          const existing = itemsByTs.get(startTimestamp)
          const emissionTime = formatEmissionTime(startTimestamp)
          if (existing) {
            existing.title = item.name || existing.title
            existing.description = emissionTime ? 'Emitido: ' + emissionTime : existing.description
            existing.contentId = item.idAsset
            existing.streamType = 'rtve-u7d'
            existing.epgOnly = false
          } else {
            itemsByTs.set(startTimestamp, {
              id: 'u7d-item-rtve-' + item.idAsset,
              title: item.name || 'Sin título',
              type: CONTENT_TYPES.LIVE,
              poster: cat.channelLogo,
              logo: cat.channelLogo,
              description: emissionTime ? 'Emitido: ' + emissionTime : 'Emitido en TV',
              contentId: item.idAsset,
              startTime: startTimestamp,
              startTimestamp,
              streamType: 'rtve-u7d',
              epgOnly: false,
            })
          }
        }
        // Cargar carátulas de los primeros 30 catch-up
        if (!skipDetails) {
          const playableItems = Array.from(itemsByTs.values()).filter(i => i.streamType === 'rtve-u7d').slice(0, 30)
          await Promise.all(playableItems.map(async item => {
            try {
              const videoRes = await smartFetch('https://www.rtve.es/api/videos/' + item.contentId + '.json', {
                headers: { 'User-Agent': UA },
              })
              if (!videoRes.ok) return
              const videoData = await videoRes.json()
              const pageItems = videoData.page?.items || []
              if (pageItems.length > 0) {
                item.poster = pageItems[0].thumbnail || item.poster
                item.title = pageItems[0].title || item.title
              }
            } catch (e) {}
          }))
        }
      }
    } else if (cat.u7dType === 'stream10') {
      // Mediaset: intentar catch-up; si no hay, queda el EPG (sin reproducción)
      try {
        const callSignMap = { telecinco: 'T5', cuatro: 'CT', fdf: 'FD', energy: 'EN', divinity: 'DV', boing: 'BO', bemad: 'BM', 'mitele-comedia': 'MC', 'mitele-viajes': 'MV', 'mitele-en-la-calle': 'ME', 'mitele-top-series': 'MS' }
        const cs = callSignMap[cat.u7dCallSign] || (cat.u7dCallSign || '').toUpperCase()
        const now = Math.floor(Date.now() / 1000)
        const past = now - 7 * 24 * 3600

        const loginRes = await smartFetch('https://services-ott-prod-fe.mediaset.net/esp/idm/v3.0/anonymous/login', {
          method: 'POST',
          headers: { 'Origin': 'https://www.mediasetinfinity.es', 'Referer': 'https://www.mediasetinfinity.es/', 'Content-Type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ client_id: 'u7d-' + Date.now(), appName: 'web//mediasetplay-web/1.2.1-d1b2024' }),
        })
        if (loginRes.ok) {
          const loginData = await loginRes.json()
          const beToken = loginData.response?.beToken
          if (beToken) {
            const epgRes = await smartFetch('https://services-ott-prod-fe.mediaset.net/esp/feed/v3.0/allListingFeedEpg?byCallSign=' + cs + '&byListingTime=' + past + '~' + now, {
              headers: { 'Authorization': 'Bearer ' + beToken, 'Origin': 'https://www.mediasetinfinity.es', 'Referer': 'https://www.mediasetinfinity.es/', 'User-Agent': UA },
            })
            if (epgRes.ok) {
              const epgData = await epgRes.json()
              const entries = epgData.response?.entries || []
              for (const entry of entries) {
                const startTimestamp = entry.listingTime || 0
                if (!startTimestamp) continue
                const existing = itemsByTs.get(startTimestamp)
                const emissionTime = formatEmissionTime(startTimestamp)
                const title = entry.title || entry.programName || 'Sin título'
                const mediaUrl = entry.media?.mediaUrl || ''
                if (existing) {
                  existing.title = title || existing.title
                  existing.poster = entry.media?.thumbnailUrl || existing.poster
                  existing.description = emissionTime ? 'Emitido: ' + emissionTime : existing.description
                  existing.contentId = mediaUrl
                  existing.streamType = 'mediaset-u7d'
                  existing.epgOnly = false
                } else {
                  itemsByTs.set(startTimestamp, {
                    id: 'u7d-item-mediaset-' + (entry.id || entry.contentId || slugify(title + startTimestamp)),
                    title,
                    type: CONTENT_TYPES.LIVE,
                    poster: entry.media?.thumbnailUrl || cat.channelLogo,
                    logo: cat.channelLogo,
                    description: emissionTime ? 'Emitido: ' + emissionTime : 'Emitido en TV',
                    contentId: mediaUrl,
                    startTime: startTimestamp,
                    startTimestamp,
                    streamType: 'mediaset-u7d',
                    epgOnly: false,
                  })
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('[TDT] Mediaset catch-up error', e.message)
      }
    }
  } catch (e) {
    console.error('[TDT] U7D content error', e)
  }

  const allItems = Array.from(itemsByTs.values()).sort((a, b) => (b.startTimestamp || 0) - (a.startTimestamp || 0))
  console.log('[TDT] U7D content for', cat.name, ':', allItems.length, 'items')
  return allItems.slice(skip, skip + top)
}

// Resolver stream de una grabación u7d de Atresplayer
async function resolveU7dRecording(contentId) {
  try {
    const res = await smartFetch(`https://api.atresplayer.com/player/v1/recording/${contentId}`, {
      headers: { 'Origin': 'https://www.atresplayer.com', 'Referer': 'https://www.atresplayer.com/', 'User-Agent': UA },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const sources = data.sources || []
    const hls = sources.find(s => s.type === 'application/vnd.apple.mpegurl')
    const streamUrl = hls?.src || sources[0]?.src
    if (!streamUrl) return null
    return streamUrl
  } catch (e) {
    console.error('[TDT] U7D stream resolve error', e)
    return null
  }
}

// Obtener stream para un contenido u7d
async function getU7dStream(contentId, streamType) {
  if (streamType === 'atresplayer-recording') {
    const url = await resolveU7dRecording(contentId)
    if (!url) return []
    return [{
      name: 'U7D',
      url: applyProxy(url),
      format: 'm3u8',
      streamType: 'hls',
      quality: 'HLS',
    }]
  }
  if (streamType === 'rtve-u7d') {
    // RTVE: usar iframe con la URL del player (redirect URL con idAsset)
    return [{
      name: 'RTVE A la carta',
      url: 'https://www.rtve.es/play/videos/0/0/' + contentId + '/',
      format: 'iframe',
      streamType: 'iframe',
      quality: 'Web',
    }]
  }
  if (streamType === 'mediaset-u7d') {
    // Mediaset: usar iframe con la URL del contenido
    if (!contentId) return []
    return [{
      name: 'Mediaset A la carta',
      url: contentId,
      format: 'iframe',
      streamType: 'iframe',
      quality: 'Web',
    }]
  }
  return []
}

const manifest = new PluginManifest({
  id: 'tdt',
  name: 'TDT Channels',
  version: '1.0.0',
  description: 'Canales de TDT española desde tdtspain.com con resolución de streams',
  types: [CONTENT_TYPES.CHANNEL, CONTENT_TYPES.LIVE],
  catalogs: [],
  icon: 'tv',
})

export const tdtPlugin = createPlugin(manifest, {
  async getCatalogs() {
    const channelCats = await getCatalogs()
    const u7dCats = await getU7dCatalogs()
    return [...channelCats, ...u7dCats]
  },

  async getCatalog({ type, id, skip = 0, top = 500 } = {}) {
    // U7D catalogs
    if (id && id.startsWith('u7d-')) {
      return getU7dContent(id, skip, top)
    }

    const channels = await loadChannels()
    const allCatalogs = await getCatalogs()
    const selected = id ? allCatalogs.find(c => c.id === id) : null
    let filtered = selected ? channels.filter(ch => ch.ambit === selected.ambit) : channels
    return filtered.slice(skip, skip + top).map(ch => ({
      id: ch.id,
      name: ch.name,
      type: CONTENT_TYPES.CHANNEL,
      poster: ch.logo,
      logo: ch.logo,
      description: ch.description,
      ambit: ch.ambit,
    }))
  },

  async getMeta({ type, id }) {
    // U7D items
    if (id && id.startsWith('u7d-item-')) {
      if (u7dItemCache.has(id)) {
        const item = u7dItemCache.get(id)
        return {
          id: item.id,
          name: item.title,
          type: CONTENT_TYPES.LIVE,
          poster: item.poster,
          logo: item.logo,
          description: item.description,
          contentId: item.contentId,
          streamType: item.streamType,
        }
      }
      const u7dCats = await getU7dCatalogs()
      for (const cat of u7dCats) {
        const items = await getU7dContent(cat.id, 0, 100, true)
        const item = items.find(i => i.id === id)
        if (item) {
          // Para RTVE, intentar obtener la carátula real del programa para la página de detalle
          if (item.streamType === 'rtve-u7d' && item.contentId) {
            try {
              const videoRes = await smartFetch('https://www.rtve.es/api/videos/' + item.contentId + '.json', {
                headers: { 'User-Agent': UA },
              })
              if (videoRes.ok) {
                const videoData = await videoRes.json()
                const pageItems = videoData.page?.items || []
                if (pageItems.length > 0) {
                  item.poster = pageItems[0].thumbnail || item.poster
                  item.title = pageItems[0].title || item.title
                }
              }
            } catch (e) {
              // ignore
            }
          }
          u7dItemCache.set(id, item)
          return {
            id: item.id,
            name: item.title,
            type: CONTENT_TYPES.LIVE,
            poster: item.poster,
            logo: item.logo,
            description: item.description,
            contentId: item.contentId,
            streamType: item.streamType,
          }
        }
      }
      return null
    }

    const channels = await loadChannels()
    const ch = channels.find(c => c.id === id)
    if (!ch) return null
    return {
      id: ch.id,
      name: ch.name,
      type: CONTENT_TYPES.CHANNEL,
      poster: ch.logo,
      logo: ch.logo,
      description: ch.description,
      ambit: ch.ambit,
    }
  },

  async getStreams({ type, id }) {
    // U7D items
    if (id && id.startsWith('u7d-item-')) {
      if (u7dItemCache.has(id)) {
        const item = u7dItemCache.get(id)
        return getU7dStream(item.contentId, item.streamType)
      }
      const u7dCats = await getU7dCatalogs()
      for (const cat of u7dCats) {
        const items = await getU7dContent(cat.id, 0, 100, true)
        const item = items.find(i => i.id === id)
        if (item) {
          u7dItemCache.set(id, item)
          return getU7dStream(item.contentId, item.streamType)
        }
      }
      return []
    }

    const channels = await loadChannels()
    const ch = channels.find(c => c.id === id)
    if (!ch) return []

    if (ch.streamType === 'atresplayer') {
      const resolved = await resolveAtresplayer(ch.streamUrl)
      if (resolved?.liveUrl) {
        const streams = [{
          name: ch.name,
          url: applyProxy(resolved.liveUrl),
          format: 'm3u8',
          streamType: 'hls',
          quality: 'HLS',
          referer: ch.streamUrl,
        }]
        if (resolved.hasStartOver && resolved.startOverUrl) {
          streams.push({
            name: `${ch.name} - Desde el inicio del programa`,
            url: applyProxy(resolved.startOverUrl),
            format: 'm3u8',
            streamType: 'hls',
            quality: 'Start Over',
            referer: ch.streamUrl,
          })
        }
        return streams
      }
      return [{
        name: ch.name,
        url: ch.streamUrl,
        format: 'iframe',
        streamType: 'iframe',
        quality: 'Web',
        referer: ch.streamUrl,
      }]
    }

    if (ch.streamType === 'mediaset') {
      // Mediaset usa DRM (Widevine/FairPlay) en sus streams directos.
      // No se puede reproducir sin DRM. Usar iframe que usa el reproductor web oficial.
      return [{
        name: ch.name,
        url: ch.streamUrl,
        format: 'iframe',
        streamType: 'iframe',
        quality: 'Web',
        referer: ch.streamUrl,
      }]
    }

    if (ch.streamType === 'iframe' && ch.format === 'youtube') {
      const ytId = extractYoutubeId(ch.streamUrl)
      if (ytId) {
        return [{
          name: ch.name,
          url: `https://www.youtube.com/embed/${ytId}?autoplay=1`,
          format: 'youtube',
          streamType: 'iframe',
          quality: 'YouTube',
          referer: ch.streamUrl,
        }]
      }
      return [{
        name: ch.name,
        url: ch.streamUrl,
        format: 'youtube',
        streamType: 'iframe',
        quality: 'YouTube',
        referer: ch.streamUrl,
      }]
    }

    // HLS, DASH, o stream directo
    // Para RTVE/TVG, quitar el modo DVR para empezar en el directo real, no en un programa pasado
    let streamUrl = ch.streamUrl
    const isRtveDvr = streamUrl.includes('rtvelivestream') && streamUrl.includes('rtve.es') && streamUrl.includes('_dvr')
    const isTvgDvr = streamUrl.includes('crtvg') && streamUrl.includes('playlist_dvr')
    if (isRtveDvr) {
      streamUrl = streamUrl.replace(/_dvr(_\d+)?\.m3u8/, '$1.m3u8')
    } else if (isTvgDvr) {
      streamUrl = streamUrl.replace('playlist_dvr.m3u8', 'playlist.m3u8')
    }
    console.log('[TDT getStreams]', ch.name, 'original:', ch.streamUrl, 'converted:', streamUrl, 'isRtveDvr:', isRtveDvr, 'isTvgDvr:', isTvgDvr)

    return [{
      name: ch.name,
      url: applyProxy(streamUrl),
      format: ch.format,
      streamType: ch.streamType === 'dash' ? 'dash' : 'hls',
      quality: ch.format === 'm3u8' ? 'HLS' : ch.format === 'mpd' ? 'DASH' : ch.format.toUpperCase(),
      referer: ch.streamUrl,
    }]
  },

  async search({ query }) {
    const channels = await loadChannels()
    const q = query.toLowerCase()
    return channels
      .filter(c => c.name.toLowerCase().includes(q))
      .map(ch => ({
        id: ch.id,
        name: ch.name,
        type: CONTENT_TYPES.CHANNEL,
        poster: ch.logo,
        logo: ch.logo,
        description: ch.description,
      }))
  },

  async getEpg({ date } = {}) {
    const targetDate = date ? new Date(date) : new Date()
    const dateStr = targetDate.toISOString().slice(0, 10)

    if (cachedEpg && cachedEpgDate === dateStr && Date.now() - (cachedEpg._cacheTime || 0) < EPG_CACHE_TTL) {
      return cachedEpg.programs || []
    }

    try {
      const epgData = await loadEpgRaw()
      if (!epgData) throw new Error('No EPG data')

      const channels = await loadChannels()

      // Mapear epgId -> channelId
      const epgIdToChannelId = new Map()
      for (const ch of channels) {
        if (ch.epgId) epgIdToChannelId.set(ch.epgId, ch.id)
        epgIdToChannelId.set(ch.epgId.toLowerCase(), ch.id)
      }

      const programs = []
      const dayStart = new Date(targetDate)
      dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(targetDate)
      dayEnd.setHours(23, 59, 59, 999)

      // EPG JSON: array de canales con events
      for (const chEpg of epgData) {
        const epgId = chEpg.name || ''
        const channelId = epgIdToChannelId.get(epgId) || epgIdToChannelId.get(epgId.toLowerCase())
        if (!channelId) continue

        for (const ev of chEpg.events || []) {
          const start = new Date(ev.hi * 1000)
          const end = new Date(ev.hf * 1000)
          if (start > dayEnd || end < dayStart) continue

          programs.push({
            id: `${channelId}-${ev.hi}`,
            channelId,
            channelName: ch.name || '',
            logo: ch.logo || '',
            title: ev.t || 'Sin título',
            description: ev.d || '',
            start: start.toISOString(),
            end: end.toISOString(),
            genre: ev.g || '',
            poster: ev.c || ev.ch || '',
          })
        }
      }

      console.log('[TDT] EPG programs for', dateStr, ':', programs.length)
      cachedEpg = { programs, _cacheTime: Date.now() }
      cachedEpgDate = dateStr
      return programs
    } catch (e) {
      console.error('[TDT] EPG error', e)
      return []
    }
  },

  // Catálogo de contenidos de los últimos 7 días (U7D)
  async getU7dCatalogs() {
    return getU7dCatalogs()
  },

  async getU7dContent({ channelId, skip = 0, top = 50 } = {}) {
    return getU7dContent(channelId, skip, top)
  },

  async getU7dStream({ contentId, streamType }) {
    return getU7dStream(contentId, streamType)
  },
})
