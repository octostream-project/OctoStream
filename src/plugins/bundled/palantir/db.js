// Access layer for the Palantir "moria" SQLite catalog.
// The database (~250MB) lives on the device and is queried natively through the
// @octostream/palantir Capacitor plugin — never loaded into JS memory.
import { Capacitor } from '@capacitor/core'
import Palantir from '@octostream/palantir'
import { fetchJson, withTimeout } from '../../utils.js'
import { getJsonSync, setJsonSync } from '../../../utils/storage.js'

const REPO_API = 'https://api.github.com/repos/Maniac2017/Mipal2025'
const REPO_RAW = 'https://raw.githubusercontent.com/Maniac2017/Mipal2025/main'
// moria_X_Y_Z.* files are tied to an addon version; our queries target the
// 3.3.x schema.
const DB_VERSION = '3_3_11'
const LAST_CHECK_KEY = 'palantir_last_update_check'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export function isAvailable() {
  return Capacitor.isNativePlatform?.() === true
}

/** Runs a SELECT and returns rows as plain objects keyed by column name. */
export async function query(sql, args = []) {
  const res = await Palantir.query({ sql, args })
  const cols = res.columns || []
  return (res.rows || []).map(row => {
    const o = {}
    for (let i = 0; i < cols.length; i++) o[cols[i]] = row[i]
    return o
  })
}

export async function decryptLinks(links) {
  const res = await Palantir.decryptLinks({ links })
  return res?.urls || []
}

export async function getStatus() {
  if (!isAvailable()) return { installed: false }
  try {
    return await Palantir.getStatus()
  } catch {
    return { installed: false }
  }
}

let installPromise = null

/**
 * Ensures moria.db exists; downloads and extracts it on first use.
 * Returns true when the database is ready.
 */
export async function ensureInstalled() {
  if (!isAvailable()) return false
  const status = await getStatus()
  if (status.installed) return true
  if (installPromise) return installPromise
  installPromise = (async () => {
    const url = await findZm3Url()
    const res = await withTimeout(Palantir.install({ url }), 10 * 60 * 1000, 'Palantir install timeout')
    return !!res?.ok
  })().finally(() => { installPromise = null })
  return installPromise
}

/** Locates the newest moria_*.zm3 in the repo (prefers the supported version). */
async function findZm3Url() {
  try {
    const files = await fetchJson(`${REPO_API}/contents`)
    const zm3 = (Array.isArray(files) ? files : [])
      .filter(f => /^moria_\d+_\d+_\d+\.zm3$/.test(f?.name || '') && f.download_url)
      .sort((a, b) => compareVersionNames(b.name, a.name))
    const exact = zm3.find(f => f.name === `moria_${DB_VERSION}.zm3`)
    return (exact || zm3[0])?.download_url || `${REPO_RAW}/moria_${DB_VERSION}.zm3`
  } catch {
    return `${REPO_RAW}/moria_${DB_VERSION}.zm3`
  }
}

function compareVersionNames(a, b) {
  const pa = a.match(/\d+/g)?.map(Number) || []
  const pb = b.match(/\d+/g)?.map(Number) || []
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

let updateChecked = false

/**
 * Background incremental update: applies any `.up` SQL scripts published after
 * the last applied commit date, or reinstalls the DB if a newer .zm3 exists.
 * Throttled to one check per CHECK_INTERVAL_MS; failures are non-fatal.
 */
export async function maybeUpdate() {
  if (!isAvailable() || updateChecked) return
  const lastCheck = Number(getJsonSync(LAST_CHECK_KEY, 0) || 0)
  if (Date.now() - lastCheck < CHECK_INTERVAL_MS) return
  updateChecked = true
  setJsonSync(LAST_CHECK_KEY, Date.now())
  try {
    const status = await getStatus()
    if (!status.installed) return
    const commits = await fetchJson(`${REPO_API}/commits?per_page=1`)
    const latest = commits?.[0]?.commit?.committer?.date?.slice(0, 19)
    if (!latest || latest <= (status.lastUpdate || '')) return

    const files = await fetchJson(`${REPO_API}/contents`)
    const list = Array.isArray(files) ? files : []
    const zm3 = list.find(f => f.name === `moria_${DB_VERSION}.zm3`)
    const ups = list.filter(f => /^moria_.*\.up$/.test(f?.name || '') && f.download_url)

    // Apply .up scripts oldest-commit first (mirrors the addon's get_moria).
    const pending = []
    for (const up of ups) {
      const info = await fetchJson(`${REPO_API}/commits?path=${encodeURIComponent(up.name)}&per_page=1`)
      const date = info?.[0]?.commit?.committer?.date?.slice(0, 19) || ''
      if (date > (status.lastUpdate || '')) pending.push({ url: up.download_url, date })
    }
    pending.sort((a, b) => (a.date < b.date ? -1 : 1))
    for (const up of pending) {
      const res = await fetch(up.url)
      if (!res.ok) continue
      const sql = p3b64decodeToUtf8(await res.text())
      if (sql.length > 10) {
        await Palantir.execScript({ sql })
        await Palantir.setLastUpdate({ date: up.date })
      }
    }
    // If the full archive was republished after our last update, reinstall.
    if (!pending.length && zm3?.download_url) {
      const info = await fetchJson(`${REPO_API}/commits?path=${encodeURIComponent(zm3.name)}&per_page=1`)
      const date = info?.[0]?.commit?.committer?.date?.slice(0, 19) || ''
      if (date > (status.lastUpdate || '')) {
        await Palantir.install({ url: zm3.download_url })
        await Palantir.setLastUpdate({ date })
      }
    }
  } catch (e) {
    console.warn('[Palantir] update check failed:', e?.message || e)
  }
}

// --- p3b64decode: upstream obfuscation for .up update scripts ----------------
// unquote -> strip '?' -> pad to a multiple of 4 -> split at len/4 ->
// reverse each part -> concat -> base64decode.
export function p3b64decodeToUtf8(value) {
  const bytes = p3b64decodeBytes(value)
  return new TextDecoder('utf-8').decode(bytes)
}

function p3b64decodeBytes(value) {
  let s = decodeURIComponent(String(value)).replace(/\?/g, '')
  let pad = ''
  let len = s.length
  if (len % 4) {
    const p = 4 - (len % 4)
    len += p
    pad = '='.repeat(p)
  }
  const q = Math.floor(len / 4)
  const rev = str => str.split('').reverse().join('')
  const joined = rev(s.slice(0, q)) + rev(s.slice(q)) + pad
  const bin = atob(joined)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
