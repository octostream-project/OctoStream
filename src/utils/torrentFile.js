// .torrent → magnet conversion.
// A .torrent file is bencoded; the infohash is the SHA-1 of the raw bytes of
// the top-level "info" dictionary. We decode just enough bencode to locate the
// exact byte span of that dict, hash it, and build a magnet: URI. The "dn"
// display name and tracker list are added when present.

import { httpGetBlob } from './httpClient.js'

// Minimal bencode scanner over a Uint8Array. Returns for each parsed value its
// span [start, end) so the raw "info" dict bytes can be hashed verbatim.
function scanValue(bytes, pos) {
  const c = bytes[pos]
  if (c === 0x69) { // 'i' — integer: i<digits>e
    const end = bytes.indexOf(0x65, pos) // 'e'
    if (end < 0) throw new Error('bad bencode integer')
    return end + 1
  }
  if (c >= 0x30 && c <= 0x39) { // digit — byte string: <len>:<data>
    let len = 0
    let p = pos
    while (bytes[p] !== 0x3a) { // ':'
      if (p >= bytes.length) throw new Error('bad bencode string')
      const d = bytes[p] - 0x30
      if (d < 0 || d > 9) throw new Error('bad bencode length')
      len = len * 10 + d
      p++
    }
    const end = p + 1 + len
    if (end > bytes.length) throw new Error('bencode string out of bounds')
    return end
  }
  if (c === 0x6c || c === 0x64) { // 'l' list or 'd' dict
    let p = pos + 1
    while (bytes[p] !== 0x65) { // 'e' terminator
      if (p >= bytes.length) throw new Error('unterminated bencode dict')
      p = scanValue(bytes, p)
    }
    return p + 1
  }
  throw new Error('bad bencode at ' + pos)
}

// Read a bencoded byte string starting at pos. Returns { str, end }.
function readString(bytes, pos) {
  let len = 0
  let p = pos
  while (bytes[p] !== 0x3a) {
    if (p >= bytes.length) throw new Error('bad bencode string')
    const d = bytes[p] - 0x30
    if (d < 0 || d > 9) throw new Error('bad bencode length')
    len = len * 10 + d
    p++
  }
  const start = p + 1
  const end = start + len
  if (end > bytes.length) throw new Error('bencode string out of bounds')
  return { str: new TextDecoder('latin1').decode(bytes.subarray(start, end)), end }
}

// Extract the raw byte span of the top-level "info" dict plus announce/name.
function parseTorrent(bytes) {
  if (bytes[0] !== 0x64) throw new Error('not a bencoded dict')
  let pos = 1
  let infoSpan = null
  let name = ''
  const trackers = []
  while (bytes[pos] !== 0x65) {
    if (pos >= bytes.length) throw new Error('unterminated torrent dict')
    const key = readString(bytes, pos)
    pos = key.end
    const valueStart = pos
    if (key.str === 'info') {
      pos = scanValue(bytes, pos)
      infoSpan = [valueStart, pos]
    } else {
      if (key.str === 'announce') {
        const r = readString(bytes, pos)
        if (r.str.startsWith('http') || r.str.startsWith('udp')) trackers.push(r.str)
      }
      pos = scanValue(bytes, pos)
    }
  }
  if (!infoSpan) throw new Error('torrent sin diccionario info')
  // display name lives inside info.name — cheap second pass over the info dict
  try {
    const inner = bytes.subarray(infoSpan[0], infoSpan[1])
    if (inner[0] === 0x64) {
      let p = 1
      while (inner[p] !== 0x65) {
        if (p >= inner.length) break
        const key = readString(inner, p)
        p = key.end
        if (key.str === 'name') name = readString(inner, p).str
        p = scanValue(inner, p)
      }
    }
  } catch {}
  return { infoSpan, name, trackers }
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Convert raw .torrent bytes to a magnet URI.
export async function torrentBytesToMagnet(bytes) {
  const { infoSpan, name, trackers } = parseTorrent(bytes)
  const hash = await crypto.subtle.digest('SHA-1', bytes.subarray(infoSpan[0], infoSpan[1]))
  let magnet = 'magnet:?xt=urn:btih:' + toHex(hash)
  if (name) magnet += '&dn=' + encodeURIComponent(name)
  for (const tr of trackers.slice(0, 5)) magnet += '&tr=' + encodeURIComponent(tr)
  return magnet
}

// Trackers públicos estables (el mismo estilo de lista que inyecta Peerflix a
// cada infoHash). Los magnets que vienen de los indexers suelen traer 0-2
// trackers — sin ellos el motor P2P depende solo de DHT y tarda en encontrar
// peers, sobre todo en torrents poco sembrados.
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.ducks.party:1984/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'udp://tracker.0x7c0.com:6969/announce',
  'http://tracker.dler.org:6969/announce',
  'udp://tracker.farted.net:6969/announce',
  'udp://tracker.peerfect.org:6969/announce',
]

// Añade los trackers por defecto a un magnet que traiga pocos o ninguno.
// Si el magnet ya trae >=3 trackers propios se respeta tal cual.
export function withDefaultTrackers(magnetUrl) {
  if (!magnetUrl || !magnetUrl.startsWith('magnet:')) return magnetUrl
  const existing = new Set()
  for (const m of magnetUrl.matchAll(/[?&]tr=([^&]+)/g)) {
    try { existing.add(decodeURIComponent(m[1])) } catch { existing.add(m[1]) }
  }
  if (existing.size >= 3) return magnetUrl
  let out = magnetUrl
  for (const tr of DEFAULT_TRACKERS) {
    if (!existing.has(tr)) out += '&tr=' + encodeURIComponent(tr)
  }
  return out
}

// Fetch a .torrent URL and convert it to a magnet URI. Returns null on failure.
// httpGetBlob devuelve un Blob en web/Electron pero un string base64 en
// Android (CapacitorHttp): hay que manejar ambos o la conversión siempre
// fallaba en Android y el torrent nunca llegaba a Debrid.
export async function torrentUrlToMagnet(url, signal) {
  try {
    const data = await httpGetBlob(url, {}, signal)
    let bytes
    if (typeof data === 'string') {
      const bin = atob(data)
      bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    } else {
      if (!data || data.size < 20 || data.size > 20 * 1024 * 1024) return null
      bytes = new Uint8Array(await data.arrayBuffer())
    }
    if (bytes.length < 20 || bytes.length > 20 * 1024 * 1024) return null
    return await torrentBytesToMagnet(bytes)
  } catch {
    return null
  }
}
