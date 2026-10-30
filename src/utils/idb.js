// Minimal IndexedDB wrapper — object store 'kv' (keyPath k).
// Usado por storage.js como espejo durable de localStorage y área de
// desbordamiento cuando la cuota de ~5MB se llena. Sin dependencias.

let _dbPromise = null
function db() {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('octostream', 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kv')) {
        req.result.createObjectStore('kv', { keyPath: 'k' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { _dbPromise = null; reject(req.error) }
    req.onblocked = () => { _dbPromise = null; reject(new Error('idb blocked')) }
  })
  return _dbPromise
}

export async function idbSet(k, v) {
  try {
    const d = await db()
    await new Promise((res, rej) => {
      const t = d.transaction('kv', 'readwrite')
      t.objectStore('kv').put({ k, v })
      t.oncomplete = res
      t.onerror = () => rej(t.error)
    })
  } catch { /* idb no disponible — el caller sigue con localStorage */ }
}

export async function idbDel(k) {
  try {
    const d = await db()
    await new Promise((res, rej) => {
      const t = d.transaction('kv', 'readwrite')
      t.objectStore('kv').delete(k)
      t.oncomplete = res
      t.onerror = () => rej(t.error)
    })
  } catch { /* idb no disponible */ }
}

// Todas las entradas como Map<k, v> — para la hidratación del arranque.
export async function idbAll() {
  try {
    const d = await db()
    return await new Promise((res) => {
      const t = d.transaction('kv', 'readonly')
      const r = t.objectStore('kv').getAll()
      r.onsuccess = () => res(new Map((r.result || []).map(e => [e.k, e.v])))
      r.onerror = () => res(new Map())
    })
  } catch { return new Map() }
}
