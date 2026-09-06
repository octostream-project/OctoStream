import { describe, it, expect, beforeEach } from 'vitest'
import { esLanguagePlugin } from './es.js'
import { enLanguagePlugin } from './en.js'
import { pluginManager } from '../manager.js'
import { t, setLanguage, getLanguage, supportedLanguages } from '../../i18n/index.js'

describe('language plugins', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('exposes language packs as plugins', () => {
    const esPack = esLanguagePlugin.getLanguagePack()
    expect(esPack.id).toBe('es')
    expect(esPack.translations['nav.home']).toBe('Inicio')

    const enPack = enLanguagePlugin.getLanguagePack()
    expect(enPack.id).toBe('en')
    expect(enPack.translations['nav.home']).toBe('Home')
  })

  it('are registered in the plugin manager', () => {
    const plugins = pluginManager.getLanguagePlugins()
    expect(plugins.some(p => p.manifest.id === 'lang-es')).toBe(true)
    expect(plugins.some(p => p.manifest.id === 'lang-en')).toBe(true)
  })

  it('manager can retrieve a language pack', () => {
    const pack = pluginManager.getLanguagePack('lang-es')
    expect(pack).not.toBeNull()
    expect(pack.id).toBe('es')
  })

  it('i18n defaults to Spanish', () => {
    expect(getLanguage()).toBe('es')
    expect(t('nav.home')).toBe('Inicio')
  })

  it('i18n can switch to English', () => {
    setLanguage('en')
    expect(getLanguage()).toBe('en')
    expect(t('nav.home')).toBe('Home')
  })

  it('lists supported languages', () => {
    expect(supportedLanguages).toContain('es')
    expect(supportedLanguages).toContain('en')
  })
})
