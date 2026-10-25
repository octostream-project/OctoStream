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

export const CloudProxy = {
  // opts.exitLoc: ubicación de salida WARP — "auto" (colo más cercano),
  // "random" (doble salto, otro país cualquiera) o código ISO ("DE","NL"…)
  // verificado contra el trace de Cloudflare por el propio aether.
  connect: (opts) => api().connect(opts),
  disconnect: () => api().disconnect(),
  disconnectBackground: () => api().disconnectBackground(),
  getStatus: () => api().getStatus(),
  setStrictMode: (enabled) =>
    typeof api().setStrictMode === 'function'
      ? api().setStrictMode({ enabled })
      : Promise.resolve({ enabled: false }),
  // Usar el túnel WARP de otro OctoStream en la LAN (misma IP de salida
  // para todos los dispositivos) — host = IP local; "" = modo local.
  setRemoteHost: (host) =>
    typeof api().setRemoteHost === 'function'
      ? api().setRemoteHost({ host })
      : Promise.resolve({ remote: '' }),
  // Compartir el túnel propio en la LAN (aether escucha 0.0.0.0).
  setShareLan: (enabled) =>
    typeof api().setShareLan === 'function'
      ? api().setShareLan({ enabled })
      : Promise.resolve({ enabled: false }),
  // Fetch ligado à rede física (fora do túnel Riseup). Só existe no
  // Android; rejeita noutras plataformas — o chamador deve fazer fallback.
  directFetch: (opts) =>
    typeof api().directFetch === 'function'
      ? api().directFetch(opts)
      : Promise.reject(new Error('directFetch unsupported')),
  riseupTunnelStatus: () =>
    typeof api().riseupTunnelStatus === 'function'
      ? api().riseupTunnelStatus()
      : Promise.resolve({ connected: false, connecting: false }),
}
