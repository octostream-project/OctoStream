# Ejemplos de plugins externos

Optopus Stream soporta dos modelos de plugins externos:

## 1. Optopus REST Addon

Un servidor REST propio con endpoints configurables.

```json
{
  "id": "demo-rest-addon",
  "name": "Demo REST Addon",
  "version": "1.0.0",
  "description": "...",
  "types": ["movie", "series"],
  "icon": "film",
  "catalogs": [
    { "id": "new", "name": "Novedades", "type": "movie" }
  ],
  "api": {
    "baseUrl": "https://mi-servidor.example.com",
    "catalog": "/catalog/{type}/{id}?skip={skip}&top={top}",
    "meta": "/meta/{type}/{id}",
    "streams": "/streams/{type}/{id}",
    "search": "/search?q={query}"
  }
}
```

## 2. Stremio Addon

Cualquier addon de Stremio que exponga `manifest.json`.

- El manifest debe incluir `resources` (`catalog`, `meta`, `stream`), `types` y `catalogs`.
- Optopus detecta automáticamente el formato Stremio y mapea los endpoints:
  - `/catalog/{type}/{id}.json`
  - `/meta/{type}/{id}.json`
  - `/stream/{type}/{id}.json`

Para añadirlo, pega la URL del manifest (p. ej. `https://addon.example.com/manifest.json`) en la pestaña "Externos".
