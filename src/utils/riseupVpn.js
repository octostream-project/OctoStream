// RiseupVPN: genera un perfil OpenVPN (.ovpn) con certificado de cliente
// fresco — port JS del script generate.sh de BarbossHack/RiseupVPN-OpenVPN.
// Riseup es una VPN gratuita, sin cuenta y sin logs (https://riseup.net/en/vpn).
//
// El .ovpn resultante se abre con el cliente OpenVPN del sistema (OpenVPN
// Connect / OpenVPN for Android / NetworkManager): en Android el plugin
// CloudProxy lo sirve por FileProvider + ACTION_VIEW; en escritorio se
// guarda/abre por IPC.
//
// La API de riseup (api.black.riseup.net) puede ser MUY lenta — timeouts
// generosos y reintentos como en el script original.

import { httpGetText, httpGetJson } from './httpClient.js'
import { isAndroidNative } from './platform.js'

const CERT_URL = 'https://api.black.riseup.net/3/cert'
const CA_URL = 'https://black.riseup.net/ca.crt'
const GATEWAYS_URL = 'https://api.black.riseup.net/3/config/eip-service.json'

// Plantilla base (riseup-ovpn.sample.conf del repo). Los `remote <ip> <port>`
// se insertan antes de `remote-random` — el script original los añade
// comentados con host+ubicación para depurar.
const TEMPLATE = `client

dev tun
proto tcp
nobind

# Riseup available servers
remote <IP> <PORT>
remote-random

# Quick reconnect
persist-key
persist-tun
pull-filter ignore "ping"
pull-filter ignore "ping-restart"
pull-filter ignore "keepalive"
keepalive 10 20
server-poll-timeout 10
connect-retry 1 2
connect-retry-max 1

# Cipher
cipher AES-256-GCM
data-ciphers AES-256-GCM
remote-cert-tls server

verb 1
`

// Extrae el bloque PEM cuyo BEGIN casa con el prefijo (ej. "BEGIN RSA" cubre
// "BEGIN RSA PRIVATE KEY"; "BEGIN CERTIFICATE" el cert). Devuelve el bloque
// con las líneas BEGIN/END incluidas.
function pemBlock(pem, beginPrefix) {
  const re = new RegExp(`-----${beginPrefix}[^-]*-----[\\s\\S]*?-----END [^-]*-----`, 'i')
  const m = pem.match(re)
  return m ? m[0].trim() : ''
}

async function fetchWithRetry(fn, tries = 3) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) { lastErr = e }
  }
  throw lastErr
}

// Servidor fijo Riseup: Francia, mismo IP de salida en TODOS los
// dispositivos. vpn02-par si está en la lista; si cae, el primer
// gateway de París que publique la API (orden determinista — todos
// los dispositivos convergen en el mismo).
const FRANCE_GW_IP = '51.159.197.108' // vpn02-par.riseup.net

/**
 * Genera un perfil .ovpn de RiseupVPN con certificado de cliente nuevo.
 * @param {{noIpv6?: boolean, singleRemote?: boolean, signal?: AbortSignal}} opts
 * @returns {Promise<{conf: string, gateways: number}>}
 */
export async function generateRiseupOvpn(opts = {}) {
  const { noIpv6 = false, singleRemote = true, signal } = opts
  // 1. Cert de cliente (clave privada + cert en un solo PEM) + CA.
  //    La API de riseup es lenta a veces — reintenta como el script.
  const [keyCert, caCert, eip] = await Promise.all([
    fetchWithRetry(() => httpGetText(CERT_URL, { Accept: 'text/html' }, signal)),
    fetchWithRetry(() => httpGetText(CA_URL, { Accept: 'text/html' }, signal)),
    fetchWithRetry(() => httpGetJson(GATEWAYS_URL, { Accept: 'application/json' }, signal)),
  ])
  const key = pemBlock(keyCert, 'BEGIN RSA')
  const cert = pemBlock(keyCert, 'BEGIN CERTIFICATE')
  const ca = pemBlock(caCert, 'BEGIN CERTIFICATE')
  if (!key || !cert || !ca) throw new Error('La API de Riseup no devolvió los certificados')

  // 2. Gateways con transporte openvpn → líneas `remote <ip> <port>`.
  const gateways = Array.isArray(eip?.gateways) ? eip.gateways : []
  const entries = []
  for (const g of gateways) {
    const ip = g?.ip_address
    if (!ip) continue
    const transports = Array.isArray(g?.capabilities?.transport) ? g.capabilities.transport : []
    for (const t of transports) {
      if (!String(t?.type || '').includes('openvpn')) continue
      for (const port of t?.ports || []) {
        entries.push({
          line: `remote ${ip} ${port} # ${g.host || ''} (${g.location || ''})`,
          ip, host: g.host || '', location: g.location || '', port,
        })
      }
    }
  }
  if (!entries.length) throw new Error('Riseup no devolvió gateways OpenVPN')

  // 3. Remotes: con singleRemote (defecto) → UN gateway de Francia, la
  //    misma IP de salida para todo dispositivo. Puerto 1194 preferido.
  let chosenRemotes
  if (singleRemote) {
    const fr = entries.filter(e => /paris|france/i.test(e.location) || /-par\./i.test(e.host))
    const pick =
      entries.find(e => e.ip === FRANCE_GW_IP && String(e.port) === '1194') ||
      fr.find(e => String(e.port) === '1194') || fr[0] ||
      entries.find(e => String(e.port) === '1194') || entries[0]
    chosenRemotes = [pick.line]
  } else {
    chosenRemotes = entries.map(e => e.line)
  }
  let conf = TEMPLATE.replace(/remote <IP> <PORT>\n/, chosenRemotes.join('\n') + '\n')
  if (singleRemote) conf = conf.replace('remote-random\n', '')
  if (noIpv6) {
    conf += `
# Disable IPv6
pull-filter ignore "tun-ipv6"
pull-filter ignore "route-ipv6"
pull-filter ignore "ifconfig-ipv6"
pull-filter ignore "redirect-gateway"
block-ipv6
redirect-gateway def1
`
  }
  conf += `\n<key>\n${key}\n</key>\n\n<cert>\n${cert}\n</cert>\n\n<ca>\n${ca}\n</ca>\n`
  return { conf, gateways: entries.length }
}

