import { useEffect, useRef, useState } from 'react'
import { checkForUpdate, AppUpdater } from '../utils/appUpdater.js'
import { isAndroidNative } from '../utils/platform.js'

// Comprueba version.json del repo al arrancar (Android) y muestra el diálogo
// de actualización: descarga con progreso → instalador del sistema.
// minCode > versionCode instalada → actualización forzosa (sin cancelar).
export default function UpdateChecker() {
  const [update, setUpdate] = useState(null)
  const [phase, setPhase] = useState('prompt') // prompt | downloading | needPerm | error
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  const apkPath = useRef(null)

  useEffect(() => {
    if (!isAndroidNative()) return undefined
    const t = setTimeout(async () => {
      const u = await checkForUpdate()
      if (u) setUpdate(u)
    }, 8000)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const sub = AppUpdater.addListener('downloadProgress', (p) => {
      if (p.percent >= 0) setPercent(p.percent)
    })
    return () => { sub.then((h) => h.remove()).catch(() => {}) }
  }, [])

  if (!update) return null

  const startInstall = async () => {
    const perm = await AppUpdater.canInstallUnknownApps().catch(() => ({ allowed: true }))
    if (!perm.allowed) { setPhase('needPerm'); return }
    await AppUpdater.installApk({ path: apkPath.current })
  }

  const download = async () => {
    setPhase('downloading')
    setPercent(0)
    try {
      const r = await AppUpdater.downloadApk({ url: update.apkUrl, sha256: update.sha256 || undefined })
      apkPath.current = r.path
      await startInstall()
    } catch (e) {
      setError(String(e?.message || e))
      setPhase('error')
    }
  }

  const btn = 'rounded-lg bg-slate-700 px-6 py-3 font-medium text-white focus:bg-emerald-600 focus:outline-none'

  return (
    <div data-tv-modal className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 p-4">
      <div className="w-[min(90vw,480px)] rounded-2xl bg-slate-900 p-6 shadow-2xl">
        <h2 className="text-xl font-bold text-white">
          {phase === 'error' ? 'Error al actualizar' : `Nueva versión ${update.versionName}`}
        </h2>

        {phase === 'prompt' && (
          <>
            {update.notes ? <p className="mt-3 whitespace-pre-line text-sm text-slate-300">{update.notes}</p> : null}
            <div className="mt-6 flex justify-end gap-3">
              {!update.force && (
                <button className={btn} onClick={() => setUpdate(null)} autoFocus={!update.force}>
                  Ahora no
                </button>
              )}
              <button className={btn} onClick={download} autoFocus>
                Actualizar
              </button>
            </div>
          </>
        )}

        {phase === 'downloading' && (
          <div className="mt-5">
            <div className="h-3 w-full overflow-hidden rounded-full bg-slate-700">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.max(percent, 3)}%` }} />
            </div>
            <p className="mt-2 text-center text-sm text-slate-400">
              Descargando… {percent > 0 ? `${percent}%` : ''}
            </p>
          </div>
        )}

        {phase === 'needPerm' && (
          <>
            <p className="mt-3 text-sm text-slate-300">
              Android requiere permiso para instalar la actualización. Activa
              &quot;Permitir desde esta fuente&quot; y vuelve.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button className={btn} onClick={() => AppUpdater.openInstallSettings()} autoFocus>
                Abrir ajustes
              </button>
              <button className={btn} onClick={startInstall}>
                Instalar
              </button>
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <p className="mt-3 text-sm text-red-400">{error}</p>
            <div className="mt-6 flex justify-end gap-3">
              {!update.force && (
                <button className={btn} onClick={() => setUpdate(null)}>Cerrar</button>
              )}
              <button className={btn} onClick={download} autoFocus>Reintentar</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
