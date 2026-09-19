// Stream resolution for TDT Spain: live channels and U7D programs.

import { UA, normKey, tlog, twarn, proxied } from './constants.js'
import { fetchJson, fetchText, httpPostJson } from './http.js'
import { getRtveHls, getU7d } from './data.js'
import { logWarn } from '../../../utils/logger.js'

export function resolveRtveHls(ch, rtveMap) {
  const chid = String(ch.id || '')
  const name = String(ch.name || '')
  const url = rtveMap[chid] || rtveMap[normKey(chid)] || rtveMap[normKey(name)]
  if (url) {
    return {
      url,
      streamType: 'hls',
      quality: 'LIVE',
      headers: { 'User-Agent': UA, Origin: 'https://www.rtve.es', Referer: 'https://www.rtve.es/' },
    }
  }
  const aliases = { la1: 'La1.TV', la2: 'La2.TV', '24h': '24Horas.TV', '24horas': '24Horas.TV', clan: 'Clan.TV', teledeporte: 'TDP.TV', tdp: 'TDP.TV' }
  const a = aliases[normKey(name)]
  if (a) {
    const u = rtveMap[a] || rtveMap[normKey(a)]
    if (u) return { url: u, streamType: 'hls', quality: 'LIVE', headers: { 'User-Agent': UA, Origin: 'https://www.rtve.es', Referer: 'https://www.rtve.es/' } }
  }
  return null
}

export async function resolveAtresLive(ch, streamTypes) {
  const def = streamTypes.stream11 || {}
  const page = String(ch.url || '')
  let key = page.match(/atresplayer\.com(\/.*)$/)?.[1] || page
  if (!key.startsWith('/')) key = '/' + key
  if (!key.endsWith('/')) key += '/'
  const encKey = encodeURIComponent(key)
  const baseTmpl = def.baseurl || 'https://api.atresplayer.com/client/v1/url?href=$key'
  let base = baseTmpl.replace('$key', encKey)
  if (base === baseTmpl) base = 'https://api.atresplayer.com/client/v1/url?href=' + encKey

  const hdr = { 'User-Agent': UA, Origin: 'https://www.atresplayer.com', Referer: 'https://www.atresplayer.com/' }
  const r1 = await fetchJson(base, hdr)
  if (!r1?.href) return null
  const r2 = await fetchJson(r1.href, hdr)
  if (!r2) return null
  const urlVideo = r2.urlVideo || ''
  if (!urlVideo) return null

  const player = await fetchJson(urlVideo + '?usp=true&device=desktop&NODRM=true', hdr)
  if (!player) return null
  const sources = player.sourcesLive || player.sources || []
  for (const src of sources) {
    const t = String(src.type || '')
    const u = String(src.src || '')
    if (u && (/mpegurl/.test(t) || /hls/.test(t) || u.endsWith('.m3u8'))) {
      return { url: u, streamType: 'hls', quality: 'LIVE', headers: hdr }
    }
  }
  return null
}