/**
 * Genera el perfil RiseupVPN y lo entrega al sistema:
 * - Android → FileProvider + ACTION_VIEW (OpenVPN Connect / OpenVPN for
 *   Android importan el .ovpn; sin cliente instalado cae a ACTION_SEND).
 * - Electron → diálogo de guardado del .ovpn (+ en Linux se puede importar
 *   a NetworkManager por separado).
 * - Web → descarga del archivo.
 * Devuelve info del resultado para que la UI pueda informar.
 */
export async function openRiseupProfile(opts = {}) {
  const { conf, gateways } = await generateRiseupOvpn(opts)
  const name = 'riseup-ovpn.conf'
  if (isAndroidNative()) {
    const { CloudProxy } = await import('@octostream/cloud-proxy')
    const r = await CloudProxy.exportOvpn({ config: conf, name })
    return { ...r, gateways }
  }
  const bridge = window.octostream?.riseup
  if (bridge) {
    const r = await bridge.save(conf)
    return { opened: !!r.saved, path: r.path, error: r.error, gateways }
  }
  // Web: descarga del .ovpn.
  const blob = new Blob([conf], { type: 'application/x-openvpn-profile' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
  return { opened: true, gateways }
}

/** En Linux: importar el perfil a NetworkManager (nmcli). Otros SO → false. */
export async function importRiseupToNetworkManager(opts = {}) {
  const { conf } = await generateRiseupOvpn(opts)
  const bridge = window.octostream?.riseup
  if (!bridge?.import) return { imported: false, error: 'no disponible' }
  return bridge.import(conf)
}

/**
 * Levanta el túnel RiseupVPN:
 * - Android → API remota de OpenVPN for Android (de.blinkt.openvpn):
 *   importa el perfil y lo arranca — VPN sistema-completo gestionada
 *   desde la app (el usuario autoriza una vez el acceso remoto).
 * - Linux/Electron → openvpn del sistema vía pkexec (tun0).
 * En ambos casos aether/WARP enruta por el túnel automáticamente.
 * status: connected | consent | need-vpn-permission | no-engine
 */
export async function connectRiseupTunnel(opts = {}) {
  const { conf, gateways } = await generateRiseupOvpn({ ...opts, singleRemote: true })
  if (isAndroidNative()) {
    const { CloudProxy } = await import('@octostream/cloud-proxy')
    const r = await CloudProxy.riseupConnect({ config: conf })
    return { ...r, gateways }
  }
  const bridge = window.octostream?.riseup
  if (!bridge?.connect) return { status: 'no-engine' }
  const r = await bridge.connect(conf)
  return { ...r, gateways }
}

export async function disconnectRiseupTunnel() {
  if (isAndroidNative()) {
    const { CloudProxy } = await import('@octostream/cloud-proxy')
    return CloudProxy.riseupDisconnect()
  }
  return window.octostream?.riseup?.disconnect?.() ?? { status: 'no-engine' }
}

export async function riseupTunnelStatus() {
  if (isAndroidNative()) {
    try {
      const { CloudProxy } = await import('@octostream/cloud-proxy')
      const s = await CloudProxy.riseupTunnelStatus()
      return {
        connected: !!s.connected,
        connecting: !!s.connecting,
        hasOpenvpn: !!s.installed,
        embedded: !!s.embedded,
        error: s.error || '',
      }
    } catch {
      return { connected: false, connecting: false, hasOpenvpn: false }
    }
  }
  return window.octostream?.riseup?.status?.() ?? { connected: false, connecting: false, hasOpenvpn: false }
}

/** Instala openvpn del gestor de paquetes (Linux, pkexec) si no está. */
export async function installOpenvpn() {
  return window.octostream?.riseup?.install?.() ?? { installed: false, error: 'no disponible' }
}
