const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('optopus', {
  platform: 'electron',
  version: '1.0.0',
})
