import { useEffect, useRef, useState } from 'react'
import { checkForUpdate, AppUpdater } from '../utils/appUpdater.js'
import { isAndroidNative } from '../utils/platform.js'

// Comprueba version.json del repo al arrancar (Android) y muestra el diálogo
// de actualización: descarga con progreso → instalador del sistema.
// minCode > versionCode instalada → actualización forzosa (sin cancelar).
export default function UpdateChecker() {
  const [update, setUpdate] = useState(null)
  const [desktopUpdate, setDesktopUpdate] = useState(null)
  const [phase, setPhase] = useState('prompt') // prompt | downloading | needPerm | error | reinstall
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  const [reinstallApk, setReinstallApk] = useState(null) // {saved, name}
  const apkPath = useRef(null)

  useEffect(() => {
    if (isAndroidNative()) {
      const t = setTimeout(async () => {
        const u = await checkForUpdate()
        if (u) setUpdate(u)
      }, 8000)
      return () => clearTimeout(t)
    }
    // Electron: mismo check a GitHub releases (IPC update:check) — el diálogo
    // abre la página de la release para descargar el instalador del SO.
    if (window.octostream?.update?.check) {
      const t = setTimeout(async () => {
        try {
          const u = await window.octostream.update.check()
          if (u?.available) setDesktopUpdate(u)
        } catch { /* sin red: silencio */ }
      }, 8000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [])

  useEffect(() => {
    if (!isAndroidNative()) return undefined
    const sub = AppUpdater.addListener('downloadProgress', (p) => {
      if (p.percent >= 0) setPercent(p.percent)
    })
    return () => { sub.then((h) => h.remove()).catch(() => {}) }
  }, [])

  // Diálogo de actualización de escritorio — descarga manual desde la release.
  if (desktopUpdate) {
    return (
      <div data-tv-modal className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 p-4">
        <div className="w-[min(90vw,480px)] rounded-2xl bg-slate-900 p-6 shadow-2xl">
          <h2 className="text-xl font-bold text-white">Nueva versión {desktopUpdate.version}</h2>
          {desktopUpdate.notes ? (
            <p className="mt-3 whitespace-pre-line text-sm text-slate-300 max-h-40 overflow-y-auto">{desktopUpdate.notes}</p>
          ) : null}
          <div className="mt-6 flex justify-end gap-3">
            <button
              className="rounded-lg bg-slate-700 px-6 py-3 font-medium text-white focus:bg-emerald-600 focus:outline-none"
              onClick={() => setDesktopUpdate(null)}
              autoFocus
            >
              Ahora no
            </button>
            <button
              className="rounded-lg bg-slate-700 px-6 py-3 font-medium text-white focus:bg-emerald-600 focus:outline-none"
              onClick={() => {
                window.octostream?.update?.open?.(desktopUpdate.url)
                setDesktopUpdate(null)
              }}
            >
              Descargar
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!update) return null

  const startInstall = async () => {
    const perm = await AppUpdater.canInstallUnknownApps().catch(() => ({ allowed: true }))
    if (!perm.allowed) { setPhase('needPerm'); return }
    // Si falta el permiso, el plugin resuelve {needsPermission:true} en vez de
    // lanzar el instalador — sin esto la fase quedaba en "downloading" pillada.
    // La llamada queda pendiente hasta que la sesión de instalación termina:
    // {installed:true}, {aborted:true} (usuario canceló) o reject (error real).
    try {
      const r = await AppUpdater.installApk({ path: apkPath.current })
      if (r?.needsPermission) setPhase('needPerm')
      else if (r?.aborted) setPhase('prompt')
      else if (r?.installed) setUpdate(null)
    } catch (e) {
      if (String(e?.message || e).startsWith('incompatible')) {
        await startReinstall()
        return
      }
      setError(String(e?.message || e))
      setPhase('error')
    }
  }

  // Cambio de firma: la nueva APK no puede instalarse encima y la app muere
  // al desinstalarse, así que la reinstalación automática es imposible. Lo
  // más cercano: el NAVEGADOR descarga la APK en background — su notificación
  // "descarga completada" sobrevive a la desinstalación y al tocarla abre el
  // instalador del sistema.
  const startReinstall = async () => {
    if (apkPath.current) {
      const name = `octostream-${update.versionName}.apk`
      const res = await AppUpdater.copyToDownloads({ path: apkPath.current, name })
        .catch(() => ({ saved: false }))
      setReinstallApk(res)
    }
    setPhase('reinstall')
  }

  // Botón principal de la fase reinstall: navegador descargando + diálogo de
  // desinstalación encima. El usuario confirma, la app muere, la descarga
  // termina en el navegador → notificación → instalar.
  const uninstallAndUpdate = async () => {
    try { await AppUpdater.openUrl({ url: update.apkUrl }) } catch { /* sin navegador */ }
    await AppUpdater.uninstallSelf().catch(() => {})
  }

  // Fallback sin navegador (Android TV): descarga propia → copia a Descargas
  // públicas → desinstalar. El usuario instala luego desde un gestor de archivos.
  const downloadToDownloads = async () => {
    setPhase('downloading')
    setPercent(0)
    try {
      const r = await AppUpdater.downloadApk({ url: update.apkUrl, sha256: update.sha256 || undefined })
      apkPath.current = r.path
      await startReinstall()
    } catch (e) {
      setError(String(e?.message || e))
      setPhase('error')
    }
  }

  const download = async () => {
    if (update.signatureMismatch) { setPhase('reinstall'); return }
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

        {phase === 'reinstall' && (
          <>
            <p className="mt-3 text-sm text-slate-300">
              Esta versión está firmada con una clave distinta y Android no permite
              instalarla encima. Hay que desinstalar la app primero.
            </p>
            <p className="mt-3 text-sm text-amber-400">
              Se perderán ajustes, favoritos e historial.
            </p>
            <p className="mt-3 text-sm text-slate-300">
              Al pulsar &quot;Desinstalar y actualizar&quot; se abre el navegador
              descargando la nueva versión y aparece la desinstalación: confírmala y,
              cuando acabe la descarga, toca la notificación para instalar.
            </p>
            {reinstallApk?.saved && (
              <p className="mt-3 text-sm text-emerald-400">
                También hay una copia en Descargas ({reinstallApk.name}).
              </p>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <button className={btn} onClick={() => setUpdate(null)}>
                Cancelar
              </button>
              {!reinstallApk?.saved && (
                <button className={btn} onClick={downloadToDownloads}>
                  Descargar a Descargas
                </button>
              )}
              <button className={btn} onClick={uninstallAndUpdate} autoFocus>
                Desinstalar y actualizar
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
