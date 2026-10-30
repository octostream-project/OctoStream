import './utils/compatPolyfills.js'
import { applyUiScale } from './utils/uiScale.js'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'
import { initStorageMirror } from './utils/storage.js'

applyUiScale()

// Hidratar el espejo IndexedDB antes del render: favoritos/historial solo
// en IDB (localStorage borrado o cuota llena) se restauran/sirven en
// memoria. ~5-15ms — sin la espera, una lectura temprana podría
// "no encontrar" un favorito y sobrescribirlo vacío.
initStorageMirror().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>,
  )
})
