# OctoStream

Media center multiplataforma con sistema de plugins. Soporta Web, Electron (Linux/Windows) y Android (Capacitor).

## Características

- **Sistema de plugins**: Arquitectura extensible
- **Reproductor de video**: Soporta MP4, HLS (m3u8), DASH/Widevine DRM en Android y enlaces embed (iframe)
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

# Sincronizar y ejecutar en un dispositivo/emulador
npm run android:run

# Construir APK de debug
npm run android:build

# Construir APK de release (requiere un keystore configurado)
npm run android:build:release
```

La reproducción nativa en Android usa el plugin propio `@optopus/exo-player`
(`capacitor-plugins/exoplayer`) basado en Media3 ExoPlayer, que soporta HLS, DASH y
Widevine DRM sin problemas de CORS.

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
├── android/             # Proyecto Android generado por Capacitor (ignorado en Git)
├── capacitor-plugins/
│   └── exoplayer/       # Plugin Capacitor propio para ExoPlayer nativo en Android
├── electron/            # Configuración Electron
│   ├── main.js
│   └── preload.js
├── public/              # Assets estáticos y service worker
├── src/
│   ├── components/      # Componentes UI
│   │   ├── Sidebar.jsx
│   │   ├── ContentCard.jsx
│   │   ├── ContentRow.jsx
│   │   ├── ContinueWatching.jsx
│   │   ├── Hero.jsx
│   │   └── VideoPlayer.jsx
│   ├── pages/           # Páginas/Rutas
│   │   ├── Home.jsx
│   │   ├── Search.jsx
│   │   ├── Details.jsx
│   │   ├── Catalog.jsx
│   │   ├── Favorites.jsx
│   │   ├── History.jsx
│   │   ├── Plugins.jsx
│   │   ├── LiveTV.jsx
│   │   └── Settings.jsx
│   ├── plugins/         # Sistema de plugins
│   │   ├── base.js      # Clases base
│   │   ├── manager.js   # Gestor de plugins
│   │   ├── builtIn/     # Plugins incluidos
│   │   └── bundled/     # Plugins empaquetados
│   │       └── tdtSpain/  # TDT España (modular: constants, cache, http, data, resolve, normalize, search)
│   ├── store/
│   │   └── useStore.js  # Estado global (Zustand)
│   ├── utils/
│   │   ├── storage.js   # Abstracción de almacenamiento (localStorage + Electron IPC)
│   │   ├── httpClient.js  # Cliente HTTP multiplataforma (CapacitorHttp / fetch)
│   │   ├── loadPlayerLibs.js  # Carga diferida de hls.js y shaka-player
│   │   ├── exoPlayer.js # Wrapper JS del plugin ExoPlayer nativo
│   │   └── hlsAndroidLoader.js  # Loader HLS para Android vía CapacitorHttp
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
