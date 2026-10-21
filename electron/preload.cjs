const { contextBridge, ipcRenderer } = require('electron')

// Minimal, safe surface exposed to the renderer. contextIsolation + sandbox keep
// Node APIs out of the web page; only this curated object is reachable as window.octostream.
const proxy = ipcRenderer.sendSync('get-proxy-config')

contextBridge.exposeInMainWorld('octostream', {
  platform: 'electron',
  version: '1.0.0',
  isElectron: true,
  proxyPort: proxy.port,
  proxyUrl: proxy.url,
  proxyBase: proxy.base,
  getLanProxyUrl: () => ipcRenderer.invoke('get-lan-proxy-url'),
  // Reproductores externos instalados en el sistema (mpv/VLC/ffplay).
  openExternalPlayer: (arg) => ipcRenderer.invoke('player:open-external', arg),
  // Reproductor nativo mpv controlado por IPC — equivalente del plugin
  // ExoPlayer de Android (player:event → playbackState + channelZap).
  player: {
    status: () => ipcRenderer.invoke('player:status'),
    open: (arg) => ipcRenderer.invoke('player:open', arg),
    switch: (arg) => ipcRenderer.invoke('player:switch', arg),
    pause: () => ipcRenderer.invoke('player:pause'),
    resume: () => ipcRenderer.invoke('player:resume'),
    seek: (sec) => ipcRenderer.invoke('player:seek', { sec }),
    setRate: (rate) => ipcRenderer.invoke('player:rate', { rate }),
    setVolume: (v) => ipcRenderer.invoke('player:volume', { v }),
    setMute: (m) => ipcRenderer.invoke('player:mute', { m }),
    showText: (text) => ipcRenderer.invoke('player:text', { text }),
    setSubDelay: (sec) => ipcRenderer.invoke('player:sub-delay', { sec }),
    subOff: () => ipcRenderer.invoke('player:sub-off'),
    setChannels: (arg) => ipcRenderer.invoke('player:set-channels', arg),
    addSubtitle: (arg) => ipcRenderer.invoke('player:add-sub', arg),
    searchSubs: (arg) => ipcRenderer.invoke('player:search-subs', arg),
    // Input embebido (--wid): el hijo nativo no recibe eventos, el renderer
    // los reenvía. oscState/oscMenu empujan UI state al OSC estilo Android.
    mouse: (x, y) => ipcRenderer.invoke('player:mouse', { x, y }),
    click: (x, y) => ipcRenderer.invoke('player:click', { x, y }),
    key: (name) => ipcRenderer.invoke('player:key', { name }),
    oscState: (arg) => ipcRenderer.invoke('player:osc-state', arg),
    oscMenu: (arg) => ipcRenderer.invoke('player:osc-menu', arg),
    stop: () => ipcRenderer.invoke('player:stop'),
    onEvent: (cb) => {
      const wrapped = (_e, ev) => cb(ev)
      ipcRenderer.on('player:event', wrapped)
      return () => ipcRenderer.removeListener('player:event', wrapped)
    },
  },
  // Cloud-proxy WARP — misma superficie que el plugin CloudProxy de Android.
  cloudProxy: {
    connect: () => ipcRenderer.invoke('cloud:connect'),
    disconnect: () => ipcRenderer.invoke('cloud:disconnect'),
    disconnectBackground: () => ipcRenderer.invoke('cloud:disconnect-background'),
    getStatus: () => ipcRenderer.invoke('cloud:status'),
  },
  // RiseupVPN — guardar el .ovpn generado / importarlo a NetworkManager /
  // levantar el túnel con openvpn del sistema (Linux).
  riseup: {
    save: (conf) => ipcRenderer.invoke('riseup:save', { conf }),
    import: (conf) => ipcRenderer.invoke('riseup:import', { conf }),
    connect: (conf) => ipcRenderer.invoke('riseup:connect', { conf }),
    disconnect: () => ipcRenderer.invoke('riseup:disconnect'),
    status: () => ipcRenderer.invoke('riseup:status'),
    install: () => ipcRenderer.invoke('riseup:install'),
  },
  // Fullscreen de la ventana (mismo comportamiento que el player Android).
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  isFullscreen: () => ipcRenderer.invoke('win:fullscreen-state'),
  // Mini reproductor PiP de escritorio (ventana pequeña siempre-encima).
  pipWindow: (on) => ipcRenderer.invoke('win:pip', on),
  onFullscreenChange: (cb) => {
    const wrapped = (_e, on) => cb(on)
    ipcRenderer.on('win:fullscreen-changed', wrapped)
    return () => ipcRenderer.removeListener('win:fullscreen-changed', wrapped)
  },
  // YouTube — equivalente del plugin Youtube Android (NewPipeExtractor),
  // implementado con yt-dlp en el proceso principal.
  youtube: {
    resolve: (arg) => ipcRenderer.invoke('youtube:resolve', arg),
    search: (arg) => ipcRenderer.invoke('youtube:search', arg),
    searchMore: (arg) => ipcRenderer.invoke('youtube:search-more', arg),
    suggest: (arg) => ipcRenderer.invoke('youtube:suggest', arg),
    getChannel: (arg) => ipcRenderer.invoke('youtube:get-channel', arg),
    getChannelInfo: (arg) => ipcRenderer.invoke('youtube:get-channel-info', arg),
  },
  // Torrent P2P — equivalente del plugin TorrentEngine Android
  // (jlibtorrent), implementado con WebTorrent en el proceso principal.
  torrent: {
    start: (arg) => ipcRenderer.invoke('torrent:start', arg),
    listFiles: (arg) => ipcRenderer.invoke('torrent:listFiles', arg),
    download: (arg) => ipcRenderer.invoke('torrent:download', arg),
    listDownloads: () => ipcRenderer.invoke('torrent:listDownloads'),
    deleteDownload: (arg) => ipcRenderer.invoke('torrent:deleteDownload', arg),
    stop: () => ipcRenderer.invoke('torrent:stop'),
    status: () => ipcRenderer.invoke('torrent:status'),
    on: (handler) => {
      const wrapped = (_e, ev) => handler(ev)
      ipcRenderer.on('torrent-event', wrapped)
      return () => ipcRenderer.removeListener('torrent-event', wrapped)
    },
  },
  log: (...args) => ipcRenderer.send('renderer-log', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
  // Sync LAN (equivalente del plugin Android @optopus/sync-server): los
  // métodos devuelven promesas con la misma forma que el plugin Capacitor;
  // `on` suscribe a los eventos del servidor (pairRequest, playReceived…).
  sync: {
    start: () => ipcRenderer.invoke('sync:start'),
    stop: () => ipcRenderer.invoke('sync:stop'),
    getDeviceInfo: () => ipcRenderer.invoke('sync:device-info'),
    setLocalData: (arg) => ipcRenderer.invoke('sync:set-local-data', arg),
    getReceivedData: () => ipcRenderer.invoke('sync:received-data'),
    clearReceivedData: () => ipcRenderer.invoke('sync:clear-received'),
    allowDevice: (arg) => ipcRenderer.invoke('sync:allow-device', arg),
    answerPair: (arg) => ipcRenderer.invoke('sync:answer-pair', arg),
    getPairedDevices: () => ipcRenderer.invoke('sync:paired-devices'),
    forgetDevices: () => ipcRenderer.invoke('sync:forget-devices'),
    getDiscoveredDevices: () => ipcRenderer.invoke('sync:discovered'),
    on: (handler) => {
      const wrapped = (_e, ev) => handler(ev)
      ipcRenderer.on('sync-event', wrapped)
      return () => ipcRenderer.removeListener('sync-event', wrapped)
    },
  },
  // Paridad con el WebView oculto/relay de Android: resolver headless,
  // reproducción en ventana propia y relay de origen por el proxy local.
  embed: {
    resolve: (arg) => ipcRenderer.invoke('embed:resolve', arg),
    play: (arg) => ipcRenderer.invoke('embed:play', arg),
    relay: (arg) => ipcRenderer.invoke('embed:relay', arg),
    relayStop: (arg) => ipcRenderer.invoke('embed:relay-stop', arg),
    closeAll: () => ipcRenderer.invoke('embed:close-all'),
    onState: (cb) => {
      const wrapped = (_e, payload) => cb(payload)
      ipcRenderer.on('embed:state', wrapped)
      return () => ipcRenderer.removeListener('embed:state', wrapped)
    },
  },
  // DLNA "Enviar a TV" — paridad con openDlna() de Android.
  cast: {
    dlna: (arg) => ipcRenderer.invoke('cast:dlna', arg),
    dlnaScan: (arg) => ipcRenderer.invoke('cast:dlna-scan', arg),
  },
  // Update de escritorio — paridad con appUpdater: check → download
  // (progreso por octo:update:progress) → install lanza el instalador.
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    open: (arg) => ipcRenderer.invoke('update:open', arg),
    download: (arg) => ipcRenderer.invoke('update:download', arg),
    install: (arg) => ipcRenderer.invoke('update:install', arg),
    onProgress: (cb) => {
      const f = (_e, p) => cb(p)
      ipcRenderer.on('octo:update:progress', f)
      return () => ipcRenderer.removeListener('octo:update:progress', f)
    },
  },
})
