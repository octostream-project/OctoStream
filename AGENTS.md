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
- **No hay reproductor web interno**: se eliminó el `<video>` con hls.js/shaka
  y el remux `/ffmpeg`. La reproducción es exclusivamente nativa — ExoPlayer
  (plugin `@octostream/exo-player`) en Android y mpv por IPC
  (`electron/mpv.cjs`, binario empaquetado) en Linux/Windows. En un navegador
  web solo se muestra un aviso; los embeds conservan el iframe del proveedor
  como último recurso en web. DRM Widevine solo en Android.
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
  - `player:open-external` IPC lanza mpv/VLC reales por `spawn` con
    allowlist de rutas habituales por SO (los esquemas `vlc://`/`mpv://` no
    existen en escritorio).
  - `win:fullscreen` IPC: el player va a ventana completa al abrirse como en
    Android; `win:fullscreen-changed` sincroniza el icono del botón.
  - mpv se incrusta en la BrowserWindow con `--wid=<handle>` +
    `--osc=no --input-default-bindings=no` y carga `electron/mpv-osc.lua`
    (OSC propio estilo ExoPlayer Android: back, EPG, zapping, CC, vol, cast).
    El script se copia a tmp en el primer uso (`ensureOscScript`) y marca
    `user-data/octo-osc-ready` al cargar — `oscPush` encola los
    `script-message-to octo_osc` hasta esa marca (el nombre interno deriva
    del archivo: `octo-osc.lua` → `octo_osc`). El overlay ASS fija
    `ov.res_x/res_y` cada render: el tamaño por defecto 1280x720 de mpv se
    traslada al embed y desplaza todo si no se re-asigna. El ratón embebido
    no llega a mpv en todas las plataformas: el renderer reenvía
    `mouse x y`/`keypress` por IPC (`player:mouse`/`player:key`) y el OSC
    usa `mp.get_mouse_pos()` (actualizado al instante) para el hit-test.
    Acciones de app → `script-message octo-action <act>` → evento
    `{state:'osc', action}` → `handleOscAction` en VideoPlayer.jsx.
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
  Los archivos del torrent se reproducen directos en mpv (Matroska nativo,
  sin remux).
- El DataSource de ExoPlayer con WARP usa validación TLS normal (sin trust-all).
- Logs: no volcar headers ni URLs completas firmadas a logcat (host solamente).
- Reproductor nativo de escritorio: `electron/mpv.cjs` lanza **mpv**
  (`--input-ipc-server`, socket de líneas JSON) en ventana propia con OSC —
  paridad del plugin ExoPlayer de Android. Emite los mismos estados
  (`position` cada 5 s, `ended`, `closed`, `error`, `buffering`, `ready`) y
  zapping (`keybind PGUP/PGDWN → script-message octo-zap` → evento
  `{state:'zap', index, direction, name}` igual que `channelZap`). Las
  fachadas `exoPlayer.js` (`playStream`/`switchChannel`/`pause`/`seek`/`stop`)
  enrutan a `window.octostream.player` en Electron; VideoPlayer usa mpv para
  todo lo no-DRM/embed en escritorio (sin fallback web — ya no existe player
  interno). mpv reproduce mkv/AC3/DTS/HEVC **sin remux** y soporta `sub-add`
  para los subtítulos de OpenSubtitles (el VTT va por IPC `player:add-sub`
  a un temporal). Binario:
  `scripts/fetch-mpv.mjs` lo descarga a `build/mpv/<plat>-<arch>/`
  (gitignored, sha256 verificado) → `extraResources` →
  `resources/mpv/<plat>-<arch>/` — el usuario **no instala nada**.
  Linux: pkgforge mpv-AppImage extraída con `--appimage-extract` (el árbol
  squashfs, `AppRun` = sharun estático — no requiere FUSE). Windows:
  shinchiro/mpv-winbuild-cmake `.7z` (mpv.exe auto-contenido +
  d3dcompiler_43.dll). Fallbacks: `OCTOSTREAM_MPV` → sistema (PATH/rutas
  habituales); sin ningún mpv se muestra un error (no hay player web).
  `paused-for-cache` se mapea a `buffering`; `core-idle` se ignora a
  propósito (salta en seeks y marcaba stalls falsos en el watchdog).
  **Cabeceras HTTP**: ffmpeg pliega (obs-fold) cualquier línea de
  `http-header-fields` >~80 chars — Fastly y el llhttp de Node responden
  400 sin procesar el request (el request ni llega al handler del proxy
  local). User-Agent/Referer viajan por las propiedades `user-agent` /
  `referrer` de mpv (sin plegar); el resto por `http-header-fields` con
  descarte de líneas >76 chars (`_applyOpts`/`_headersOption`).
  `OCTO_MPV_LOG=1` vuelca el log de mpv a `/tmp/octo-mpv-<pid>.log`.
