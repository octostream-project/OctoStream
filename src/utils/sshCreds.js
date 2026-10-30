// Credenciales SSH del VPS portables: en Android la clave vive cifrada en
// el plugin nativo (Android Keystore) y localStorage solo tiene host/user/
// port — hay que pedirla al plugin para poder transferirla. En Electron/
// web todo sigue en localStorage como un ajuste más.
//
// Se usan en dos direcciones:
//   sshCredsForTransfer()  → inyectar en payloads de sync y backup
//   applyReceivedSshCreds() → al recibir: sube la clave al Keystore y la
//                             borra de localStorage (solo Android)

import { isAndroidNative } from './platform.js'
import { CloudProxy } from './cloudProxy.js'

export const SSH_KEYS = {
  host: 'octostream_warp_remote',
  user: 'octostream_warp_ssh_user',
  pass: 'octostream_warp_ssh_pass',
  port: 'octostream_warp_ssh_port',
}
export const SSH_KEY_LIST = Object.values(SSH_KEYS)

// Devuelve {key: value} de las credenciales SSH presentes — las claves
// octostream_* del transporte para que encajen en settings del payload.
export async function sshCredsForTransfer() {
  const out = {}
  for (const k of SSH_KEY_LIST) {
    const v = localStorage.getItem(k)
    if (v != null && v !== '') out[k] = v
  }
  if (isAndroidNative()) {
    try {
      const c = await CloudProxy.getRemoteSsh()
      if (c?.user) out[SSH_KEYS.user] = c.user
      if (c?.port) out[SSH_KEYS.port] = String(c.port)
      if (c?.pass) out[SSH_KEYS.pass] = c.pass
    } catch { /* credenciales ausentes o plugin no disponible */ }
  }
  return out
}

// Tras recibir un payload (sync entrante o importación de backup): en
// Android la clave recién escrita en localStorage se sube al almacén
// cifrado del plugin y se borra la copia en claro.
export async function applyReceivedSshCreds() {
  if (!isAndroidNative()) return
  const pass = localStorage.getItem(SSH_KEYS.pass)
  if (!pass) return
  try {
    await CloudProxy.setRemoteSsh({
      user: localStorage.getItem(SSH_KEYS.user) || '',
      pass,
      port: parseInt(localStorage.getItem(SSH_KEYS.port) || '22', 10) || 22,
    })
  } catch { /* credenciales ausentes o plugin no disponible */ }
  localStorage.removeItem(SSH_KEYS.pass)
}