export async function resolveMediasetLive(ch, streamTypes) {
  const def = streamTypes.stream10 || {}
  const attrs = def.atributtes || def.attributes || {}
  const hdr = { 'User-Agent': UA, Origin: 'https://www.mediasetinfinity.es', Referer: 'https://www.mediasetinfinity.es/' }

  const page = String(ch.url || '')
  const pageSlug = page.match(/\/directo\/([^/]+)/)?.[1] || ''

  const slugMap = {
    telecinco: 'T5', cuatro: 'CT', fdf: 'FD', energy: 'EN', divinity: 'DV',
    bemad: 'BM', boing: 'BO', 'mitele-comedia': 'MC', 'mitele-viajes': 'MV',
    'mitele-en-la-calle': 'ME', 'mitele-top-series': 'MS', 'mtmad-24h': 'MT',
    'mitele-plus-lqsa': 'ML', acontraplus: 'AC', 'fight-sports': 'FS',
  }

  let callSign = slugMap[pageSlug] || null

  if (!callSign) {
    try {
      const initUrl = attrs.initUrl || 'https://services-ott-prod-fe.mediaset.net/esp/static/nownext/v3.0/nownext.json'
      const nn = await fetchJson(initUrl, hdr)
      const stations = nn?.response?.stations || {}
      for (const st of Object.values(stations)) {
        if (!st || typeof st !== 'object') continue
        const vpu = String(st['mediasetstation$videoPageUrl'] || st.videoPageUrl || '')
        if (vpu && pageSlug) {
          const vpuSlug = vpu.match(/\/directo\/([^/]+)/)?.[1] || ''
          if (vpuSlug === pageSlug) {
            callSign = st.callSign
            break
          }
        }
      }
    } catch (e) {
      twarn('[TDT Spain] Mediaset nownext fetch failed:', e?.message)
    }
  }
  if (!callSign) {
    twarn('[TDT Spain] Mediaset: no callSign found for', pageSlug)
    return null
  }

  const appname = attrs.appname || 'web//mediasetplay-web/1.2.1-d1b2024'
  const urlToken = attrs.urltoken || 'https://services-ott-prod-fe.mediaset.net/esp/idm/v3.0/anonymous/login'
  const clientId = String(Date.now() % 1000000000) + '-' + String(Math.floor(Math.random() * 900000) + 100000)
  const loginRes = await httpPostJson(
    urlToken,
    { appName: appname, client_id: clientId },
    { ...hdr, 'Content-Type': 'application/json' },
  ).catch(e => { twarn('[TDT Spain] Mediaset login failed:', e?.message); return null })

  const sid = loginRes?.response?.sid
  const beToken = loginRes?.response?.beToken
  if (!sid || !beToken) return null

  const checkUrl = `https://services-ott-prod-fe.mediaset.net/esp/playback/v3.0/check?sid=${sid}`
  const chkRes = await httpPostJson(
    checkUrl,
    { channelCode: callSign, streamType: 'LIVE' },
    { ...hdr, Authorization: 'Bearer ' + beToken, 'Content-Type': 'application/json' },
  ).catch(e => { twarn('[TDT Spain] Mediaset check failed:', e?.message); return null })

  const dai = chkRes?.response?.dai?.assetKey
  if (!dai) return null

  const daiUrl = 'https://pubads.g.doubleclick.net/ssai/event/' + dai + '/streams'
  const daiRes = await httpPostJson(
    daiUrl,
    'ppid=' + clientId + '&vpa=auto&wta=1&vpmute=0',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    true,
  ).catch(e => { twarn('[TDT Spain] Mediaset DAI failed:', e?.message); return null })

  const manifest = daiRes?.stream_manifest
  if (!manifest) return null
  return { url: manifest, streamType: 'hls', quality: 'LIVE', headers: hdr }
}

