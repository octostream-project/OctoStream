// Cross-platform storage abstraction over localStorage.
// En Electron el localStorage del renderer ya persiste en userData;
// no hace falta espejo por IPC.
// All functions are safe to call at module load time (no top-level access).
//
// Espejo IndexedDB (idb.js): cada escritura/borrado de claves octostream_*
// y localpos_* se replica asíncronamente — backup durable que sobrevive al
// borrado de localStorage por el WebView y área de desbordamiento cuando
// la cuota de ~5MB se llena. localStorage sigue siendo la fuente de
// verdad síncrona; el espejo NUNCA borra datos por sí solo.

import { idbSet, idbDel, idbAll } from './idb.js'

// Claves que se espejan: todo lo namespaced de la app + las posiciones
// de reproducción localpos_* (crecen sin límite — el cerdo real de cuota).
const _isShadowKey = (key) =>
  typeof key === 'string' && (key.startsWith('octostream_') || key.startsWith('localpos_'))

// Overflow: claves cuya escritura en localStorage falló por cuota y viven
// solo en IndexedDB — hidratadas en memoria por initStorageMirror().
const _idbOnly = new Map()

// Hidratación al arranque (main.jsx la espera antes de renderizar):
// - Clave en IDB y en localStorage → localStorage gana (es la viva).
// - Solo en IDB → se intenta restaurar a localStorage; si no cabe, se
//   sirve desde _idbOnly (autocura borrado + overflow en memoria).
export async function initStorageMirror() {
  try {
    const all = await idbAll()
    for (const [k, v] of all) {
      try {
        if (localStorage.getItem(k) === null) {
          try { localStorage.setItem(k, v) } catch { /* cuota */ }
        }
        if (localStorage.getItem(k) === null) _idbOnly.set(k, v)
      } catch { /* storage inaccesible */ }
    }
  } catch { /* idb no disponible */ }
}

// Migración única: renombra claves antiguas (optopus_*/octo_*) a octostream_*.
// Copia el valor a la clave nueva (sin pisarla si ya existe) y borra la vieja.
try {
  if (typeof localStorage !== 'undefined') {
    const renames = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith('optopus_')) renames.push([k, 'octostream_' + k.slice(8)])
      else if (k?.startsWith('octo_')) renames.push([k, 'octostream_' + k.slice(5)])
    }
    for (const [oldKey, newKey] of renames) {
      if (localStorage.getItem(newKey) === null) {
        const v = localStorage.getItem(oldKey)
        if (v !== null) localStorage.setItem(newKey, v)
      }
      localStorage.removeItem(oldKey)
    }
  }
} catch {
  // ignore
}

export async function getItem(key) {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) return v
  } catch { /* fallthrough al espejo */ }
  return _idbOnly.has(key) ? _idbOnly.get(key) : null
}

export async function setItem(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Cuota llena o storage bloqueado — la clave vive en IDB + memoria.
    if (_isShadowKey(key)) _idbOnly.set(key, value)
  }
  if (_isShadowKey(key)) idbSet(key, value)
}

export async function removeItem(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
  _idbOnly.delete(key)
  if (_isShadowKey(key)) idbDel(key)
}

export function getItemSync(key) {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) return v
  } catch { /* fallthrough al espejo */ }
  return _idbOnly.has(key) ? _idbOnly.get(key) : null
}

export function setItemSync(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Cuota llena o storage bloqueado — la clave vive en IDB + memoria.
    if (_isShadowKey(key)) _idbOnly.set(key, value)
  }
  if (_isShadowKey(key)) idbSet(key, value)
}

export function removeItemSync(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
  _idbOnly.delete(key)
  if (_isShadowKey(key)) idbDel(key)
}

/**
 * Get a JSON-parsed value from storage, with a fallback default.
 */
export async function getJson(key, fallback = null) {
  const raw = await getItem(key)
  if (raw === null || raw === undefined) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * Serialize and store a JSON value.
 */
export async function setJson(key, value) {
  try {
    await setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

/**
 * Synchronous JSON getter with fallback.
 */
export function getJsonSync(key, fallback = null) {
  const raw = getItemSync(key)
  if (raw === null || raw === undefined) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * Synchronous JSON setter.
 */
export function setJsonSync(key, value) {
  try {
    setItemSync(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}
