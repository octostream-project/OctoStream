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
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`octostream:${profile.id}:${pin}`))
    profile.pinHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`octostream:${profile.id}:${pin}`))
  const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  return hash === profile.pinHash
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
