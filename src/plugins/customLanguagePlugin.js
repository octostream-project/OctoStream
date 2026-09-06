import { createPlugin, PluginManifest, CONTENT_TYPES } from './base.js'

export function createCustomLanguagePlugin({ id, name, flag, translations }) {
  const packId = id
  return createPlugin(
    new PluginManifest({
      id: `lang-${packId}`,
      name: name || packId,
      version: '1.0.0',
      description: `Language pack: ${name || packId}`,
      types: [CONTENT_TYPES.LANGUAGE],
      icon: 'globe',
    }),
    {
      getLanguagePack: () => ({
        id: packId,
        name: name || packId,
        flag: flag || '🌐',
        translations: translations || {},
      }),
    }
  )
}
