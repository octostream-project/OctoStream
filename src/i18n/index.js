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

const customTranslations = {
  es: {},
  en: {},
}

let listeners = new Set()

function subscribeLanguage(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function notifyLanguageChange() {
  listeners.forEach(cb => cb())
}

export const getLanguagePacks = () => Object.values(languagePacks)

export const registerLanguagePack = (pack) => {
  if (!pack?.id || !pack?.translations) return false
  languagePacks[pack.id] = pack
  builtInTranslations[pack.id] = { ...builtInTranslations[pack.id], ...pack.translations }
  return true
}

export const loadLanguagePacksFromManager = (manager) => {
  const plugins = manager.getLanguagePlugins()
  plugins.forEach(plugin => {
    const pack = plugin.getLanguagePack?.()
    if (pack) registerLanguagePack(pack)
  })
  notifyLanguageChange()
}

export const addCustomTranslations = (lang, translations) => {
  if (!customTranslations[lang]) customTranslations[lang] = {}
  Object.assign(customTranslations[lang], translations)
}

export const getLanguage = () => {
  return getItemSync('octostream_language') || navigator.language?.split('-')[0] || 'es'
}

export const setLanguage = (lang) => {
  setItemSync('octostream_language', lang)
  notifyLanguageChange()
}

export const t = (key, fallback = key) => {
  const lang = getLanguage()
  return customTranslations[lang]?.[key]
    || builtInTranslations[lang]?.[key]
    || builtInTranslations['en']?.[key]
    || fallback
}

export function useTranslation() {
  useSyncExternalStore(subscribeLanguage, getLanguage)
  return { t, getLanguage }
}

export const supportedLanguages = Object.keys(languagePacks)

export const translations = builtInTranslations
