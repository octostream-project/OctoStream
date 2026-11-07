import { useSyncExternalStore } from 'react'
import { esLanguagePlugin } from '../plugins/languages/es.js'
import { enLanguagePlugin } from '../plugins/languages/en.js'
import { getItemSync, setItemSync } from '../utils/storage.js'

const esPack = esLanguagePlugin.getLanguagePack()
const enPack = enLanguagePlugin.getLanguagePack()

const languagePacks = {
  es: esPack,
  en: enPack,
}

const builtInTranslations = {
  es: esPack.translations,
  en: enPack.translations,
}

let listeners = new Set()

function subscribeLanguage(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function notifyLanguageChange() {
  listeners.forEach(cb => cb())
}

// Cacheado: t() se llama cientos de veces por pantalla y antes cada una
// hacía una lectura síncrona de localStorage.
let langCache = null
export const getLanguage = () => {
  if (langCache) return langCache
  langCache = getItemSync('octostream_language') || navigator.language?.split('-')[0] || 'es'
  return langCache
}

export const setLanguage = (lang) => {
  setItemSync('octostream_language', lang)
  langCache = lang
  notifyLanguageChange()
}

export const t = (key, fallback = key) => {
  const lang = getLanguage()
  return builtInTranslations[lang]?.[key]
    || builtInTranslations['en']?.[key]
    || fallback
}

export function useTranslation() {
  useSyncExternalStore(subscribeLanguage, getLanguage)
  return { t, getLanguage }
}

export const supportedLanguages = Object.keys(languagePacks)

export const translations = builtInTranslations
