# Notas para agentes / desarrolladores

## Proyecto

OctoStream: media center multiplataforma (web, Electron, Android) con sistema de plugins.

## Comandos de verificación

- `npm run build` — compila el bundle web para producción (`dist/`).
- `npm test` — ejecuta la suite de Vitest.
- `vite build && cap sync && cap run android` — flujo completo para probar en Android.
- `./gradlew :app:assembleDebug` — compilar el APK de debug desde `android/`.
- HDFull no contiene credenciales integradas: para probarlo se requieren
  `VITE_HDFULL_USERNAME` y `VITE_HDFULL_PASSWORD`.

## Android (Capacitor)

- La carpeta `android/` es generada por Capacitor y **ignorada en Git** (ver `.gitignore`).
- El reproductor nativo ahora vive en el plugin propio
  `@optopus/exo-player` (`capacitor-plugins/exoplayer`). De esta forma sobrevive a
  `cap add android` / `cap sync`.
- `CapacitorHttp` debe estar **habilitado** en `capacitor.config.json` para que los
  cargadores HLS (`hlsAndroidLoader.js`) y el cliente HTTP (`httpClient.js`) puedan
  saltarse CORS en Android.
- SDK objetivo: `compileSdk/targetSdk 34`, `minSdk 23`. AGP 8.2.1.
- Media3 ExoPlayer 1.10.1 se declara en `capacitor-plugins/exoplayer/android/build.gradle`.
- ABIs del APK (`abiFilters` en `android/app/build.gradle`): `arm64-v8a`,
  `armeabi-v7a`, `x86_64`. `x86` 32-bit queda fuera porque libaether
  (cloud-proxy) no lo incluye; jlibtorrent sí cubre las 4. Si se regenera
  `android/` con `cap add android` hay que volver a poner los abiFilters.

## Mejoras aplicadas recientemente

- `CapacitorHttp.enabled` puesto a `true` y `appId` unificado a `com.octostream.app`.
- Validación de URLs en el plugin nativo (`http`/`https` solamente).
- Se pasa correctamente `licenseUrl` a la configuración DRM de MediaItem.
- Manejo del ciclo de vida del reproductor (`handleOnPause`, `handleOnResume`, `handleOnDestroy`).
- Sanitización de URL antes de invocar a ExoPlayer desde `VideoPlayer.jsx`.
- `android:allowBackup="false"` y paths del `FileProvider` restringidos.
- Dependencias runtime actualizadas: `axios`, `react-router-dom`.
- Refactorización del reproductor nativo a plugin Capacitor propio `@optopus/exo-player`
  (`capacitor-plugins/exoplayer`) y eliminación del plugin obsoleto `octo-player`.
- Service worker limitado a recursos estáticos locales; ya no cachea streams, APIs ni licencias.
- UI no renderiza el `<video>` ni los controles web cuando se usa ExoPlayer nativo.
- Sourcemaps habilitados en build de producción para depuración.
- Timeout y manejo de tipos robusto en el loader HLS nativo.
- ProGuard/R8 habilitado en release (`minifyEnabled` y `shrinkResources`) con reglas
  para Capacitor, Media3 y el plugin propio.
- `android:enableOnBackInvokedCallback`, `android:largeHeap` y `android:extractNativeLibs`
  añadidos al `AndroidManifest.xml`.
- Scripts `android:build` y `android:build:release` en `package.json`.
- Workflow CI de GitHub Actions para build web y tests.
- Refactorización de la arquitectura de plugins:
  - Nuevo `src/plugins/utils.js` con helpers compartidos (`replaceParams`, `fetchJson`, `withTimeout`).
  - `customPlugin.js` y `externalAdapter.js` usan ahora `httpClient.js` para soportar Android.
  - Validación de manifiestos al añadir plugins externos (`manager.js`).
  - `PluginManager` exporta la clase para facilitar tests unitarios.
