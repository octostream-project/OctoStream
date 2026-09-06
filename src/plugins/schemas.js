import { z } from 'zod'

export const contentTypeSchema = z.enum(['movie', 'series', 'channel', 'live', 'language', 'other'])

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

// Stremio-compatible addon manifest. Extra keys are allowed because Stremio
// manifests contain optional fields we do not need to validate strictly.
export const stremioManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  logo: z.string().optional(),
  background: z.string().optional(),
  types: z.array(z.string()).min(1),
  idPrefixes: z.array(z.string()).optional(),
  resources: z.array(z.union([z.string(), z.object({ name: z.string(), types: z.array(z.string()).optional(), idPrefixes: z.array(z.string()).optional() })])),
  catalogs: z.array(z.object({
    type: z.string(),
    id: z.string(),
    name: z.string().optional(),
    genres: z.array(z.string()).optional(),
    extra: z.array(z.any()).optional(),
  })).optional(),
}).passthrough()

export const externalPluginConfigSchema = z.union([
  pluginManifestSchema,
  stremioManifestSchema,
])

export function validatePluginManifest(data) {
  return pluginManifestSchema.safeParse(data)
}

export function validateCustomPluginConfig(data) {
  return customPluginConfigSchema.safeParse(data)
}

export function validateStremioManifest(data) {
  return stremioManifestSchema.safeParse(data)
}

export function validateExternalPluginConfig(data) {
  return externalPluginConfigSchema.safeParse(data)
}
