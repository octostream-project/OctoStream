// Cross-platform storage abstraction over localStorage.
// En Electron el localStorage del renderer ya persiste en userData;
// no hace falta espejo por IPC.
// All functions are safe to call at module load time (no top-level access).

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
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export async function setItem(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

export async function removeItem(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export function getItemSync(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function setItemSync(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

export function removeItemSync(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
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
