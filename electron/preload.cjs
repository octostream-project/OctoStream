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
  // Prefijo del endpoint /ffmpeg (remux mkv/avi/ts → mp4 en el main).
  ffmpegUrl: proxy.ffmpegUrl,
  getLanProxyUrl: () => ipcRenderer.invoke('get-lan-proxy-url'),
  // Reproductores externos instalados en el sistema (mpv/VLC/ffplay).
  openExternalPlayer: (arg) => ipcRenderer.invoke('player:open-external', arg),
  // Cloud-proxy WARP — misma superficie que el plugin CloudProxy de Android.
  cloudProxy: {
    connect: () => ipcRenderer.invoke('cloud:connect'),
    disconnect: () => ipcRenderer.invoke('cloud:disconnect'),
    disconnectBackground: () => ipcRenderer.invoke('cloud:disconnect-background'),
    getStatus: () => ipcRenderer.invoke('cloud:status'),
  },
  // Fullscreen de la ventana (mismo comportamiento que el player Android).
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  isFullscreen: () => ipcRenderer.invoke('win:fullscreen-state'),
  onFullscreenChange: (cb) => {
    const wrapped = (_e, on) => cb(on)
    ipcRenderer.on('win:fullscreen-changed', wrapped)
    return () => ipcRenderer.removeListener('win:fullscreen-changed', wrapped)
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
})
