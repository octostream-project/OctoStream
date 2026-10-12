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
  connect: () => api().connect(),
  disconnect: () => api().disconnect(),
  disconnectBackground: () => api().disconnectBackground(),
  getStatus: () => api().getStatus(),
}
