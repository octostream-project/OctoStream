// Cliente de duck.ai para subtítulos IA: dictado (audio→texto) y chat
// (traducción). Replica el flujo de duck2api (github.com/aurora-develop/duck2api):
// 1) GET /duckchat/v1/status con x-vqd-accept → challenge JS ofuscado en
//    x-vqd-hash-1. Se ejecuta en el DOM real del WebView (mejor fingerprint
//    que el mock goja/jsdom del PoC).
// 2) Se hashean los client_hashes con SHA-256 y se devuelve el token base64.
// 3) POST /dictation (audio crudo) o /chat (SSE) con el token + fe-signals.
// Los endpoints son internos y pueden cambiar; ante 418/429 se regenera el
// token una vez y se reintenta.

import { getItemSync } from './storage.js'
import { isAndroidNative } from './platform.js'
import { waitForVpnTunnel } from './httpClient.js'
import { waitForWarp, warpAutoConnectEnabled } from './warpStatus.js'

const DUCK = 'https://duck.ai'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const STATUS_URL = `${DUCK}/duckchat/v1/status`
const DICTATION_URL = `${DUCK}/duckchat/v1/dictation`
const CHAT_URL = `${DUCK}/duckchat/v1/chat`
const TOKEN_TTL_MS = 4 * 60 * 1000 // los tokens VQD caducan rápido

let vqdCache = { token: null, at: 0 }
let vqdPromise = null
let feVersion = null
let feVersionAt = 0

// --- helpers ---

const b64 = bytes => {
  let bin = ''
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i += 8192) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + 8192))
  }
  return btoa(bin)
}
const b64encode = str => btoa(unescape(encodeURIComponent(str)))
const sha256b64 = async s => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)))
  return b64(digest)
}
const randHex = n => {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('')
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function feSignals() {
  const now = Date.now()
  const rnd = n => Math.floor(Math.random() * n)
  const impression = 50 + rnd(100)
  const action = impression + 5000 + rnd(25000)
  const finish = action + 1000 + rnd(9000)
  const startChat = finish + 10 + rnd(90)
  const end = startChat + rnd(10)
  return b64encode(JSON.stringify({
    start: now - end,
    events: [
      { name: 'onboarding_impression', delta: impression },
      { name: 'action', delta: action, trusted: true },
      { name: 'onboarding_finish', delta: finish },
      { name: 'startNewChat_free', delta: startChat },
    ],
    end,
  }))
}

const commonHeaders = () => ({
  'user-agent': UA,
  origin: DUCK,
  referer: `${DUCK}/`,
})

// Misma política fail-closed que httpClient: con Riseup o WARP en
// autoconnect nada sale por la física antes del CONNECTED.
async function gateVpn() {
  if (!isAndroidNative()) return
  await waitForVpnTunnel()
  if (warpAutoConnectEnabled() && !(await waitForWarp(30000))) {
    const error = new Error('Aether/WARP no está conectado; la petición se bloqueó.')
    error.code = 'WARP_NOT_CONNECTED'
    throw error
  }
}

// Fetch que funciona en Android (CapacitorHttp intercepta fetch nativamente)
// y web. Electron: el preload expone un puente si lo hay; si no, error claro.
async function duckFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const octo = typeof window !== 'undefined' ? window.octostream : null
  if (!isAndroidNative() && octo?.duckFetch) {
    return octo.duckFetch({ url, method, headers, body })
  }
  await gateVpn()
  const res = await fetch(url, { method, headers, body, signal })
  const text = await res.text()
  const hdrs = {}
  res.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v })
  return { status: res.status, text, headers: hdrs }
}

// Ejecuta el challenge anti-bot de duck.ai en el DOM de la página (WebView
// real = fingerprint completo). El script es un async-IIFE que devuelve
// {client_hashes, meta, ...}. Eval indirecto = scope global (document,
// window, navigator accesibles como en la página real de duck.ai).
async function runChallenge(js) {
  const result = (0, eval)(js)
  return result instanceof Promise ? await result : result
}

async function makeVqdToken() {
  const r = await duckFetch(STATUS_URL, {
    headers: { ...commonHeaders(), accept: '*/*', 'x-vqd-accept': '1' },
  })
  const enc = r.headers['x-vqd-hash-1']
  if (!enc) throw new Error(`duck.ai status sin challenge (HTTP ${r.status})`)
  const challenge = decodeURIComponent(escape(atob(enc)))
  const res = await runChallenge(challenge)
  if (!res?.client_hashes?.length) throw new Error('challenge duck.ai sin client_hashes')
  const out = {
    ...res,
    client_hashes: await Promise.all(res.client_hashes.map(sha256b64)),
    meta: {
      ...res.meta,
      origin: DUCK,
      stack: 'Error\nat l (https://duck.ai/x.js:1:1)',
      duration: String(30 + Math.floor(Math.random() * 470)),
    },
  }
  return b64encode(JSON.stringify(out))
}

