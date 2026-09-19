// Lazy loaders for player libraries.
// These dynamic imports let Vite code-split hls.js and shaka-player into
// separate chunks so they are only downloaded when needed.

export async function loadHls() {
  const mod = await import('hls.js')
  return mod.default || mod
}

export async function loadShaka() {
  const mod = await import('shaka-player')
  return mod.default || mod
}
