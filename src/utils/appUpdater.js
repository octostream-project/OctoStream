// In-app updater: checks a version.json manifest on the repo, compares
// versionCode with the installed APK and drives download + install through
// the AppUpdater Capacitor plugin. Follows the FCTV model:
//   manifest {versionCode, versionName, minCode, apkUrl, sha256, notes}
//   minCode > installed  → forced update (no cancel)
// Web/Electron: no-op.

import AppUpdater from '@optopus/app-updater'
import { isAndroidNative } from './platform.js'
import { httpGetJson } from './httpClient.js'

export const UPDATE_MANIFEST_URL =
  'https://raw.githubusercontent.com/octostream-project/OctoStream/main/version.json'

let lastCheck = null

/**
 * Returns an update descriptor when a newer versionCode is published:
 *   {versionName, notes, apkUrl, sha256, force}
 * or null when up-to-date / check fails / not Android.
 */
export async function checkForUpdate({ manifestUrl = UPDATE_MANIFEST_URL, force = false } = {}) {
  if (!isAndroidNative()) return null
  // Al menos 1h entre checks para no martillear el repo en cada arranque.
  // force: "Buscar actualización" manual en Ajustes — ignora el throttle.
  if (force) lastCheck = null
  if (lastCheck && Date.now() - lastCheck < 60 * 60 * 1000) return null
  lastCheck = Date.now()
  try {
    const [manifest, app] = await Promise.all([
      httpGetJson(manifestUrl, { Accept: 'application/json' }),
      AppUpdater.getAppVersion(),
    ])
    if (!manifest || !app) return null
    if (!(manifest.versionCode > app.versionCode)) return null
    // APK por ABI: el manifiesto puede llevar apkUrls{abi:url}+sha256s{abi:sha}.
    // Se prueban los ABIs del dispositivo en orden de preferencia; si el
    // manifiesto no tiene mapa (releases antiguas) se usa apkUrl/sha256.
    const abis = String(app.abis || '').split(',').filter(Boolean)
    let apkUrl = null
    let sha256 = ''
    if (manifest.apkUrls && typeof manifest.apkUrls === 'object') {
      const abi = abis.find(a => manifest.apkUrls[a])
      if (abi) {
        apkUrl = manifest.apkUrls[abi]
        sha256 = (manifest.sha256s && manifest.sha256s[abi]) || ''
      }
    }
    if (!apkUrl) {
      apkUrl = manifest.apkUrl
      sha256 = manifest.sha256 || ''
    }
    if (!apkUrl || !apkUrl.startsWith('https://')) return null
    // certSha256: huella del certificado que firma la nueva APK. Si difiere de
    // la firma instalada el update normal falla — hace falta reinstalar.
    let certSha256 = manifest.certSha256 || null
    let signatureMismatch = false
    if (certSha256) {
      const sig = await AppUpdater.getAppSignature().catch(() => null)
      signatureMismatch = Boolean(sig?.sha256) && sig.sha256 !== certSha256.toLowerCase()
    }
    return {
      versionCode: manifest.versionCode,
      versionName: manifest.versionName || String(manifest.versionCode),
      notes: manifest.notes || '',
      apkUrl,
      sha256,
      certSha256,
      signatureMismatch,
      force: (manifest.minCode || 0) > app.versionCode,
    }
  } catch {
    return null
  }
}

export { AppUpdater }