- Tests unitarios nuevos para `exoPlayer.js`, `hlsAndroidLoader.js`, `plugins/utils.js` y `manager.js`.
- Alias de Vite para `@optopus/exo-player` apuntando al plugin local, resolviendo tanto
  el bundle web como los tests.
- División manual de chunks (`vendor`, `capacitor`) en `vite.config.js` para reducir
  el tamaño del bundle principal.
- Tests unitarios para `httpClient.js`.
- Las películas y contenidos sin temporadas resuelven streams al abrir su ficha;
  series, anime y doramas esperan hasta que el usuario selecciona un episodio.
- Las resoluciones de streams deben recibir `AbortSignal` y cancelarse al cambiar
  de ficha, episodio o canal y al vencer el timeout.
- Code-splitting de players: `hls.js` y `shaka-player` se cargan dinámicamente
  (`loadPlayerLibs.js`) y se empaquetan en chunks separados que solo se descargan
  al reproducir HLS o DASH/DRM respectivamente.
- Lazy loading de todas las páginas (`React.lazy` + `Suspense` en `App.jsx`); cada
  ruta es un chunk independiente.
- Modularización del plugin `tdtSpain.js` (~900 líneas) en módulos bajo
  `src/plugins/bundled/tdtSpain/`: `constants.js`, `cache.js`, `http.js`, `data.js`,
  `resolve.js`, `normalize.js`, `search.js` e `index.js`.
- Refuerzo de `src/utils/storage.js` con helpers JSON (`getJson`/`setJson`/`getJsonSync`/
  `setJsonSync`) y lista centralizada `SYNCED_KEYS` (incluye claves `optopus_*`).
- `PluginManager` ahora usa `storage.js` en vez de `localStorage` directo, evitando
  crashes si el JSON persistido está corrupto.
- `useStore.js` refactorizado para persistir favoritos e historial vía `storage.js`.
- Optimizaciones de RAM y ancho de banda:
  - LRU cache (200 entradas, TTL 10 min) para todas las peticiones a la API de TMDB.
  - Se eliminó `tmdbData` (objeto TMDB crudo) de los resultados de catálogo y búsqueda;
    solo se conserva en `getMeta` cuando es necesario.
  - `AbortController` en `httpClient.js` (parámetro `signal` en todas las funciones).
  - `AbortController` en `PluginManager` (`getMeta`, `getStreams`, `searchAll`) y en
    la página de búsqueda (cancela búsquedas anteriores al escribir).
  - Pre-filtrado de plugins por `manifest.types` antes de llamar a `getMeta`/`getStreams`,
    evitando llamadas innecesarias a plugins que no soportan el tipo solicitado.
  - `React.memo` en `ContentCard`, `ContentRow` y `Hero`; `useCallback` en `ContentCard`.
  - `Hero` ahora usa `backdrop` (w1280) en vez de `poster` (w342) para fondo a pantalla completa.
  - `LazyImage` (IntersectionObserver) en cast, temporadas, similares y recomendaciones de `Details`.
  - Cache compartido en memoria para TDT Spain (`getSharedCache`) en vez de leer `localStorage`
    en cada operación; poda de EPG >2 días al guardar.
  - Límite de 500 favoritos en `useStore` (antes ilimitado).

## Dependencias de Electron

- Se usa `electron` desde npm (`^33.0.0`). El fork `castlabs/electron-releases` se
  recomienda únicamente si se necesita reproducción Widevine certificada en desktop.

- Seguridad LAN (SyncServer :8765, estilo LocalSend):
  - Cada dispositivo tiene identidad persistente: `deviceId` (UUID), alias
    generado ("Pulpo Sabio") y fingerprint `XXXX-XXXX` (SHA-256 de un secreto
    local). Se anuncia en `/ping` y por broadcast UDP :8766 cada ~2.5s —
    los demás OctoStream se descubren solos sin barrer el /24 (el barrido
    queda como fallback para versiones viejas).
  - Emparejamiento: `POST /pair {deviceId, alias, fingerprint}` → si es nuevo
    dispara `pairRequest` (diálogo con alias+código en `RemotePlayReceiver`)
    y responde `{pending:true}`; el emisor re-pregunta hasta que el usuario
    acepta → el receptor emite un `token` (`answerPair`). Los requests llevan
    `X-Device-Id` + `X-Pair-Token` — auth por identidad, no por IP.
  - Whitelist de IPs (`allowed_ips`) queda como fallback legacy para
    emparejamientos hechos con versiones anteriores.
  - Tokens del emisor: `localStorage octostream_pair_tokens` (deviceId→token).
  - Las rechazadas quedan en lista de sesión y no re-notifican. Cooldown
    anti-spam: máx. 1 `pairRequest` por IP cada 30s.
