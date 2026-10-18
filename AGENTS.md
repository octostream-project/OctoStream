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
- SDK objetivo: `compileSdk/targetSdk 36`, `minSdk 24` (actualizado desde
  34/23 — Capacitor 8 lo exige). AGP 8.2.1.
- Media3 ExoPlayer 1.3.1 se declara en `capacitor-plugins/exoplayer/android/build.gradle`,
  incluido `media3-decoder-ffmpeg` (AC3/E-AC-3/DTS/TrueHD — imprescindible para
  .mkv debrid con audio AC3/DTS; sin él esos archivos suenan en silencio).
- ABIs del APK (`abiFilters` en `android/app/build.gradle`): `arm64-v8a`,
  `armeabi-v7a`, `x86_64`. `x86` 32-bit queda fuera porque libaether
  (cloud-proxy) no lo incluye; jlibtorrent sí cubre las 4. Si se regenera
  `android/` con `cap add android` hay que volver a poner los abiFilters
  y regenerar los iconos con `python3 scripts/gen-android-icons.py`.
- `android:usesCleartextTraffic="true"` en `AndroidManifest.xml` es
  **obligatorio** (targetSdk 36 bloquea HTTP cleartext por defecto y sin él
  mueren: el sync LAN `http://:8765`, el servidor local de torrents
  `127.0.0.1`, el relay Palantir y cualquier stream `http://` scrapeado).
  Si se regenera `android/` con `cap add android` hay que volver a añadirlo.

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
- Canal Torrentio ES (`plurtasko/channels/torrentio.js`): agregador por
  **IMDb ID** (`torrentio.strem.fun`) con los providers en español del
  addon (MejorTorrent, Wolfmax4k, Cinecalidad). Sin catálogo ni búsqueda
  por nombre — `index.js` lo consulta en paralelo a los canales cuando el
  item trae TMDB→IMDb y `octostream_torrent_search` está activo.
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

- Player de escritorio (`electron/main.cjs` + `preload.cjs`):
  - `/ffmpeg` en el proxy local remultiplexa mkv/avi/ts → fMP4 en streaming
    (`-c:v copy -c:a aac`). El fetch lo hace Node (TLS, redirects, headers del
    resolver) y ffmpeg lee de `pipe:0` — los builds estáticos con gnutls
    crashean contra ciertos servidores HTTPS si tocan TLS directamente.
  - Binarios: `scripts/fetch-ffmpeg.mjs` descarga eugeneware/ffmpeg-static
    (b6.1.1 = ffmpeg 7.0.2) a `build/ffmpeg/` (gitignored) → `extraResources`
    por plataforma. En PATH del sistema si no hay empaquetado;
    `OCTOSTREAM_FFMPEG` fuerza ruta.
  - `player:open-external` IPC lanza mpv/VLC reales por `spawn` con
    allowlist de rutas habituales por SO (los esquemas `vlc://`/`mpv://` no
    existen en escritorio).
  - `win:fullscreen` IPC: el player va a ventana completa al abrirse como en
    Android; `win:fullscreen-changed` sincroniza el icono del botón.
  - Cloud-proxy WARP: `electron/main.cjs` lanza el binario `aether`
    (CluvexStudio/Aether, `scripts/fetch-aether.mjs` → `build/aether/` →
    `extraResources`) con las mismas env vars que el plugin Android — SOCKS5
    :1819 + HTTP :1820. El renderer va por `session.setProxy` y las fetches
    Node del proxy local usan un agente SOCKS5 propio (handshake RFC 1928 +
    TLS encima) — mismo bypass de hosts que Android (TDT/RTVE/Mediaset/DAI +
    LAN). `src/utils/cloudProxy.js` da la misma superficie que el plugin
    Capacitor (`connect/disconnect/disconnectBackground/getStatus`) — en
    Electron va por IPC `cloud:*`. Un aether externo ya corriendo en :1819
    se adopta al arranque (`configureAetherProxy`).
- Se usa `electron` desde npm (`^33.0.0`). El fork `castlabs/electron-releases` se
  recomienda únicamente si se necesita reproducción Widevine certificada en desktop.
- `electron/sync-server.cjs` es el port a Node del plugin Android
  `@optopus/sync-server`: mismo protocolo HTTP :8765 (`/ping`, `/pair`, `/sync`,
  `/play`, `/stop`), mismo auth por `X-Device-Id` + `X-Pair-Token` y el mismo
  descubrimiento UDP :8766 (multicast `239.255.60.60` + broadcast). El renderer
  lo usa vía `window.octostream.sync` (preload) igual que en Android usa el
  plugin Capacitor — `remotePlay.js` elige el backend por plataforma.
