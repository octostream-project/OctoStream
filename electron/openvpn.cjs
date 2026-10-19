// RiseupVPN por OpenVPN del sistema (Linux): la app genera el .ovpn
// (src/utils/riseupVpn.js) y aquí se levanta el túnel tun0 vía pkexec —
// polkit pide autorización una vez por sesión. El proceso es hijo del
// main: al cerrar OctoStream el túnel muere con él (sin daemon root
// huérfano). Una vez arriba, aether/WARP enruta por la VPN solo — sus
// sockets UDP siguen la tabla de rutas del sistema.
'use strict'
const { spawn, execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const state = { proc: null, connecting: false, connected: false, error: '', log: '' }

function findOpenvpn() {
  const candidates = (process.env.PATH || '').split(path.delimiter)
    .map(d => path.join(d, 'openvpn'))
    .concat(['/usr/sbin/openvpn', '/usr/bin/openvpn', '/sbin/openvpn'])
  return candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false } }) || null
}

function which(cmd) {
  return new Promise((resolve) => {
    execFile('which', [cmd], (e, out) => resolve(e ? null : (out || '').trim() || null))
  })
}

async function installOpenvpn() {
  if (process.platform !== 'linux') return { installed: false, error: 'solo Linux' }
  const pkexec = await which('pkexec')
  if (!pkexec) return { installed: false, error: 'sin pkexec (polkit)' }
  const pm = await which('pacman') ? ['pacman', '-S', '--noconfirm', 'openvpn']
    : await which('apt-get') ? ['apt-get', 'install', '-y', 'openvpn']
    : await which('dnf') ? ['dnf', 'install', '-y', 'openvpn']
    : await which('zypper') ? ['zypper', '--non-interactive', 'install', 'openvpn']
    : null
  if (!pm) return { installed: false, error: 'gestor de paquetes no detectado' }
  return await new Promise((resolve) => {
    execFile(pkexec, pm, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) return resolve({ installed: false, error: (stderr || err.message || '').trim() })
      resolve({ installed: true, output: (stdout || '').trim().slice(-300) })
    })
  })
}

async function connect(confText) {
  if (process.platform !== 'linux') return { status: 'error', error: 'OpenVPN embebido solo en Linux — en Windows exporta el .ovpn' }
  if (state.connected || state.connecting) return { status: state.connected ? 'connected' : 'connecting' }
  const bin = findOpenvpn()
  if (!bin) return { status: 'error', error: 'no-openvpn' }
  const pkexec = await which('pkexec')
  if (!pkexec) return { status: 'error', error: 'sin pkexec (polkit) — instala policykit' }

  state.connecting = true
  state.error = ''
  state.log = ''
  // El .ovpn lleva la clave privada inline → tmp con 0600 y se borra al salir.
  const confPath = path.join(os.tmpdir(), `octostream-riseup-${process.pid}.conf`)
  try {
    fs.writeFileSync(confPath, confText, { mode: 0o600 })
    // --route-noexec evita que el tun capture el tráfico hasta que el
    // handshake va — no, lo dejamos enrutar todo: es una capa de
    // seguridad sistema-completo (la app incluida, aether sale por aquí).
    const proc = spawn(pkexec, [bin, '--config', confPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    state.proc = proc
    proc.on('exit', () => {
      if (state.proc === proc) {
        state.proc = null
        state.connected = false
        state.connecting = false
        try { fs.unlinkSync(confPath) } catch {}
      }
    })
    const onData = (c) => {
      const s = c.toString()
      state.log = (state.log + s).slice(-8192)
      for (const line of s.split('\n')) {
        if (/error|warn|Sequence Completed|TUN|TAP|AUTH/i.test(line)) console.log('[OpenVPN]', line.trim())
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)

    // Esperar "Initialization Sequence Completed" o muerte (máx. 45s).
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break
      if (/Initialization Sequence Completed/.test(state.log)) {
        state.connected = true
        state.connecting = false
        return { status: 'connected' }
      }
      if (/AUTH_FAILED|Cannot ioctl|ERROR/.test(state.log)) break
      await new Promise(r => setTimeout(r, 400))
    }
    const tail = state.log.trim().split('\n').slice(-2).join(' | ')
    throw new Error(proc.exitCode !== null ? `openvpn salió code=${proc.exitCode}: ${tail}` : `timeout 45s: ${tail}`)
  } catch (e) {
    state.error = e.message
    state.connecting = false
    if (state.proc) { try { state.proc.kill() } catch {} state.proc = null }
    try { fs.unlinkSync(confPath) } catch {}
    return { status: 'error', error: e.message }
  }
}

function disconnect() {
  if (state.proc) { try { state.proc.kill() } catch {} state.proc = null }
  state.connected = false
  state.connecting = false
  return { status: 'disconnected' }
}

function status() {
  return {
    connected: state.connected,
    connecting: state.connecting,
    running: !!state.proc,
    hasOpenvpn: !!findOpenvpn(),
    error: state.error,
  }
}

module.exports = { connect, disconnect, status, installOpenvpn }