- El DataSource de ExoPlayer con WARP usa validación TLS normal (sin trust-all).
- Logs: no volcar headers ni URLs completas firmadas a logcat (host solamente).
- URLs loopback (`127.0.0.1`/`localhost`) **nunca** van por el proxy WARP — el
  proxy las resolvería en su extremo remoto (`isLoopbackUrl` en el plugin).
- Embeds con CDN ligado al documento del proveedor (DLive → tiestep): el m3u8
  solo se sirve a peticiones con origen+TLS de la página del embed. El plugin
  tiene un **relay local** (`playRelay`): WebView oculto con un documento stub
  en el origen del embed hace los `fetch()` reales y un `ServerSocket` en
  `127.0.0.1` los sirve a ExoPlayer, reescribiendo las URIs del playlist.
  `stream._wvPlayback` marca los links que necesitan este camino; si el relay
  también falla, el fallback final es reproducir dentro del WebView del embed.
- Embeds con CDN ligado al documento del proveedor (DLive `watch.php` →
  tiestep.top): la URL extraída da 403 fuera del WebView. `playEmbed` acepta
  `playback:true` → el player embebido reproduce dentro del WebView visible
  (iframe expandido a pantalla completa, sin extracción). `proxyEmbedGet`
  sirve el HTML de hosts con WAF anti-WebView e inyecta el parche
  anti-PDF-check ("Sandbox not allowed") + desmuteo del player.
  `VideoPlayer.jsx` cae a ese modo cuando una URL resuelta de embed falla en
  ExoPlayer, o directo si el stream trae `_wvPlayback`.

## Auto-updater (modelo FCTV)

- `version.json` en la raíz es el manifiesto remoto:
  `{versionCode, versionName, minCode, apkUrl, sha256, notes}`.
  `minCode > versionCode instalada` → actualización forzosa sin botón cancelar.
- `src/utils/appUpdater.js` (`checkForUpdate`) + `src/components/UpdateChecker.jsx`
  (montado en `App.jsx`, solo Android, check ~8s tras arranque, máx. 1/hora).
- Plugin nativo `@optopus/app-updater` (`capacitor-plugins/app-updater`):
  `getAppVersion`, `downloadApk` (HTTPS only, progreso, verifica sha256),
  `installApk` (FileProvider + ACTION_VIEW), `canInstallUnknownApps`,
  `openInstallSettings`. Declara `REQUEST_INSTALL_PACKAGES` en su manifest.
- La instalación siempre pasa por el diálogo del sistema — no hay install
  silenciosa sin privilegios de sistema.
- Flujo de release: `node scripts/bump-version.mjs <version>` →
  `npm run android:build:release` → subir el APK como asset a la release en
  GitHub → `node scripts/bump-version.mjs <version> <apk> <url-asset>` →
  commit + push del `version.json` resultante. El APK debe firmarse siempre
  con la misma keystore o la instalación fallará por conflicto de firma.

## Posibles próximos pasos

- Configurar CI para compilar APK de Android (requiere aceptar licencias SDK y Java).
- Añadir tests unitarios para los módulos de `tdtSpain/` (mockear HTTP).
- Añadir tests para `storage.js` y `useStore.js`.
- Considerar `AbortController` para cancelar peticiones de plugins y HTTP.
- Code-splitting adicional de iconos `lucide-react` (importar solo los usados).
