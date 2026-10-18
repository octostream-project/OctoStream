// DLNA "Enviar a TV" — equivalente escritorio del openDlna() del plugin
// Android: descubre renderers UPnP por SSDP (M-SEARCH a 239.255.255.250:1900)
// y les manda el stream por AVTransport SetAVTransportURI + Play.
// Sirve para Smart TV, TV Box, Chromecast (modo DIAL/UPnP) y consolas —
// cualquier dispositivo de la LAN con AVTransport.

const dgram = require('dgram')
const http = require('http')

const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
const AVTRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1'

const M_SEARCH =
  'M-SEARCH * HTTP/1.1\r\n' +
  `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
  'MAN: "ssdp:discover"\r\n' +
  'MX: 2\r\n' +
  `ST: ${AVTRANSPORT}\r\n` +
  '\r\n'

function httpGet(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const next = /^https?:/i.test(res.headers.location)
          ? res.headers.location : new URL(res.headers.location, url).href
        httpGet(next, timeoutMs).then(resolve, reject)
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
  })
}

function soapPost(controlUrl, action, body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(controlUrl) } catch { return resolve({ ok: false }) }
    const payload =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:${action} xmlns:u="${AVTRANSPORT}">${body}</u:${action}></s:Body></s:Envelope>`
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(payload),
        'SOAPAction': `"${AVTRANSPORT}#${action}"`,
      },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }) })
    req.on('error', () => resolve({ ok: false }))
    req.end(payload)
  })
}

// Extrae <friendlyName> y el controlURL del servicio AVTransport del XML de
// descripción UPnP.
function parseDescription(xml, locationUrl) {
  const name = (xml.match(/<friendlyName>([^<]*)<\/friendlyName>/i) || [])[1] || 'TV'
  const svcRe = /<service>([\s\S]*?)<\/service>/gi
  let m
  while ((m = svcRe.exec(xml))) {
    const block = m[1]
    if (!/AVTransport/i.test(block)) continue
    const ctrl = (block.match(/<controlURL>([^<]*)<\/controlURL>/i) || [])[1]
    const type = (block.match(/<serviceType>([^<]*)<\/serviceType>/i) || [])[1]
    if (!ctrl) continue
    let controlUrl = ctrl
    if (!/^https?:/i.test(ctrl)) {
      try { controlUrl = new URL(ctrl, locationUrl).href } catch { continue }
    }
    return { name, controlUrl, serviceType: type || AVTRANSPORT }
  }
  return null
}

// Descubre renderers DLNA en la LAN durante `timeoutMs` (3.5s por defecto).
function scan(timeoutMs = 3500) {
  return new Promise((resolve) => {
    const locations = new Map() // location → {location, address}
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const done = async () => {
      try { sock.close() } catch {}
      const devices = []
      const jobs = [...locations.values()].map(async ({ location, address }) => {
        try {
          const { body } = await httpGet(location)
          const svc = parseDescription(body, location)
          if (svc) devices.push({ name: svc.name, location, controlUrl: svc.controlUrl, serviceType: svc.serviceType, address })
        } catch {}
      })
      await Promise.all(jobs)
      resolve(devices)
    }
    const timer = setTimeout(done, timeoutMs)
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8')
      if (!/^HTTP\/1\.[01] 200/i.test(text) && !/^NOTIFY/i.test(text)) return
      const loc = (text.match(/^LOCATION:\s*(.+)$/im) || [])[1]
      if (loc) locations.set(loc.trim(), { location: loc.trim(), address: rinfo.address })
    })
    sock.on('error', () => { clearTimeout(timer); resolve([]) })
    try {
      sock.bind(0, () => {
        try { sock.addMembership(SSDP_ADDR) } catch {}
        sock.send(M_SEARCH, SSDP_PORT, SSDP_ADDR, () => {})
        // Segundo envío: algunos renderers pierden el primero.
        setTimeout(() => { try { sock.send(M_SEARCH, SSDP_PORT, SSDP_ADDR, () => {}) } catch {} }, 800)
      })
    } catch { clearTimeout(timer); resolve([]) }
  })
}

function escapeXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Manda el stream a un renderer: SetAVTransportURI con metadatos DIDL-Lite
// (título + clase de vídeo) y Play.
async function play({ controlUrl, url, title = 'OctoStream' } = {}) {
  if (!controlUrl || !/^https?:/i.test(url || '')) return { sent: false }
  const didl =
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    `<item id="0" parentID="-1" restricted="1"><dc:title>${escapeXml(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="http-get:*:video/*:*">${escapeXml(url)}</res></item></DIDL-Lite>`
  const setBody =
    '<InstanceID>0</InstanceID>' +
    `<CurrentURI>${escapeXml(url)}</CurrentURI>` +
    `<CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>`
  const set = await soapPost(controlUrl, 'SetAVTransportURI', setBody)
  if (!set.ok) return { sent: false, stage: 'set', status: set.status }
  const play = await soapPost(controlUrl, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>')
  return { sent: play.ok !== false, stage: 'play', status: play.status }
}

// Superficie equivalente al openDlna() Android: escanea y manda al primer
// renderer encontrado (los hogares suelen tener una sola TV encendida).
async function scanAndPlay({ url, title, timeoutMs = 3500 } = {}) {
  const devices = await scan(timeoutMs)
  if (!devices.length) return { sent: false, devices: 0 }
  for (const dev of devices) {
    const r = await play({ controlUrl: dev.controlUrl, url, title })
    if (r.sent) return { sent: true, device: dev.name, devices: devices.length }
  }
  return { sent: false, devices: devices.length }
}

module.exports = { scan, play, scanAndPlay }
