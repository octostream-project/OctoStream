import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'
import { unpack as jsunpack } from '../../lib/jsunpack.js'

// ── Helpers ─────────────────────────────────────────────────────────

async function fetchHtml(url, headers = {}) {
  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  }
  const res = await fetch(url, { headers: { ...defaultHeaders, ...headers } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

// ── Resolvers ───────────────────────────────────────────────────────

const resolvers = {
  async voe(url) {
    const data = await fetchHtml(url)
    if (/Not found|File not found|File is no longer available/i.test(data)) return []

    const streams = []
    const videoSrcs = data.match(/(?:mp4|hls):\s*'([^']+)'/g) || []
    for (const m of videoSrcs) {
      const u = m.match(/:\s*'([^']+)'/)?.[1]
      if (u) {
        if (u.startsWith('aHR0')) {
          try {
            const decoded = atob(u)
            streams.push({ name: 'Voe', url: decoded })
          } catch {}
        } else if (u.startsWith('http')) {
          streams.push({ name: 'Voe', url: u })
        }
      }
    }
    return streams
  },

  async streamwish(url) {
    const data = await fetchHtml(url)
    if (/no longer available|Not Found|restricted for this domain/i.test(data)) return []

    const streams = []
    const pack = data.match(/p,a,c,k,e,d.*?<\/script>/s)
    if (pack) {
      try {
        const unpacked = jsunpack(pack[0])
        const m3u8 = unpacked.match(/(?:file|"hls2"):"([^"]+)"/)
        if (m3u8) streams.push({ name: 'Streamwish', url: m3u8[1] })
      } catch {}
    }
    return streams
  },

  async mixdrop(url) {
    const data = await fetchHtml(url)
    if (/>WE ARE SORRY</i.test(data) || /<title>404 Not Found</i.test(data)) return []

    const streams = []
    const packed = data.match(/(eval.*?)<\/script>/gs)
    for (const pack of packed || []) {
      try {
        const unpacked = jsunpack(pack)
        const urls = unpacked.match(/MDCore\.\w+\s*=\s*"([^"]+)"/g) || []
        for (const m of urls) {
          const u = m.match(/=\s*"([^"]+)"/)?.[1]
          if (u && u.endsWith('.mp4') && !u.endsWith('.jpg')) {
            let finalUrl = u
            if (u.startsWith('//')) finalUrl = 'https:' + u
            streams.push({ name: 'Mixdrop', url: finalUrl })
            break
          }
        }
      } catch {}
    }
    return streams
  },

  async uqload(url) {
    let embedUrl = url
    if (!embedUrl.includes('embed-')) {
      embedUrl = embedUrl.replace(/uqload\.(com|org|co|io|to|ws|net|cx|bz|is)\//, 'uqload.com/embed-')
      if (!embedUrl.endsWith('.html')) embedUrl += '.html'
      embedUrl = embedUrl.replace('.html/.html', '.html')
    }

    const data = await fetchHtml(embedUrl)
    if (/File was deleted|File is no longer available|The file expired/i.test(data)) return []

    const streams = []
    let bloque = data.match(/sources\s*:\s*\[(.*?)\]/s)

    if (!bloque) {
      try {
        const packed = data.match(new RegExp("text/javascript['\"]>(eval.*?)\\s*<\\/script>", 's'))
        if (packed) {
          const unpacked = jsunpack(packed[1])
          bloque = unpacked.match(new RegExp("sources\\s*:\\s*\\[(.*?)\\]", 's'))
        }
      } catch {}
    }

    if (bloque) {
      const matches = bloque[1].match(/(http[^"]+)"/g) || []
      for (const u of matches) {
        if (u.startsWith('http')) streams.push({ name: 'Uqload', url: u.replace(/"/g, '') })
      }
    }

    return streams
  },

  async lulustream(url) {
    const data = await fetchHtml(url)
    if (/Not Found|File was deleted/i.test(data)) return []

    const streams = []
    try {
      const enc = data.match(new RegExp("text/javascript['\"]>(eval.*?)<\\/script>", 's'))
      if (enc) {
        const unpacked = jsunpack(enc[1])
        const matches = unpacked.match(/sources:\s*\[\{(?:file|src):"([^"]+)"/g) || []
        for (const m of matches) {
          const u = m.match(/:"([^"]+)"/)?.[1]
          if (u && u.startsWith('http')) streams.push({ name: 'Lulustream', url: u })
        }
      }
    } catch {}
    return streams
  },

  async doodstream(url) {
    const data = await fetchHtml(url)
    if (/File was deleted|File not found/i.test(data)) return []

    const streams = []
    const passMatch = data.match(/'\/pass_md5\/([^']+)'/) || data.match(/\/pass_md5\/([a-zA-Z0-9\/]+)/)
    if (passMatch) {
      const token = passMatch[1]
      const domain = url.match(/https?:\/\/[^/]+/)?.[0] || 'https://dood.to'
      const passUrl = `${domain}/pass_md5/${token}`
      try {
        const md5Data = await fetchHtml(passUrl)
        if (md5Data) {
          const randStr = Math.random().toString(36).substring(2, 12)
          const tokenMatch = url.match(/\/e\/([a-zA-Z0-9]+)/)
          const tokenVal = tokenMatch ? tokenMatch[1] : ''
          const finalUrl = `${md5Data}${randStr}?token=${tokenVal}&expiry=`
          streams.push({ name: 'Doodstream', url: finalUrl })
        }
      } catch {}
    }
    return streams
  },

  async streamtape(url) {
    const data = await fetchHtml(url)
    if (/File was deleted|Not found/i.test(data)) return []

    const streams = []
    const matches = data.match(/document\.getElementById\('linko'\)\.href\s*=\s*'([^']+)/) ||
                    data.match(/(https?:\/\/[^\s"\'<>]+getvideo[^\s"\'<>]+)/)
    if (matches) {
      const u = matches[1] || matches[0]
      if (u.startsWith('http')) streams.push({ name: 'Streamtape', url: u })
    }
    return streams
  },

  async vidoza(url) {
    const data = await fetchHtml(url)
    const streams = []
    const matches = data.match(/sources\s*:\s*\[\{(?:file|src)\s*:\s*["\']([^"\']+)["\']/g) || []
    for (const m of matches) {
      const u = m.match(/:\s*["\']([^"\']+)["\']/)?.[1]
      if (u && u.startsWith('http')) streams.push({ name: 'Vidoza', url: u })
    }
    if (!streams.length) {
      const direct = data.match(/https?:\/\/[^\s"\'<>]+\.(?:mp4|m3u8)/gi) || []
      for (const u of direct) {
        if (u.includes('vidoza')) streams.push({ name: 'Vidoza', url: u })
      }
    }
    return streams
  },
}

// ── Channels ───────────────────────────────────────────────────────

const channels = {
  async gnula(query, typeFilter = 'all') {
    const host = 'https://ww3.gnulahd.nu/'
    const searchUrl = `${host}?s=${encodeURIComponent(query)}`
    const data = await fetchHtml(searchUrl)
    if (!data) return []

    const items = []
    const patron = /<article class="bs".*?<a href="(.*?)".*?title="(.*?)".*?<div class="typez(.*?)<\/div>.*?src="(.*?)".*?<\/article>/gs
    const matches = [...data.matchAll(patron)]

    for (const [, url, title, typeRaw, thumb] of matches) {
      const cleanTitle = title.replace(/&#8217;/g, "'").replace(/&#038;/g, "&").replace(/&#8230;/g, "")
      const tipo = />Pelicula</i.test(typeRaw) ? 'movie' : 'series'
      if (typeFilter !== 'all' && typeFilter !== tipo) continue

      const slug = url.endsWith('/') ? url.slice(0, -1).split('/').pop() : url.split('/').pop()
      items.push({
        id: `gnula:${tipo}:${slug}`,
        title: cleanTitle,
        type: tipo,
        poster: thumb,
        sourceUrl: url,
      })
    }

    return items
  },

  async cine24h(query, typeFilter = 'all') {
    const host = 'https://cine24h.online/'
    const searchUrl = `${host}?s=${encodeURIComponent(query)}`
    const data = await fetchHtml(searchUrl)
    if (!data) return []

    const items = []
    const matches = [...data.matchAll(/<article[^>]*>.*?<a href="([^"]+)".*?title="([^"]+)".*?(?:src="([^"]+)")?.*?<\/article>/gs)]

    for (const [, url, title, thumb] of matches) {
      if (!url.includes(host)) continue
      const tipo = /\/serie\//i.test(url) || /\/tv\//i.test(url) ? 'series' : 'movie'
      if (typeFilter !== 'all' && typeFilter !== tipo) continue

      const slug = url.endsWith('/') ? url.slice(0, -1).split('/').pop() : url.split('/').pop()
      items.push({
        id: `cine24h:${tipo}:${slug}`,
        title: title.replace(/&#8217;/g, "'").replace(/&#038;/g, "&"),
        type: tipo,
        poster: thumb || '',
        sourceUrl: url,
      })
    }

    return items
  },
}

// ── Plugin ─────────────────────────────────────────────────────────

const manifest = new PluginManifest({
  id: 'plurtasko-local',
  name: 'Plurtasko Local',
  version: '1.0.0',
  description: 'Películas y series (Alfa/Balandro style) — sin servidor externo',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  catalogs: [
    { id: 'gnula:movie', name: 'Gnula - Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'gnula:series', name: 'Gnula - Series', type: CONTENT_TYPES.SERIES },
    { id: 'cine24h:movie', name: 'Cine24h - Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'cine24h:series', name: 'Cine24h - Series', type: CONTENT_TYPES.SERIES },
  ],
})

export const plurtaskoLocalPlugin = createPlugin(manifest, {
  async getCatalogs() {
    return manifest.catalogs
  },

  async getCatalog({ id, skip = 0, top = 50 }) {
    const [channelId, type] = id.split(':')
    const channelFn = channels[channelId]
    if (!channelFn) return []

    const items = await channelFn('', type)
    return items.slice(skip, skip + top).map(i => ({
      id: i.id,
      type: i.type,
      name: i.title,
      title: i.title,
      poster: i.poster,
    }))
  },

  async getMeta({ id }) {
    const [, channelId, slug] = id.split(':')
    const channelFn = channels[channelId]
    if (!channelFn) return null

    const items = await channelFn('', channelId.includes('movie') ? 'movie' : 'series')
    const item = items.find(i => i.id === id)
    if (!item) return null

    const data = await fetchHtml(item.sourceUrl)
    const titleMatch = data.match(/<h1[^>]*>(.*?)<\/h1>/s)
    const posterMatch = data.match(/<img[^>]*src="([^"]+)"/)
    const descMatch = data.match(/<div class="[^"]*content[^"]*">.*?<p>(.*?)<\/p>/s)

    return {
      id: item.id,
      type: item.type,
      name: item.title,
      title: item.title,
      poster: posterMatch?.[1] || item.poster,
      description: descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '',
      year: '',
    }
  },

  async getStreams({ id }) {
    const [, channelId, slug] = id.split(':')
    const channelFn = channels[channelId]
    if (!channelFn) return []

    const items = await channelFn('', channelId.includes('movie') ? 'movie' : 'series')
    const item = items.find(i => i.id === id)
    if (!item) return []

    const data = await fetchHtml(item.sourceUrl)
    const streams = []

    const iframes = [...data.matchAll(/<iframe[^>]*src="([^"]+)"/g)]
    for (const [, iframeUrl] of iframes) {
      if (!iframeUrl.startsWith('http')) continue
      if (/youtube|youtu\.be|trailer/i.test(iframeUrl)) continue

      for (const [name, resolver] of Object.entries(resolvers)) {
        try {
          const resolved = await resolver(iframeUrl)
          for (const s of resolved) {
            streams.push({
              name: s.name || name,
              url: s.url,
              format: s.url.includes('.m3u8') ? 'm3u8' : 'mp4',
              quality: s.quality || '',
            })
          }
          if (streams.length) break
        } catch {}
      }
    }

    return streams
  },

  async search({ query }) {
    const results = []
    for (const [name, channelFn] of Object.entries(channels)) {
      try {
        const items = await channelFn(query, 'all')
        for (const item of items.slice(0, 10)) {
          results.push({
            id: item.id,
            type: item.type,
            name: item.title,
            title: item.title,
            poster: item.poster,
          })
        }
      } catch {}
    }
    return results
  },
})

export default plurtaskoLocalPlugin
