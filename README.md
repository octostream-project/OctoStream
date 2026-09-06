# Optopus Stream

Media center multiplataforma con sistema de plugins tipo Kodi/Stremio. Soporta Web, Electron (Linux/Windows) y Android (Capacitor).

## Características

- **Sistema de plugins**: Arquitectura extensible tipo Kodi/Stremio
- **Reproductor de video**: Soporta MP4, HLS (m3u8) y enlaces embed (iframe)
- **Catálogos**: Películas, Series, TV en vivo
- **Búsqueda global**: Busca en todos los plugins instalados
- **Favoritos e historial**: Guarda tu contenido preferido
- **Multiplataforma**: Web, Linux, Windows, Android

## Instalación

```bash
npm install
```

## Desarrollo (Web)

```bash
npm run dev
```

Abre http://localhost:5173

## Desarrollo (Electron)

```bash
npm run electron:dev
```

## Build Web

```bash
npm run build
```

## Build Electron (Linux/Windows)

```bash
npm run electron:build
```

Los binarios se generan en `dist-electron/`.

## Android (Capacitor)

```bash
# Inicializar Android (solo la primera vez)
npm run android:init
npm run android:add

# Sincronizar y ejecutar
npm run android:run
```

## Arquitectura de Plugins

Los plugins extienden la clase `Plugin` e implementan:

- `getCatalog({ type, id, skip, top })` - Devuelve items del catálogo
- `getMeta({ type, id })` - Devuelve metadata de un item
- `getStreams({ type, id })` - Devuelve fuentes de streaming
- `search({ query })` - Búsqueda dentro del plugin

### Tipos de stream soportados

| Tipo | Descripción |
|------|-------------|
| `mp4` | Video directo MP4 |
| `hls` | Stream HLS (m3u8) con hls.js |
| `embed` / `iframe` | URL embebida en iframe |

### Crear un plugin personalizado

```js
import { createPlugin, PluginManifest, CONTENT_TYPES } from './base.js'

export const myPlugin = createPlugin(
  new PluginManifest({
    id: 'my-plugin',
    name: 'Mi Plugin',
    version: '1.0.0',
    description: 'Descripción del plugin',
    types: [CONTENT_TYPES.MOVIE],
    catalogs: [{ id: 'all', name: 'Todo', type: CONTENT_TYPES.MOVIE }],
  }),
  {
    getCatalog: async ({ skip, top }) => { /* ... */ },
    getMeta: async ({ id }) => { /* ... */ },
    getStreams: async ({ id }) => {
      return [{
        name: 'Servidor',
        url: 'https://...',
        streamType: 'embed', // o 'mp4' o 'hls'
        quality: '1080p',
      }]
    },
    search: async ({ query }) => { /* ... */ },
  }
)
```

Registra el plugin en `src/plugins/manager.js`.

## Estructura del proyecto

```
optopus-stream/
├── electron/           # Configuración Electron
│   ├── main.js
│   └── preload.js
├── src/
│   ├── components/      # Componentes UI
│   │   ├── Sidebar.jsx
│   │   ├── ContentCard.jsx
│   │   ├── ContentRow.jsx
│   │   └── VideoPlayer.jsx
│   ├── pages/           # Páginas/Rutas
│   │   ├── Home.jsx
│   │   ├── Search.jsx
│   │   ├── Details.jsx
│   │   ├── Catalog.jsx
│   │   ├── Favorites.jsx
│   │   ├── History.jsx
│   │   └── Plugins.jsx
│   ├── plugins/         # Sistema de plugins
│   │   ├── base.js      # Clases base
│   │   ├── manager.js   # Gestor de plugins
│   │   ├── sampleMovies.js
│   │   ├── sampleSeries.js
│   │   ├── liveTv.js
│   │   └── embedStream.js
│   ├── store/
│   │   └── useStore.js  # Estado global (Zustand)
│   ├── App.jsx
│   ├── main.jsx
│   └── index.css
├── capacitor.config.json
├── vite.config.js
├── tailwind.config.js
└── package.json
```

## Licencia

MIT
