const { app, BrowserWindow, shell, session } = require('electron')
const path = require('path')

// Inject custom headers (User-Agent, Referer, Origin) for HLS stream requests.
// TDT Spain streams from RTVE/Atresplayer/Mediaset require these headers.
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url
    // Only modify media/stream requests to known TDT domains
    if (/rtve\.|atresplayer\.|mediaset\.|tdtchannels\.|tdtspain\.|doubleclick\.net/i.test(url)) {
      if (!details.requestHeaders['User-Agent']) {
        details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
      }
      if (/rtve\./i.test(url)) {
        details.requestHeaders['Origin'] = 'https://www.rtve.es'
        details.requestHeaders['Referer'] = 'https://www.rtve.es/'
      } else if (/atresplayer\./i.test(url)) {
        details.requestHeaders['Origin'] = 'https://www.atresplayer.com'
        details.requestHeaders['Referer'] = 'https://www.atresplayer.com/'
      } else if (/mediaset\./i.test(url)) {
        details.requestHeaders['Origin'] = 'https://www.mediasetinfinity.es'
        details.requestHeaders['Referer'] = 'https://www.mediasetinfinity.es/'
      } else if (/tdtchannels\./i.test(url)) {
        details.requestHeaders['Referer'] = 'https://www.tdtchannels.com/'
      }
    }
    callback({ requestHeaders: details.requestHeaders })
  })
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f172a',
    title: 'Optopus Stream',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  })

  // Prevent the renderer from opening arbitrary windows. External/custom-protocol
  // links (vlc://, mpv://, https://) are delegated to the OS handler so the app
  // never spawns uncontrolled BrowserWindows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = (() => { try { return new URL(url) } catch { return null } })()
    const allowed = ['http:', 'https:', 'vlc:', 'mpv:', 'magnet:']
    if (parsed && allowed.includes(parsed.protocol)) {
      shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })

  // Block navigation to unknown origins (defends against redirects to file:/data:).
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://localhost:5173') || url.startsWith('file://')) return
    event.preventDefault()
  })

  const isDev = !app.isPackaged

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
