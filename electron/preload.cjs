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
