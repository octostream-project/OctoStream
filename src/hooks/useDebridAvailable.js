import { useState, useEffect } from 'react'
import { debridAvailable } from '../plugins/bundled/alldebrid.js'
import { subscribeWarpStatus } from '../utils/warpStatus.js'

// Disponibilidad debrid reactiva para la UI: clave configurada + ruta VPS
// válida en Android (regla: todo debrid por VPS; sin VPS no aparece).
// Se reevalúa al cambiar el estado del plano y cada 30 s — el gate duro
// por petición vive en httpClient.requireDebridRoute, esto es solo cosmético.
export function useDebridAvailable() {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    let alive = true
    const check = () => {
      debridAvailable()
        .then(v => { if (alive) setOk(v) })
        .catch(() => { if (alive) setOk(false) })
    }
    check()
    const unsub = subscribeWarpStatus(check)
    const t = setInterval(check, 30000)
    return () => { alive = false; unsub(); clearInterval(t) }
  }, [])
  return ok
}
