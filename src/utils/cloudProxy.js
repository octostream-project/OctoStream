// Fachada multiplataforma de CloudProxy (WARP/Aether):
// - Electron: window.octostream.cloudProxy (IPC al proceso principal, que
//   lanza el binario aether empaquetado igual que hace el plugin Android).
// - Android: plugin Capacitor @octostream/cloud-proxy (libaether.so).
// - Web: stub del plugin — devuelve 'unsupported'.
// La superficie es la del plugin: connect/disconnect/disconnectBackground/
// getStatus.

async function api() {
  const bridge = window.octostream?.cloudProxy
  if (bridge) return bridge
  const { CloudProxy } = await import('@octostream/cloud-proxy')
  return CloudProxy
}

export const CloudProxy = {
  connect: () => api().then(a => a.connect()),
  disconnect: () => api().then(a => a.disconnect()),
  disconnectBackground: () => api().then(a => a.disconnectBackground()),
  getStatus: () => api().then(a => a.getStatus()),
}
