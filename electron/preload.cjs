const { contextBridge, ipcRenderer } = require('electron')

// Minimal, safe surface exposed to the renderer. contextIsolation + sandbox keep
// Node APIs out of the web page; only this curated object is reachable as window.optopus.
contextBridge.exposeInMainWorld('optopus', {
  platform: 'electron',
  version: '1.0.0',
  isElectron: true,
  proxyPort: 19588,
  proxyUrl: 'http://127.0.0.1:19588/proxy?url=',
  proxyBase: 'http://127.0.0.1:19588',
  getLanProxyUrl: () => ipcRenderer.invoke('get-lan-proxy-url'),
})