async function getVqdToken(force = false) {
  if (!force && vqdCache.token && Date.now() - vqdCache.at < TOKEN_TTL_MS) {
    return vqdCache.token
  }
  if (vqdPromise) return vqdPromise
  vqdPromise = makeVqdToken()
    .then(t => { vqdCache = { token: t, at: Date.now() }; return t })
    .finally(() => { vqdPromise = null })
  return vqdPromise
}

async function getFeVersion() {
  if (feVersion && Date.now() - feVersionAt < 30 * 60 * 1000) return feVersion
  try {
    const r = await duckFetch(DUCK + '/', { headers: { 'user-agent': UA } })
    const tag = r.text.match(/data-version-tag="([^"]+)"/)
    const sha = r.text.match(/data-version-sha="([^"]+)"/)
    if (tag && sha) {
      feVersion = `${tag[1]}-${sha[1]}`
      feVersionAt = Date.now()
    }
  } catch { /* opcional: la cabecera solo refuerza el anti-bot */ }
  return feVersion || ''
}

async function duckPost(url, { contentType, body, retry = true, signal } = {}) {
  const token = await getVqdToken()
  const fev = await getFeVersion()
  const r = await duckFetch(url, {
    method: 'POST',
    signal,
    headers: {
      ...commonHeaders(),
      'Content-Type': contentType,
      accept: contentType === 'application/json' ? 'text/event-stream' : 'application/json',
      'x-vqd-hash-1': token,
      'x-ddg-journey-id': randHex(16),
      'x-fe-signals': feSignals(),
      ...(fev ? { 'x-fe-version': fev } : {}),
      priority: 'u=1, i',
    },
    body,
  })
  // 418/429 = challenge o rate-limit: un reintento con token fresco suele pasar.
  if ((r.status === 418 || r.status === 429 || r.status >= 500) && retry) {
    await sleep(900)
    await getVqdToken(true)
    return duckPost(url, { contentType, body, retry: false, signal })
  }
  return r
}

/** Transcribe un WAV (bytes o base64) → texto. Devuelve '' si no hay voz. */
export async function dictateWav(wav, signal) {
  const bytes = typeof wav === 'string'
    ? Uint8Array.from(atob(wav), c => c.charCodeAt(0))
    : wav
  const r = await duckPost(DICTATION_URL, {
    contentType: 'audio/wav',
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    signal,
  })
  if (r.status !== 200) throw new Error(`Dictation HTTP ${r.status}`)
  let data
  try { data = JSON.parse(r.text) } catch { throw new Error('Dictation: respuesta no JSON') }
  if (data.action === 'error') throw new Error(`Dictation: ${data.type || 'error'}`)
  return (data.text || '').trim()
}

const DEFAULT_MODEL = 'gpt-5.4-nano'

/** Chat completion (SSE ensamblado). Devuelve el texto del mensaje final. */
export async function duckChat(messages, { model, signal, canUploadFiles } = {}) {
  const r = await duckPost(CHAT_URL, {
    contentType: 'application/json',
    body: JSON.stringify({
      model: model || getItemSync('octostream_ai_model') || DEFAULT_MODEL,
      metadata: { toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false } },
      messages,
      canUseTools: true,
      canUploadFiles: !!canUploadFiles,
      reasoningEffort: 'none',
      durableStream: {
        messageId: '', conversationId: '',
        publicKey: { alg: '', e: '', ext: false, key_ops: [], kty: '', n: '', use: '' },
      },
    }),
    signal,
  })
  if (r.status !== 200) {
    const code = (r.text.match(/ERR_[A-Z_]+/) || [r.status])[0]
    throw new Error(`Chat HTTP ${r.status} (${code})`)
  }
  let text = ''
  for (const line of r.text.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const j = JSON.parse(line.slice(5).trim())
      if (typeof j.message === 'string') text += j.message
    } catch { /* líneas non-JSON / [DONE] */ }
  }
  return text.trim()
}

// Modelos gratuitos con vision (catálogo /duckchat/v1/models,
// supportsImageUpload + tier free). gpt-6-luna lleva la etiqueta
// EVERYDAY_USE: pensado para volumen alto sin quemar el límite tan rápido.
const VISION_MODELS = ['gpt-6-luna', 'claude-haiku-4-5', 'gpt-5.4-mini']

/** OCR/vision: manda una imagen (dataURL base64) + prompt → texto. */
export async function duckChatImage(dataUrl, prompt, { signal } = {}) {
  const mime = (dataUrl.match(/^data:(image\/\w+)/) || [null, 'image/jpeg'])[1]
  const content = [
    { type: 'image', mimeType: mime, image: dataUrl },
    { type: 'text', text: prompt },
  ]
  let lastErr = null
  for (const model of VISION_MODELS) {
    try {
      return await duckChat([{ role: 'user', content }], {
        model: getItemSync('octostream_ai_vision_model') || model,
        canUploadFiles: true,
        signal,
      })
    } catch (e) {
      lastErr = e
      if (signal?.aborted) throw e
    }
  }
  throw lastErr || new Error('Vision: sin modelo disponible')
}

/** Comprueba rápida de que duck.ai responde (para mostrar/ocultar la opción). */
export async function duckAiAvailable() {
  try {
    await getVqdToken()
    return true
  } catch { return false }
}
