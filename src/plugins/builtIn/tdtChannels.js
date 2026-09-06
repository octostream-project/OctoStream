import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'
import { logError, logWarn } from '../../utils/logger.js'

const DEFAULT_SOURCE_URL = 'https://www.tdtchannels.com/lists/tv.json'
const SOURCE_URL =
  (import.meta.env && import.meta.env.VITE_TDTCHANNELS_URL) ||
  (typeof process !== 'undefined' && process.env && process.env.TDTCHANNELS_URL) ||
  DEFAULT_SOURCE_URL

const CACHE_KEY = 'optopus_tdtchannels_cache'
const CACHE_TTL_MS = 5 * 60 * 1000

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function isHlsLink(link) {
  if (!link || !link.url) return false
  if (link.type === 'application/x-mpegURL') return true
  if (link.url.endsWith('.m3u8')) return true
  if (link.url.includes('.m3u8')) return true
  return false
}

function getChannelUrl(channel) {
  const link = channel.links?.find(isHlsLink)
  return link?.url || channel.url || null
}

function parseTdtChannels(data) {
  const channels = []
  const seen = new Set()
  const countries = data.countries || data.regions || (Array.isArray(data) ? data : [data])

  for (const country of countries) {
    const list = country.channels || country.muxes || []
    for (const channel of list) {
      const url = getChannelUrl(channel)
      if (!url) continue

      const id = `tdt-${slugify(channel.name)}`
      if (seen.has(id)) continue
      seen.add(id)

      channels.push({
        id,
        name: channel.name,
        logo: channel.logo || channel.image || null,
        url,
        epgId: channel.epg_id || channel.epg || null,
        country: country.name || 'España',
      })
    }
  }

  return channels
}

async function fetchChannels() {
  const cached = localStorage.getItem(CACHE_KEY)
  if (cached) {
    try {
      const { timestamp, channels } = JSON.parse(cached)
      if (Date.now() - timestamp < CACHE_TTL_MS) {
        return channels
      }
    } catch {
      // ignore stale cache
    }
  }

  try {
    const res = await fetch(SOURCE_URL, { cache: 'no-store' })
    if (!res.ok) throw new Error(`TDT Channels HTTP ${res.status}`)
    const data = await res.json()
    const channels = parseTdtChannels(data)
    localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), channels }))
    return channels
  } catch (e) {
    logError('TDT Channels fetch failed', String(e?.message || e))
    throw e
  }
}

function normalizeChannel(channel) {
  return {
    id: channel.id,
    type: CONTENT_TYPES.LIVE,
    name: channel.name,
    title: channel.name,
    poster: channel.logo,
    logo: channel.logo,
    description: `Canal TDT: ${channel.name}`,
    genres: ['TDT'],
    country: channel.country,
  }
}

function normalizeStream(channel) {
  return {
    name: channel.name,
    url: channel.url,
    streamType: 'hls',
    quality: 'HD',
  }
}

const manifest = new PluginManifest({
  id: 'tdtchannels',
  name: 'TDT Channels',
  version: '1.0.0',
  description: 'Canales de TDT española desde tdtchannels.com',
  types: [CONTENT_TYPES.LIVE, CONTENT_TYPES.CHANNEL],
  catalogs: [{ id: 'tdt-channels', name: 'Canales TDT', type: CONTENT_TYPES.LIVE }],
  icon: 'tv',
})

export const tdtChannelsPlugin = createPlugin(manifest, {
  async getCatalog({ type, skip = 0, top = 50 }) {
    try {
      const channels = await fetchChannels()
      return channels.slice(skip, skip + top).map(normalizeChannel)
    } catch (e) {
      logWarn('TDT Channels getCatalog failed', String(e?.message || e))
      return []
    }
  },

  async getMeta({ id }) {
    try {
      const channels = await fetchChannels()
      const channel = channels.find(ch => ch.id === id)
      if (!channel) return null
      return normalizeChannel(channel)
    } catch (e) {
      logWarn('TDT Channels getMeta failed', String(e?.message || e))
      return null
    }
  },

  async getStreams({ id }) {
    try {
      const channels = await fetchChannels()
      const channel = channels.find(ch => ch.id === id)
      if (!channel) return []
      return [normalizeStream(channel)]
    } catch (e) {
      logWarn('TDT Channels getStreams failed', String(e?.message || e))
      return []
    }
  },

  async search({ query }) {
    try {
      const q = (query || '').toLowerCase()
      const channels = await fetchChannels()
      return channels
        .filter(ch => ch.name.toLowerCase().includes(q))
        .map(normalizeChannel)
    } catch (e) {
      logWarn('TDT Channels search failed', String(e?.message || e))
      return []
    }
  },
})

export default tdtChannelsPlugin