- Streams IP-binding: las URLs de directo de Atresmedia (`atresplayer.com`,
  `atresmedia.com`) quedan ligadas a la IP que las resolvió — si la
  resolución sale por WARP y la reproducción directa, el CDN responde
  **492**. Por eso están en el bypass WARP (Electron `AETHER_BYPASS_*` y
  `nonProxyHosts`/ProxyConfig del plugin Android) junto a TDT/RTVE/Mediaset.
- El proxy local reescribe las URLs internas de playlists con el token de
  sesión (`/proxy?token=…&url=…`) — si una playlist se cachea tal cual, al
  siguiente arranque el token es viejo y todo falla con 403. `unproxied()`
  en `tdtSpain/constants.js` desenvuelve antes de persistir/reproducir
  (aplicado en `getRtveHls`, resolvers geturl/posturl y passthrough hls).
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
- Paridad de embeds en escritorio (`electron/embed.cjs` + IPC `embed:*` +
  `window.octostream.embed`): la misma cadena de Android la ejecuta un
  wrapper en `VideoPlayer.jsx` antes de montar el player —
  (1) `resolveEmbed` headless con `BrowserWindow` oculta (partición
  `persist:octo-embed`) que ejecuta el challenge JS, auto-reproduce y
  captura la media URL por `webRequest` (un listener por evento en la sesión,
  fan-out por `webContentsId`); (2) `playRelay` → endpoint `/embed-relay` del
  proxy local que hace `session.fetch` con la sesión del embed (TLS Chromium
  + cookies + mismos headers que usó la página) y reescribe playlists;
  (3) `playEmbed` ventana visible (`playback:false` resolución interactiva,
  `playback:true` player embebido hasta cerrar); (4) iframe como último
  recurso — el main retira `X-Frame-Options`/`frame-ancestors` en subframes
  iniciados por la app. La sesión de embeds hereda el routing WARP
  (`Embed.applySessionRouting` desde `applyAetherRouting`).
- DLNA "Enviar a TV" en escritorio (`electron/dlna.cjs` + `cast:dlna`):
  SSDP M-SEARCH → descripción UPnP → AVTransport `SetAVTransportURI`+`Play`
  (misma superficie que `openDlna()` de Android: `{sent, device}`).
- Update check en escritorio (`update:check`/`update:open` IPC +
  rama Electron de `UpdateChecker.jsx`): compara `releases/latest` de GitHub
  con `app.getVersion()` y abre la página de la release (sin auto-install
  — no hay electron-updater configurado).

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
  La página `YouTube.jsx` se habilita con `isAndroidNative() || isElectron()`.
- Binarios: `scripts/fetch-ytdlp.mjs` → `build/ytdlp/<platform>-<arch>/`
  (verifica SHA2-256SUMS de la release) → `extraResources` →
  `resources/ytdlp/...`.
- El plugin **yt-dlp-invidious** va junto al ejecutable en
  `yt-dlp-plugins/invidious/` (yt-dlp lo autodescarga): fallback automático
  a instancias Invidious cuando YouTube devuelve bot-check ("Sign in to
  confirm you're not a bot"). Commit fijado + sha256 de los .py verificados.
- `googlevideo.com` está en el bypass de WARP (como `direct:true` en
  Android): por el túnel devuelve 429. **yt-dlp tampoco va por WARP**: las
  URLs firmadas llevan el `ip=` de quien resuelve — resolver por el túnel y
  reproducir directo rompe por IP mismatch (igual que Atresmedia).
- VOD de YouTube ya casi nunca da formatos progresivos — `resolve()` usa el
  `manifest_url` HLS (master hls_variant con A+V+subs); el primer formato
  `m3u8` puede ser solo audio (itag 233/234), nunca elegirlo a ciegas.

## Posibles próximos pasos

- Configurar CI para compilar APK de Android (requiere aceptar licencias SDK y Java).
- Añadir tests unitarios para los módulos de `tdtSpain/` (mockear HTTP).
- Añadir tests para `storage.js` y `useStore.js`.
- Considerar `AbortController` para cancelar peticiones de plugins y HTTP.
- Code-splitting adicional de iconos `lucide-react` (importar solo los usados).

- Subtítulos IA (duck.ai): el menú nativo de subtítulos tiene "Subtítulos IA…"
  que emite `aiSubsRequested{imdbId,season,episode}` → `src/utils/aiSubs.js`
  decide: sub español en OpenSubtitles/Stremio → aplicar; otro idioma → traducir
  con duck.ai chat; sin sub → `startAiAudio` (ExoPlayer headless x4 con
  TeeAudioProcessor → WAVs 20 s vía `aiAudioChunk` → dictado duck.ai → cues
  progresivos por `setExternalCues`). `src/utils/duckAi.js` implementa el
  challenge VQD (eval del JS anti-bot en el DOM real), dictation y chat con
  reintento ante 418/429. En directo no se ofrece.
