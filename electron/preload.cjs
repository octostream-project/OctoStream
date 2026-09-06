const { contextBridge } = require('electron')

// Minimal, safe surface exposed to the renderer. contextIsolation + sandbox keep
// Node APIs out of the web page; only this curated object is reachable as window.optopus.
contextBridge.exposeInMainWorld('optopus', {
  platform: 'electron',
  version: '1.0.0',
  isElectron: true,
})
