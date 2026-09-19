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
  'https://git.disroot.org/aka.kuro/OctoStream/raw/branch/main/version.json'

let lastCheck = null

/**
 * Returns an update descriptor when a newer versionCode is published:
 *   {versionName, notes, apkUrl, sha256, force}
 * or null when up-to-date / check fails / not Android.
 */
export async function checkForUpdate({ manifestUrl = UPDATE_MANIFEST_URL } = {}) {
  if (!isAndroidNative()) return null
  // Al menos 1h entre checks para no martillear el repo en cada arranque.
  if (lastCheck && Date.now() - lastCheck < 60 * 60 * 1000) return null
  lastCheck = Date.now()
  try {
    const [manifest, app] = await Promise.all([
      httpGetJson(manifestUrl, { Accept: 'application/json' }),
      AppUpdater.getAppVersion(),
    ])
    if (!manifest || !app) return null
    if (!(manifest.versionCode > app.versionCode)) return null
    if (!manifest.apkUrl || !manifest.apkUrl.startsWith('https://')) return null
    return {
      versionCode: manifest.versionCode,
      versionName: manifest.versionName || String(manifest.versionCode),
      notes: manifest.notes || '',
      apkUrl: manifest.apkUrl,
      sha256: manifest.sha256 || '',
      force: (manifest.minCode || 0) > app.versionCode,
    }
  } catch {
    return null
  }
}

export { AppUpdater }