async function resolveGetUrl(ch) {
  const url = String(ch.url || '')
  try {
    const origin = new URL(url).origin
    const res = await fetch(proxied(url), {
      headers: { 'User-Agent': UA, Origin: origin, Referer: origin + '/', ...(ch.headers || {}) },
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    })
    if (!res.ok) return null
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      const jsonStr = JSON.stringify(json)
      const m = jsonStr.match(/(?:https?:)?\/\/[^"'\\ ]*\.m3u8[^"'\\ ]*/)
      if (m) return { url: m[0].startsWith('//') ? 'https:' + m[0] : m[0], streamType: 'hls', quality: 'LIVE', headers: ch.headers }
    } catch {}
    const m = text.match(/(?:https?:)?\/\/[^"'\s<>]*\.m3u8[^"'\s<>]*/)
    if (m) return { url: m[0].startsWith('//') ? 'https:' + m[0] : m[0], streamType: 'hls', quality: 'LIVE', headers: ch.headers }
    return null
  } catch (e) {
    twarn('[TDT Spain] geturl error:', e?.message, url.substring(0, 80))
    return null
  }
}

async function resolvePostUrl(url) {
  try {
    const res = await fetch(proxied(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'ppid=' + Date.now() + '&vpa=auto&wta=1&vpmute=0',
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    const manifest = data?.stream_manifest
    if (manifest) return { url: manifest, streamType: 'hls', quality: 'LIVE' }
    return null
  } catch (e) {
    twarn('[TDT Spain] posturl error:', e?.message, url.substring(0, 80))
    return null
  }
}

export async function resolveLiveStream(ch, cache) {
  const st = String(ch.streamtype || '')
  const url = String(ch.url || '')

  if (st === 'stream1') {
    const rtveMap = await getRtveHls(cache)
    return resolveRtveHls(ch, rtveMap)
  }
  if (st === 'stream11') {
    try {
      return await resolveAtresLive(ch, cache.streamTypes)
    } catch (e) {
      logWarn('TDT Spain Atresplayer resolve failed', String(e?.message || e))
      return null
    }
  }
  if (st === 'stream10') {
    try {
      return await resolveMediasetLive(ch, cache.streamTypes)
    } catch (e) {
      logWarn('TDT Spain Mediaset resolve failed', String(e?.message || e))
      return null
    }
  }
  if (st === '' || st === 'hls') {
    if (/^https?:\/\//.test(url)) return { url, streamType: 'hls', quality: 'LIVE' }
  }
  if (st === 'stream12') {
    try {
      const data = await fetchJson(url, { Origin: 'https://geo.dailymotion.com', Referer: 'https://geo.dailymotion.com/' })
      const auto = data?.qualities?.auto
      if (Array.isArray(auto) && auto[0]?.url) return { url: auto[0].url, streamType: 'hls', quality: 'LIVE' }
    } catch (e) {
      logWarn('TDT Spain Dailymotion resolve failed', String(e?.message || e))
    }
  }
  if (st === 'geturl') {
    if (/^https?:\/\//.test(url)) return await resolveGetUrl(ch)
  }
  if (st === 'posturl') {
    if (/^https?:\/\//.test(url)) return await resolvePostUrl(url)
  }
  if (/^https?:\/\//.test(url) && (/\.m3u8/.test(url) || /\/hls/.test(url))) {
    return { url, streamType: 'hls', quality: 'LIVE' }
  }
  return null
}

export async function resolveU7dStream(itemId, cache) {
  const parts = itemId.match(/^u7d-(.+?)-(\d+(?:\.\d+)?)(?:-([A-Za-z0-9_]+|NOGUID))?$/)
  if (!parts) return null
  const chKey = parts[1]
  const startTs = parseFloat(parts[2])
  const embeddedGuid = parts[3] && parts[3] !== 'NOGUID' ? parts[3] : ''

  cache = await getU7d(cache)
  const u7d = cache.u7d || {}
  const u7dConf = u7d.U7dConf || {}
  const chData = u7dConf[chKey]
  if (!chData) return null
  const u7dtype = chData.u7dtype || ''

  if (u7dtype === 'stream1') {
    return resolveU7dRtve(chKey, startTs, chData)
  }
  if (u7dtype === 'stream11') {
    return resolveU7dAtresplayer(chKey, startTs, chData)
  }
  if (u7dtype === 'stream10') {
    return resolveU7dMediaset(chKey, startTs, chData, cache, embeddedGuid)
  }
  twarn('[TDT Spain] U7D: unknown type', u7dtype, 'for', chKey)
  return null
}

async function resolveU7dRtve(chKey, startTs, chData) {
  const u7dUrl = chData.u7ddata || ''
  if (!u7dUrl) return null
  try {
    const progData = await fetchJson(u7dUrl)
    const items = progData.items || []
    let program = null
    for (const it of items) {
      const bt = it.begintime || ''
      if (bt && /^\d{14}$/.test(bt)) {
        const y = bt.slice(0,4), mo = bt.slice(4,6), d = bt.slice(6,8)
        const h = bt.slice(8,10), mi = bt.slice(10,12), s = bt.slice(12,14)
        const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
        const ts = Math.floor(dt.getTime() / 1000)
        if (ts === Math.floor(startTs)) {
          program = it
          break
        }
      }
    }
    if (!program) return null
    const idAsset = program.idAsset || program.idPrograma
    if (!idAsset) return null
    const hlsUrl = `https://ztnr.rtve.es/ztnr/${idAsset}.m3u8`
    return {
      name: program.name || 'RTVE',
      url: hlsUrl,
      streamType: 'hls',
      quality: 'VOD',
      headers: { 'User-Agent': UA, Origin: 'https://www.rtve.es', Referer: 'https://www.rtve.es/' },
    }
  } catch (e) {
    twarn('[TDT Spain] U7D RTVE resolve error:', e?.message)
    return null
  }
}

async function resolveU7dAtresplayer(chKey, startTs, chData) {
  const u7dUrl = chData.u7ddata || ''
  if (!u7dUrl) return null
  try {
    const progData = await fetchJson(u7dUrl)
    const progs = progData.itemRows || progData.items || []
    let program = null
    for (const p of progs) {
      const pTs = Math.floor((p.startTime || 0) / 1000)
      if (pTs === Math.floor(startTs)) {
        program = p
        break
      }
    }
    if (!program) return null
    const link = program.link?.href || program.link?.url || program.href || ''
    if (!link) return null
    const hdr = { 'User-Agent': UA, Origin: 'https://www.atresplayer.com', Referer: 'https://www.atresplayer.com/' }
    const fullUrl = link.startsWith('http') ? link : `https://api.atresplayer.com${link}`
    const r1 = await fetchJson(fullUrl, hdr)
    const urlVideo = r1?.urlVideo || ''
    if (urlVideo) {
      const player = await fetchJson(urlVideo + '?usp=true&device=desktop&NODRM=true', hdr)
      const sources = player?.sources || player?.sourcesLive || []
      for (const src of sources) {
        const t = String(src.type || '')
        const u = String(src.src || '')
        if (u && (/mpegurl/.test(t) || /hls/.test(t) || u.endsWith('.m3u8'))) {
          return { name: program.title || 'Atresplayer', url: u, streamType: 'hls', quality: 'VOD', headers: hdr }
        }
      }
    }
    return null
  } catch (e) {
    twarn('[TDT Spain] U7D Atresplayer resolve error:', e?.message)
    return null
  }
}

async function resolveU7dMediaset(chKey, startTs, chData, cache, embeddedGuid) {
  const u7dUrl = chData.u7ddata || ''
  if (!u7dUrl) return null
  try {
    const callSignMatch = u7dUrl.match(/byCallSign=([^&]+)/)
    const callSign = callSignMatch ? callSignMatch[1] : ''
    if (!callSign) return null

    const now = Date.now()
    const ONE_DAY = 24 * 60 * 60 * 1000
    let guid = embeddedGuid
    let hasVod = false
    let isFree = false

    if (guid) {
      tlog('[TDT Spain] U7D Mediaset: using embedded guid', guid)
    } else {
      const targetMs = startTs * 1000
      // byListingTime requiere formato ISO 8601 (no epoch)
      const dayUrl = `https://services-ott-prod-fe.mediaset.net/esp/feed/v3.0/allListingFeedEpg?byCallSign=${callSign}&byListingTime=${new Date(targetMs - ONE_DAY).toISOString()}~${new Date(targetMs + ONE_DAY).toISOString()}`
      const dayData = await fetchJson(dayUrl).catch(() => null)
      if (!dayData) return null
      const entries = dayData.response?.entries || []
      for (const entry of entries) {
        for (const listing of (entry.listings || [])) {
          const lTs = Math.floor((listing.startTime || 0) / 1000)
          if (lTs === Math.floor(startTs)) {
            const prog = listing.program || {}
            guid = prog.guid || ''
            hasVod = !!prog['mediasetprogram$hasVod']
            const rights = prog['mediasetprogram$channelsRights'] || []
            isFree = rights.includes('AVOD')
            break
          }
        }
        if (guid) break
      }
      if (!guid) return null
    }
    if (!isFree && hasVod) return null

    const hdr = { 'User-Agent': UA, Origin: 'https://www.mediasetinfinity.es', Referer: 'https://www.mediasetinfinity.es/' }
    const appname = cache.streamTypes?.stream10?.atributtes?.appname || 'web//mediasetplay-web/1.2.1-d1b2024'
    const clientId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 0x3 | 0x8); return v.toString(16) })

    const loginRes = await httpPostJson(
      'https://services-ott-prod-fe.mediaset.net/esp/idm/v3.0/anonymous/login',
      { appName: appname, client_id: clientId },
      { ...hdr, 'Content-Type': 'application/json' },
    ).catch(e => { twarn('[TDT Spain] U7D Mediaset login failed:', e?.message); return null })
    const sid = loginRes?.response?.sid
    const beToken = loginRes?.response?.beToken
    if (!sid || !beToken) {
      twarn('[TDT Spain] U7D Mediaset: no sid/beToken', JSON.stringify(loginRes || {}).substring(0, 200))
      return null
    }
    tlog('[TDT Spain] U7D Mediaset: login OK, sid present')

    const checkRes = await httpPostJson(
      `https://services-ott-prod-fe.mediaset.net/esp/playback/v3.0/check?sid=${sid}`,
      { contentId: guid, streamType: 'VOD', delivery: 'Streaming', createDevice: true, overrideAppName: appname },
      { ...hdr, Authorization: 'Bearer ' + beToken, 'Content-Type': 'application/json' },
    ).catch(e => { twarn('[TDT Spain] U7D Mediaset check failed:', e?.message); return null })
    if (!checkRes) {
      twarn('[TDT Spain] U7D Mediaset: check returned null')
      return null
    }
    tlog('[TDT Spain] U7D Mediaset: check isOk:', checkRes?.isOk, 'error:', checkRes?.error?.code || '')

    const ms = checkRes?.response?.mediaSelector
    if (!ms?.url) {
      twarn('[TDT Spain] U7D Mediaset: no mediaSelector url')
      return null
    }

    const authBasic = btoa(':' + beToken)
    const smilParams = new URLSearchParams()
    for (const [k, v] of Object.entries(ms)) {
      if (k === 'url') continue
      smilParams.append(k, v)
    }
    const smilUrl = ms.url + '?' + smilParams.toString()
    tlog('[TDT Spain] U7D Mediaset: fetching SMIL', smilUrl.substring(0, 80))
    const smilText = await fetchText(smilUrl, { ...hdr, Authorization: 'Basic ' + authBasic }).catch(e => { twarn('[TDT Spain] U7D Mediaset SMIL fetch failed:', e?.message); return '' })
    if (!smilText) return null
    tlog('[TDT Spain] U7D Mediaset: SMIL length', smilText.length)

    const srcMatch = smilText.match(/src="(https?:\/\/[^"]+)"/)
    const isException = /isException.*value="true"/.test(smilText)
    if (!srcMatch || isException) return null

    const streamUrl = srcMatch[1]
    const isDash = /\.mpd/i.test(streamUrl)
    const isMp4 = /\.mp4/i.test(streamUrl)

    let licenseUrl = ''
    let drmHeaders = {}
    if (isDash) {
      const trackingMatch = smilText.match(/trackingData.*?value="([^"]+)"/)
      const trackingData = trackingMatch?.[1] || ''
      let pid = '', aid = ''
      for (const part of trackingData.split('|')) {
        if (part.startsWith('pid=')) pid = part.substring(4)
        if (part.startsWith('aid=')) aid = part.substring(4)
      }
      const licenseTemplate = cache.streamTypes?.stream10?.atributtes?.license || ''
      if (licenseTemplate && pid && aid) {
        licenseUrl = licenseTemplate
          .replace('${stream.releasePID}', pid)
          .replace('${stream.accountID}', aid)
          .replace('${token.token}', beToken)
        drmHeaders = {
          'origin': 'https://www.mediasetinfinity.es',
          'referer': 'https://www.mediasetinfinity.es/',
          'User-agent': UA,
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
        }
      }
    }

    return {
      name: 'Mediaset VOD',
      url: streamUrl,
      streamType: isDash ? 'dash' : (isMp4 ? 'mp4' : 'hls'),
      quality: 'VOD',
      headers: hdr,
      drm: isDash ? { type: 'widevine', licenseUrl, headers: drmHeaders } : undefined,
    }
  } catch (e) {
    twarn('[TDT Spain] U7D Mediaset resolve error:', e?.message)
    return null
  }
}
