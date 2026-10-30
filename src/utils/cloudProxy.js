// Fachada multiplataforma de CloudProxy (WARP/Aether):
// - Electron: window.octostream.cloudProxy (IPC al proceso principal, que
//   lanza el binario aether empaquetado igual que hace el plugin Android).
// - Android: plugin Capacitor @octostream/cloud-proxy (libaether.so).
// - Web: stub del plugin — devuelve 'unsupported'.
// La superficie es la del plugin: connect/disconnect/disconnectBackground/
// getStatus.
//
// IMPORTANTE: import ESTÁTICO del plugin — registra 'CloudProxy' al cargar
// la app igual que hacía la versión estable. Un import dinámico en frío
// (chunk + __vite__mapDeps) resultó frágil en WebViews de Android TV
// antiguos y podía dejar la app bloqueada en "Conectando WARP".

import { CloudProxy as NativeCloudProxy } from '@octostream/cloud-proxy'

function api() {
  const bridge = window.octostream?.cloudProxy
  return bridge || NativeCloudProxy
}

// Intención del usuario respecto a la red: el watchdog de warpStatus
// solo reconecta un plano caído cuando la última acción fue encender.
const NET_INTENT_KEY = 'octostream_net_intent'
const setNetIntent = (on) => { try { localStorage.setItem(NET_INTENT_KEY, on ? '1' : '0') } catch { /* sin storage */ } }
export const getNetIntent = () => {
  try { return localStorage.getItem(NET_INTENT_KEY) !== '0' } catch { return true }
}

export const CloudProxy = {
  // opts.exitLoc: ubicación de salida WARP — "auto" (colo más cercano),
  // "random" (doble salto, otro país cualquiera) o código ISO ("DE","NL"…)
  // verificado contra el trace de Cloudflare por el propio aether.
  connect: (opts) => { setNetIntent(true); return api().connect(opts) },
  disconnect: () => { setNetIntent(false); return api().disconnect() },
  disconnectBackground: () => { setNetIntent(false); return api().disconnectBackground() },
  getStatus: () => api().getStatus(),
  setStrictMode: (enabled) =>
    typeof api().setStrictMode === 'function'
      ? api().setStrictMode({ enabled })
      : Promise.resolve({ enabled: false }),
  // Usar un proxy WARP remoto accesible en :1819/:1820 (compatibilidad) —
  // con usuario SSH el host se interpreta como VPS alcanzado por túnel.
  // "" = modo local.
  setRemoteHost: (host) =>
    typeof api().setRemoteHost === 'function'
      ? api().setRemoteHost({ host })
      : Promise.resolve({ remote: '' }),
  // Credenciales SSH del remoto: con user+pass el host remoto se alcanza
  // por túnel SSH (port-forward al proxy loopback del VPS) — misma IP de
  // salida para todos desde cualquier red, sin Tailscale ni apps extra.
  // user '' = remoto plano LAN.
  setRemoteSsh: (opts) =>
    typeof api().setRemoteSsh === 'function'
      ? api().setRemoteSsh(opts || {})
      : Promise.resolve({ ssh: false }),
  // Credenciales SSH guardadas en el plugin (la clave se descifra del
  // almacenamiento cifrado con Android Keystore). Solo Android.
  getRemoteSsh: () =>
    typeof api().getRemoteSsh === 'function'
      ? api().getRemoteSsh()
      : Promise.resolve({ user: '', pass: '', port: 22 }),
  // Host key SSH pendiente de confirmación (la que rechazó el último
  // connect con SSH_HOST_KEY_*). Permite abrir el diálogo de aceptación
  // desde cualquier aviso, no solo desde el botón "Probar". Solo Android.
  getPendingHostKey: () =>
    typeof api().getPendingHostKey === 'function'
      ? api().getPendingHostKey()
      : Promise.resolve({}),
  // Fija la host key pendiente del VPS tras la confirmación del usuario
  // (TOFU visible — la huella se mostró en el diálogo). Solo Android.
  trustRemoteHost: () =>
    typeof api().trustRemoteHost === 'function'
      ? api().trustRemoteHost()
      : Promise.reject(new Error('trustRemoteHost unsupported')),
  // Fetch ligado a la red física (hosts con geo-bypass). Só existe en
  // Android; rejeita noutras plataformas — o chamador deve fazer fallback.
  directFetch: (opts) =>
    typeof api().directFetch === 'function'
      ? api().directFetch(opts)
      : Promise.reject(new Error('directFetch unsupported')),
}
