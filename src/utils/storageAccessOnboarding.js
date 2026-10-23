const PROMPT_KEY = 'octostream_storage_access_prompted_version'
const FIRST_PROMPT_VERSION = 2094

function bounded(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

// Android grants MANAGE_EXTERNAL_STORAGE in Settings, not a runtime dialog.
// Mark before launching Settings so returning/recreating the Activity cannot
// trigger another prompt. A failed status check can be retried next launch.
export async function promptStorageAccessOnce({ getVersion, getEngine, storage }) {
  const { versionCode } = await bounded(getVersion(), 4000)
  if (!Number.isFinite(versionCode) || versionCode < FIRST_PROMPT_VERSION) return 'unsupported'
  if (storage.getItem(PROMPT_KEY) === String(versionCode)) return 'already-prompted'
  const engine = await bounded(getEngine(), 4000)
  if (!engine?.getStorageAccess || !engine?.requestStorageAccess) return 'unavailable'
  const { granted } = await bounded(engine.getStorageAccess(), 4000)
  if (granted) return 'granted'
  storage.setItem(PROMPT_KEY, String(versionCode))
  // El diálogo runtime + la pantalla all-files pueden tardar lo que tarde
  // el usuario en responder; el timeout solo cubre una llamada que no vuelva.
  const result = await bounded(engine.requestStorageAccess(), 120000)
  return result?.opened ? 'opened' : result?.granted ? 'granted' : 'unavailable'
}
