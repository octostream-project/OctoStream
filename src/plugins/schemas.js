import { z } from 'zod'

export const contentTypeSchema = z.enum(['movie', 'series', 'channel', 'live'])

export const catalogSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: contentTypeSchema,
  i18nKey: z.string().optional(),
})

export const apiSchema = z.object({
  baseUrl: z.string().url(),
  catalog: z.string().optional(),
  meta: z.string().optional(),
  streams: z.string().optional(),
  search: z.string().optional(),
})

export const pluginManifestSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  types: z.array(contentTypeSchema).min(1),
  catalogs: z.array(catalogSchema).optional(),
  icon: z.string().optional(),
  api: apiSchema.optional(),
})

export const customPluginConfigSchema = pluginManifestSchema

export function validatePluginManifest(data) {
  return pluginManifestSchema.safeParse(data)
}

export function validateCustomPluginConfig(data) {
  return customPluginConfigSchema.safeParse(data)
}
