# OctoStream

Media center para **Android y Android TV** con sistema de plugins.

**[Web oficial](https://octostream-project.github.io/OctoStream/) · [Descargar APK](https://github.com/octostream-project/OctoStream/releases/latest) · [Guía de uso](https://octostream-project.github.io/OctoStream/guia.html)**

## Descargar

La app no está en Google Play — se instala con el APK y después **se actualiza sola** desde la app.

| APK | Dispositivo |
|-----|-------------|
| `arm64-v8a` | Casi todo: móviles modernos, Chromecast Google TV, Nvidia Shield, Fire TV recientes |
| `armeabi-v7a` | Dispositivos antiguos de 32 bits (boxes baratas, Fire TV Stick viejas) |
| `x86_64` | Emuladores, Android x86 en PC, boxes Intel |

→ [Descargar la última versión](https://github.com/octostream-project/OctoStream/releases/latest)

## Características

- **Reproductor nativo Media3/ExoPlayer**: HLS, DASH, MP4, subtítulos y Widevine DRM sin problemas de CORS.
- **Android TV de verdad**: navegación D-pad con foco visible, teclas multimedia del mando (⏯ ⏪ ⏩, zap de canal), salvapantallas que se quita con un toque y gestión correcta del botón atrás.
- **Deportes en directo**: agenda de fútbol, tenis, baloncesto, F1… con escudos de equipos, fotos de jugadores y solo las jornadas relevantes.
- **Sync estilo LocalSend**: los dispositivos OctoStream se descubren solos en la red local con nombre propio, emparejamiento por código de verificación y tokens — envía contenido a la TV y sincroniza historial/favoritos.
- **Torrents integrados**: reproducción directa de magnets con jlibtorrent.
- **Sistema de plugins**: catálogos, búsqueda unificada, historial, favoritos y "seguir viendo".

## Desarrollo

```bash
npm install

# Build web (dist/)
npm run build

# Tests
npm test
```

## Android (Capacitor)

```bash
# Inicializar Android (solo la primera vez)
npm run android:init
npm run android:add

# Sincronizar y ejecutar en un dispositivo/emulador
npm run android:run

# APK de debug
npm run android:build

# APK de release (requiere el keystore de firma)
npm run android:build:release
```

La reproducción nativa usa el plugin propio `@optopus/exo-player`
(`capacitor-plugins/exoplayer`) basado en Media3 ExoPlayer 1.10.1.
SDK objetivo 34, mínimo 23. ABIs: `arm64-v8a`, `armeabi-v7a`, `x86_64`.

## Arquitectura de plugins

Los plugins extienden la clase `Plugin` e implementan:

- `getCatalog({ type, id, skip, top })` — items del catálogo
- `getMeta({ type, id })` — metadata de un item
- `getStreams({ type, id })` — fuentes de streaming
- `search({ query })` — búsqueda dentro del plugin

### Tipos de stream soportados

| Tipo | Descripción |
|------|-------------|
| `mp4` | Vídeo directo MP4 |
| `hls` | Stream HLS (m3u8) |
| `embed` / `iframe` | URL embebida |

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
│   ├── exoplayer/       # Plugin Capacitor propio — ExoPlayer nativo
│   ├── app-updater/     # Actualizador in-app (descarga + instala APK)
│   ├── sync-server/     # Servidor LAN :8765 + discovery UDP :8766
│   └── cloud-proxy/     # Proxy WARP para hosts con bloqueo regional
├── docs/                # Web de GitHub Pages (octostream-project.github.io/OctoStream)
├── public/              # Assets estáticos y service worker
├── src/
│   ├── components/      # UI (VideoPlayer, CastMenu, UpdateChecker…)
│   ├── pages/           # Home, Search, Details, LiveTV, Sports, Sync…
│   ├── plugins/         # Sistema de plugins (manager + bundled)
│   ├── store/           # Estado global (Zustand)
│   └── utils/           # httpClient, exoPlayer, remotePlay, sofascore…
├── capacitor.config.json
├── vite.config.js
└── version.json         # Manifiesto del auto-updater
```

## Aviso legal

OctoStream es un navegador y agregador de enlaces: **no aloja, almacena ni distribuye ningún contenido**. Todo el material proviene de fuentes públicas ya disponibles en Internet y es responsabilidad exclusiva de los sitios de terceros que lo sirven. El uso de la app y el acceso a los contenidos enlazados son responsabilidad del usuario.

## Licencia

MIT