- No fijar `build.electronDist` a `node_modules/electron/dist`: ese dist es
  solo Linux y rompe el cross-build a Windows (`electron.exe` ausente).
  Sin él, electron-builder descarga el dist correcto por plataforma.

- Seguridad LAN (SyncServer :8765, estilo LocalSend):
  - Cada dispositivo tiene identidad persistente: `deviceId` (UUID), alias
    generado ("Pulpo Sabio") y fingerprint `XXXX-XXXX` (SHA-256 de un secreto
    local). Se anuncia en `/ping` y por UDP :8766 (multicast 239.255.60.60
    + broadcast 255.255.255.255 + **broadcast dirigido por interfaz**
    192.168.x.255…, ~2.5s) — los demás OctoStream se descubren solos sin
    barrer el /24. `SyncDevices` además lanza un barrido `scanDevices`
    automático si el UDP no encuentra a nadie en ~8s (routers con
    aislamiento de AP / IGMP snooping) y barre **todos** los /24 locales
    (`ips[]` del backend — multi-interfaz WiFi+Ethernet/VPN).
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
- Torrent P2P en desktop (Linux/Windows): `electron/torrent.cjs` implementa la
  misma superficie del plugin Android `@octostream/torrent-engine` (`start/
  stop/status` + evento `torrentProgress`) con **webtorrent** en el proceso
  principal — TCP/UDP/DHT/trackers, sin binarios nativos (los módulos nativos
  opcionales uTP/WebRTC se stubbean). Sirve el archivo elegido en
  `http://127.0.0.1:<port>/stream` con Range requests; selección de episodio
  idéntica a `src/utils/torrentPick.js`. En el asar no hay node_modules:
  `scripts/bundle-torrent.mjs` (rolldown) genera `electron/torrent.bundle.mjs`
  self-contained; el main lo extrae de `app.asar` a `temp` y lo importa por
  URL `file://` — el bundle usa `createRequire(import.meta.url)`, que exige
  una URL file real (un módulo `data:` lanza ERR_INVALID_ARG_VALUE). En dev
  sin bundle se usa `torrent.cjs` +
  `webtorrent` de npm. `src/utils/torrentEngine.js` es la fachada compartida:
  Android → plugin Capacitor, Electron → `window.octostream.torrent`.
  Archivos mkv/avi/etc. del torrent pasan por el remux `/ffmpeg` (Chromium no
  reproduce Matroska) — `remuxStream` acepta loopback solo para el puerto del
  servidor torrent.
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
- Keystore canónico de release: `~/optostream-keystore-backup/octostream-release.jks`
  (alias `octostream`, cert SHA-256 `80649ff3b7d7375b...`). Las releases ≤1.51
  quedaron firmadas por error con una debug key (`e006f031...`) — desde 1.52
  los usuarios que actualicen desde ≤1.51 deben reinstalar (conflicto de firma).

## YouTube en desktop (Electron)

- Android usa NewPipeExtractor vía el plugin `@octostream/youtube`; en
  Linux/Windows el equivalente es **yt-dlp** empaquetado
  (`electron/youtube.cjs` + IPC `youtube:*` + `window.octostream.youtube`).
- Binarios: `scripts/fetch-ytdlp.mjs` → `build/ytdlp/<platform>-<arch>/`
  (verifica SHA2-256SUMS de la release) → `extraResources` →
  `resources/ytdlp/...`.
- El plugin **yt-dlp-invidious** va junto al ejecutable en
  `yt-dlp-plugins/invidious/` (yt-dlp lo autodescarga): fallback automático
  a instancias Invidious cuando YouTube devuelve bot-check ("Sign in to
  confirm you're not a bot"). Commit fijado + sha256 de los .py verificados.
- `googlevideo.com` está en el bypass de WARP (como `direct:true` en
  Android): por el túnel devuelve 429.
- Con WARP activo, yt-dlp sale por `--proxy socks5h://127.0.0.1:1819`.

## Posibles próximos pasos

- Configurar CI para compilar APK de Android (requiere aceptar licencias SDK y Java).
- Añadir tests unitarios para los módulos de `tdtSpain/` (mockear HTTP).
- Añadir tests para `storage.js` y `useStore.js`.
- Considerar `AbortController` para cancelar peticiones de plugins y HTTP.
- Code-splitting adicional de iconos `lucide-react` (importar solo los usados).
