// Shared constants and helpers for the TDT Spain bundled plugin.

export const CHANNELS_URL = 'https://www.tdtspain.com/canales/canalesv4.json'
export const EPG_URL = 'https://www.tdtspain.com/epg/TV.json.gz'
export const U7D_URL = 'https://www.tdtspain.com/u7d/u7dv1.json'
export const TDTCHANNELS_M3U = 'https://www.tdtchannels.com/lists/tv.m3u8'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

export const CACHE_KEY = 'octostream_tdspain_cache'
export const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

export const RTVE_HLS_FALLBACK = {
  'La1.TV': 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main_dvr.m3u8',
  'La2.TV': 'https://rtvelivestream.rtve.es/rtvesec/la2/la2_main_dvr.m3u8',
  '24Horas.TV': 'https://rtvelivestream.rtve.es/rtvesec/24h/24h_main_dvr.m3u8',
  'Clan.TV': 'https://rtvelivestream.rtve.es/rtvesec/clan/clan_main_dvr.m3u8',
  'TDP.TV': 'https://rtvelivestream.rtve.es/rtvesec/tdp/tdp_main.m3u8',
  'TVE_INTER.TV': 'https://rtvelivestream.rtve.es/rtvesec/int/tvei_eu_main_dvr.m3u8',
  'TVE_STAR.TV': 'https://rtvelivestream.rtve.es/rtvesec/int/star_main_dvr.m3u8',
}

// Stream types we can resolve. Channels with types not in this set are filtered out.
export const RESOLVABLE_TYPES = new Set([
  '', 'hls', 'stream1', 'stream10', 'stream11', 'stream12', 'geturl', 'posturl',
])

export function normKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[^\w.-]/g, '')
}

export function tlog(...args) {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
  console.log(msg)
  if (typeof window !== 'undefined' && window.octostream?.log) {
    window.octostream.log(msg)
  }
}

export function twarn(...args) {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
  console.warn(msg)
  if (typeof window !== 'undefined' && window.octostream?.log) {
    window.octostream.log('WARN: ' + msg)
  }
}

export function proxied(url) {
  if (
    typeof window !== 'undefined' &&
    window.octostream?.proxyUrl &&
    /^https?:\/\//.test(url) &&
    !url.includes('127.0.0.1')
  ) {
    if (/mediaset|dai\.google\.com|doubleclick\.net/i.test(url)) return url
    const isHls = /\.m3u8/i.test(url) || /\.ts(\?|$)/i.test(url)
    const isGz = /\.gz$/i.test(url)
    if (isHls || isGz) {
      return window.octostream.proxyUrl + encodeURIComponent(url)
    }
  }
  return url
}
