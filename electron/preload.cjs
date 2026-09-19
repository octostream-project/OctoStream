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
})
