import { getItemSync, setItemSync, removeItemSync } from './storage.js'

const PROFILES_KEY = 'octostream_profiles'
const ACTIVE_PROFILE_KEY = 'octostream_active_profile'
const MAX_PROFILES = 8
const DATA_KEYS = [
  'octostream_favorites',
  'octostream_watchlist',
  'octostream_history',
  'octostream_watched_episodes',
  'octostream_youtube_search_history',
  'octostream_youtube_live_search_history',
]

const defaultProfile = () => ({ id: 'default', name: 'Principal', kids: false, createdAt: 0 })
const toHex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
const fromHex = hex => new Uint8Array((String(hex || '').match(/.{2}/g) || []).map(b => parseInt(b, 16)))
async function derivePinHash(profileId, pin, saltBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`octostream:${profileId}:${pin}`),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 210000, hash: 'SHA-256' },
    key,
    256,
  )
}

export function getProfiles() {
  try {
    const saved = JSON.parse(getItemSync(PROFILES_KEY) || '[]')
    const profiles = Array.isArray(saved) ? saved.filter(p => p?.id && p?.name) : []
    if (!profiles.some(p => p.id === 'default')) profiles.unshift(defaultProfile())
    return profiles
  } catch {
    return [defaultProfile()]
  }
}

export function getActiveProfileId() {
  const id = getItemSync(ACTIVE_PROFILE_KEY)
  return getProfiles().some(p => p.id === id) ? id : 'default'
}

export function profileDataKey(key, profileId = getActiveProfileId()) {
  if (profileId === 'default') return key
  return `octostream_profile_${profileId}_${key.replace(/^octostream_/, '')}`
}

export async function createProfile(name, { kids = false, pin = '' } = {}) {
  const cleanName = String(name || '').trim().slice(0, 24)
  if (!cleanName) throw new Error('Escribe un nombre para el perfil.')
  const profiles = getProfiles()
  const normalizedName = cleanName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  if (profiles.some(p => p.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === normalizedName)) {
    throw new Error('Ya existe un perfil con ese nombre.')
  }
  if (profiles.length >= MAX_PROFILES) throw new Error(`Máximo ${MAX_PROFILES} perfiles.`)
  const profile = {
    id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: cleanName,
    kids: !!kids,
    createdAt: Date.now(),
  }
  if (kids) {
    if (!/^\d{4,8}$/.test(pin)) throw new Error('El PIN infantil debe tener entre 4 y 8 dígitos.')
    if (!globalThis.crypto?.subtle) throw new Error('Este dispositivo no permite guardar el PIN de forma segura.')
    const salt = crypto.getRandomValues(new Uint8Array(16))
    profile.pinSalt = toHex(salt)
    profile.pinHash = toHex(await derivePinHash(profile.id, pin, salt))
  }
  profiles.push(profile)
  setItemSync(PROFILES_KEY, JSON.stringify(profiles))
  return profiles
}

export function persistProfiles(profiles) {
  setItemSync(PROFILES_KEY, JSON.stringify(profiles))
}

export function setActiveProfileId(id) {
  setItemSync(ACTIVE_PROFILE_KEY, id)
}

export async function canLeaveProfile(profile, pin = '') {
  if (!profile?.kids || !profile.pinHash) return true
  if (!globalThis.crypto?.subtle) return false
  if (profile.pinSalt) {
    return toHex(await derivePinHash(profile.id, pin, fromHex(profile.pinSalt))) === profile.pinHash
  }
  // Migrate profiles created by 2.09.20, which stored a single SHA-256 hash.
  const legacyDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`octostream:${profile.id}:${pin}`))
  if (toHex(legacyDigest) !== profile.pinHash) return false
  const profiles = getProfiles()
  const migrated = profiles.find(item => item.id === profile.id)
  if (migrated) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    migrated.pinSalt = toHex(salt)
    migrated.pinHash = toHex(await derivePinHash(profile.id, pin, salt))
    persistProfiles(profiles)
  }
  return true
}

export function deleteProfileData(id) {
  if (!id || id === 'default') return
  for (const key of DATA_KEYS) removeItemSync(profileDataKey(key, id))
}

export function isAllowedInProfile(item, profile) {
  if (!profile?.kids) return true
  const markedAdult = [item?.adult, item?.isAdult, item?.nsfw]
    .some(value => value === true || value === 1 || value === 'true')
  return !markedAdult
}
