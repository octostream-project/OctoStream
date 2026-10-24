// Orquestación de subtítulos IA (duck.ai). El menú nativo de subtítulos
// emite 'aiSubsRequested' con {imdbId, season, episode}; aquí se decide:
//
// 1) Si el addon OpenSubtitles/Stremio tiene el sub en español → aplicarlo
//    directo (es lo que el usuario quiere y no hace falta IA).
// 2) Si solo hay otra lengua (inglés preferido) → descargar, parsear y
//    traducir los textos con duck.ai chat manteniendo los tiempos exactos.
// 3) Si no hay nada → tap de audio headless (startAiAudio): chunks WAV de
//    20 s → dictado duck.ai → traducción → cues progresivos.
//
// La visualización corre por la vía del subtítulo externo (setExternalCues):
// la reproducción nunca se toca.

import { ExoPlayer } from '@octostream/exo-player'
import { isAndroidNative } from './platform.js'
import { httpGetJson, httpGetText } from './httpClient.js'
import { dictateWav, duckChat } from './duckAi.js'
import { getJsonSync, setJsonSync } from './storage.js'
import { parseStreamLang } from './streamMeta.js'

const OPENSUBS_STREMIO = 'https://opensubtitles-v3.strem.io'
const TRANSLATE_BATCH_CUES = 30 // cues por petición de chat (~1-2 s c/u)
const MAX_LINE = 42 // chars por línea al trocear texto dictado
const DICTATE_CHUNK_SEC = 45 // menos llamadas = menos riesgo de rate-limit
const DICTATE_RETRIES = 2 // reintentos extra ante 418/429 persistentes
const DICTATE_RETRY_DELAY_MS = 20000
const CACHE_KEY = 'octostream_ai_subs_cache'
const CACHE_MAX = 5 // medios con subs IA cacheados
const VISION_MAX_CALLS = 40 // tope de fotogramas OCR por sesión (rate-limit)
const VISION_MAX_ERRORS = 3 // errores seguidos → apagar el OCR de la sesión
const VISION_CUE_MS = 3500 // cuánto dura el cue de un fotograma detectado

let listenersReady = false
let active = null // { abort, cues:{times,texts}, queue:Promise, transcribing }
let lastOsdAt = 0

function osd(text) {
  const now = Date.now()
  if (now - lastOsdAt < 1200) return // los Toast se pisan entre sí
  lastOsdAt = now
  ExoPlayer.osdMessage({ text }).catch(() => {})
}
const osdNow = text => { lastOsdAt = Date.now(); ExoPlayer.osdMessage({ text }).catch(() => {}) }

const mmss = ms => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- caché de subs IA: re-ver no repite ni una llamada ----------
// LRU pequeño en localStorage ({key → {times, texts, at}}). Una peli de 2 h
// con ~1500 cues ocupa ~300 KB; se podan las entradas más viejas.

function cacheRead(key) {
  try {
    const all = getJsonSync(CACHE_KEY) || {}
    return all[key] || null
  } catch { return null }
}

function cacheWrite(key, cues) {
  try {
    const all = getJsonSync(CACHE_KEY) || {}
    all[key] = { times: cues.times, texts: cues.texts, at: Date.now() }
    const keys = Object.keys(all).sort((a, b) => (all[a].at || 0) - (all[b].at || 0))
    while (keys.length > CACHE_MAX) delete all[keys.shift()]
    setJsonSync(CACHE_KEY, all)
  } catch { /* caché llena/corrupta: no es fatal */ }
}

function mediaKey(meta) {
  if (meta?.imdbId) {
    return `${meta.imdbId}:${meta.season || 0}:${meta.episode || 0}`
  }
  // Solo URIs estables: las URLs debrid/torrent firmadas rotan entre sesiones.
  const u = String(meta?.url || '')
  return /^(content|file):\/\//.test(u) ? `file:${u}` : null
}

// ---------- parseo SRT / WebVTT → {times:[[a,b]], texts:[]} ----------

function subTimeToMs(t) {
  // HH:MM:SS.mmm (SRT/VTT) o MM:SS.mmm (VTT corto).
  const m = t.trim().match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/)
  if (!m) return null
  return (+m[1] || 0) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+m[4].padEnd(3, '0'))
}

export function parseSubtitleText(text) {
  const times = []
  const texts = []
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  for (const block of clean.split(/\n{2,}/)) {
    const lines = block.split('\n').map(l => l.trimEnd()).filter(l => l !== '')
    const timeIdx = lines.findIndex(l => l.includes('-->'))
    if (timeIdx === -1) continue
    const [a, b] = lines[timeIdx].split('-->').map(s => s.trim().split(/\s+/)[0])
    const start = subTimeToMs(a); const end = subTimeToMs(b)
    if (start == null || end == null || end <= start) continue
    const body = lines.slice(timeIdx + 1)
      .map(l => l.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, ''))
      .join('\n').trim()
    if (!body) continue
    times.push([start, end])
    texts.push(body)
  }
  return { times, texts }
}

// ---------- traducción con duck.ai chat ----------

const TRANSLATE_PROMPT = arr =>
  'Eres un traductor de subtítulos para una app de TV. Traduce cada elemento del ' +
  'array JSON al español castellano manteniendo EXACTAMENTE el mismo número de ' +
  'elementos, el mismo orden y los saltos de línea internos (\\n). No añadas ' +
  'comentarios, numeración ni formato markdown. Responde SOLO con el array JSON traducido.\n' +
  JSON.stringify(arr)

// Fallbacks de traducción sin duck.ai (en orden de privacidad):
// 1) Lingva — frontend privado de Google Translate (sin tracking). Varias
//    instancias públicas porque se caen a menudo: cuando Google las bloquea
//    devuelven 200 con el texto SIN traducir → se detecta comparando con la
//    entrada si el idioma detectado no era ya español.
// 2) Google gtx (el endpoint de la web de Google) como última red.
const LINGVA_MIRRORS = [
  'https://lingva.ml',
  'https://translate.plausibility.cloud',
  'https://lingva.lunar.icu',
]

async function lingvaTranslateLines(lines, signal) {
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n')
  let lastErr = null
  for (const base of LINGVA_MIRRORS) {
    try {
      const data = await httpGetJson(
        `${base}/api/v1/auto/es/${encodeURIComponent(numbered)}`, {}, signal)
      const merged = String(data?.translation || '').trim()
      if (!merged) continue
      // Eco roto de Lingva: fuente detectada no-es pero salida == entrada.
      if (data?.info?.detectedSource && data.info.detectedSource !== 'es' &&
          normVision(merged.replace(/^\s*\d+[.)]\s*/gm, '')) === normVision(lines.join('\n'))) {
        continue
      }
      const out = merged.split('\n').map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim())
      return out.length === lines.length ? out : [merged]
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      lastErr = e
    }
  }
  throw lastErr || new Error('Lingva sin instancia')
}

async function gtxTranslateLines(lines, signal) {
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n')
  const url = 'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(numbered)}`
  const data = await httpGetJson(url, {}, signal)
  const merged = (data?.[0] || []).map(seg => seg?.[0] || '').join('')
  if (!merged.trim()) throw new Error('gtx vacío')
  const out = merged.split('\n')
    .map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim())
  // Solo si cuadran los números; si Google fusionó líneas se devuelve todo
  // junto mejor que descuadrar los tiempos.
  return out.length === lines.length ? out : [merged.trim()]
}

async function fallbackTranslate(lines, signal) {
  try {
    return await lingvaTranslateLines(lines, signal)
  } catch (e) {
    if (e?.name === 'AbortError') throw e
  }
  try {
    return await gtxTranslateLines(lines, signal)
  } catch {
    return lines // mejor original que nada
  }
}

const sameText = (a, b) => normVision(a.join('\n')) === normVision(b.join('\n'))

async function translateLines(lines, signal) {
  if (!lines.length) return lines
  try {
    const raw = await duckChat([{ role: 'user', content: TRANSLATE_PROMPT(lines) }], { signal })
    // El modelo debe devolver un array JSON; si devuelve texto suelto, se
    // intenta recortar al primer '[' … último ']'.
    let parsed = null
    const body = raw.trim()
    const i = body.indexOf('['); const j = body.lastIndexOf(']')
    if (i !== -1 && j > i) {
      try { parsed = JSON.parse(body.slice(i, j + 1)) } catch { parsed = null }
    }
    if (Array.isArray(parsed) && parsed.length === lines.length) {
      const out = parsed.map(v => String(v ?? ''))
      // Eco del modelo (devuelve la entrada sin traducir): probar fallbacks
      // antes de aceptar inglés como resultado.
      return sameText(out, lines) ? await fallbackTranslate(lines, signal) : out
    }
    // Mismo número de líneas no vacías → usar tal cual.
    const alt = body.split('\n').filter(l => l.trim() !== '')
    if (alt.length === lines.length) {
      return sameText(alt, lines) ? await fallbackTranslate(lines, signal) : alt.map(l => l.trim())
    }
    return await fallbackTranslate(lines, signal)
  } catch (e) {
    if (e?.name === 'AbortError') throw e
    // duck.ai saturado/cortado → Lingva (privado) → Google gtx → original.
    return await fallbackTranslate(lines, signal)
  }
}

async function translateCues(cues, signal, onProgress) {
  const out = new Array(cues.texts.length)
  let done = 0
  for (let i = 0; i < cues.texts.length; i += TRANSLATE_BATCH_CUES) {
    const batch = cues.texts.slice(i, i + TRANSLATE_BATCH_CUES)
    const tr = await translateLines(batch, signal)
    for (let k = 0; k < tr.length; k++) out[i + k] = tr[k]
    done += batch.length
    onProgress?.(done, cues.texts.length, out)
  }
  return out
}

// ---------- vía 1/2: subtítulo existente (OpenSubtitles/Stremio) ----------

function langRank(lang) {
  if (lang === 'spa' || lang === 'esp' || lang === 'cas') return 0
  if (lang === 'eng') return 1
  return 2
}

async function tryExistingSubtitle(meta) {
  const isSeries = meta.season > 0 && meta.episode > 0
  const id = isSeries ? `${meta.imdbId}:${meta.season}:${meta.episode}` : meta.imdbId
  const data = await httpGetJson(
    `${OPENSUBS_STREMIO}/subtitles/${isSeries ? 'series' : 'movie'}/${id}.json`)
  const subs = (data.subtitles || [])
    .filter(s => s?.url)
    .sort((a, b) => langRank(a.lang) - langRank(b.lang))
  if (!subs.length) return false

  const chosen = subs[0]
  osdNow('Subs IA: descargando subtítulo…')
  const text = await httpGetText(chosen.url)
  const cues = parseSubtitleText(text)
  if (!cues.times.length) return false

  const lang = (chosen.lang || '').toLowerCase()
  if (langRank(lang) === 0) {
    await ExoPlayer.setExternalCues(cues)
    if (active) active.cues = cues
    osdNow('Subtítulos en español aplicados')
    return true
  }

  osdNow(`Subs IA: traduciendo ${cues.texts.length} líneas (${lang.toUpperCase()}→ES)…`)
  // Aplicación progresiva: se pinta el original al instante y cada lote
  // traducido lo sustituye en pantalla — antes esperaba a las ~50 llamadas
  // del final y parecía que nunca llegaban los subtítulos.
  await ExoPlayer.setExternalCues(cues)
  const translated = await translateCues(cues, active?.abort?.signal, async (done, total, out) => {
    if (done % (TRANSLATE_BATCH_CUES * 4) === 0 || done === total) {
      osd(`Subs IA: traducidas ${done}/${total}`)
      if (active?.abort?.signal.aborted) return
      const mixed = cues.texts.map((orig, i) => out[i] ?? orig)
      try {
        await ExoPlayer.setExternalCues({ times: cues.times, texts: mixed })
      } catch { /* el siguiente lote lo reintenta */ }
    }
  })
  await ExoPlayer.setExternalCues({ times: cues.times, texts: translated })
  if (active) active.cues = { times: cues.times, texts: translated }
  osdNow('Subtítulos IA en español aplicados')
  return true
}

// ---------- vía 3: transcribir el audio (tap nativo + dictado) ----------

function splitToLines(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    if (cur && (cur.length + w.length + 1) > MAX_LINE) { lines.push(cur); cur = w }
    else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : [String(text)]
}

// Reparte el texto de un chunk de audio entre sus sub-cues: una frase por
// cue con ventana proporcional a su longitud dentro del bloque de 20 s.
export function chunkToCues(text, startMs, endMs) {
  const sentences = String(text)
    .replace(/\s+/g, ' ').trim()
    .match(/[^.!?…]+[.!?…]*\s*/g) || [text]
  const total = sentences.join('').length || 1
  const span = endMs - startMs
  const cues = []
  let acc = 0
  for (const s of sentences) {
    const a = startMs + Math.round(span * (acc / total))
    acc += s.length
    const b = startMs + Math.round(span * (acc / total))
    const body = splitToLines(s.trim()).slice(0, 2).join('\n')
    if (body && b > a) cues.push({ t: [a, b], x: body })
  }
  return cues
}

async function processChunk(ev) {
  // duck.ai satura a veces (418/429): esperar y reintentar antes de
  // resignar el tramo — perder 45 s de diálogo es peor que llegar tarde.
  let src = ''
  for (let attempt = 0; attempt <= DICTATE_RETRIES && active; attempt++) {
    try {
      src = await dictateWav(ev.wav, active?.abort?.signal)
      break
    } catch (e) {
      if (e?.name === 'AbortError' || attempt === DICTATE_RETRIES) throw e
      osdNow(`Subs IA: duck.ai saturado, reintento en ${DICTATE_RETRY_DELAY_MS / 1000}s…`)
      await sleep(DICTATE_RETRY_DELAY_MS)
    }
  }
  if (!src) return
  // Traducir por la misma cadena que los subs existentes: duck.ai →
  // Lingva → gtx → original. Antes iba solo por duckChat y cualquier
  // fallo dejaba el texto en inglés.
  let final = src
  try {
    const [tr] = await translateLines([src], active?.abort?.signal)
    if (tr && tr.trim()) final = tr
  } catch { /* sin traducción: mostrar el texto original */ }
  for (const c of chunkToCues(final, ev.startMs, ev.endMs)) {
    active.cues.times.push(c.t)
    active.cues.texts.push(c.x)
  }
  // Reordenar por inicio (los seeks pueden reabrir tramos) y empujar todo.
  const order = active.cues.times.map((_, i) => i)
    .sort((a, b) => active.cues.times[a][0] - active.cues.times[b][0])
  active.cues.times = order.map(i => active.cues.times[i])
  active.cues.texts = order.map(i => active.cues.texts[i])
  await ExoPlayer.setExternalCues(active.cues)
  // Guardado incremental: si duck.ai corta a media película, lo transcrito
  // queda en caché para la próxima sesión.
  if (active.key && active.cues.times.length % 8 === 0) {
    cacheWrite(active.key, active.cues)
  }
  const last = active.cues.times[active.cues.times.length - 1]
  if (last) osd(`Subs IA: cubierto hasta ${mmss(last[1])}`)
}

function onAudioChunk(ev) {
  if (!active?.transcribing) return
  // Cola serial: peticiones de dictado de una en una (el anti-bot castiga el
  // paralelismo y el orden del material importa).
  active.queue = active.queue
    .then(() => (active ? processChunk(ev) : null))
    .catch(e => {
      console.warn('[aiSubs] chunk error:', e?.message || e)
      if (e?.name === 'AbortError') active = null
    })
}

// ---------- OCR de texto en pantalla (ML Kit on-device) ----------
// El tap emite 'aiVideoFrame' con el TEXTO ya leído por ML Kit cuando el
// fotograma cambió. Aquí solo se traduce (duck.ai → Google gtx de
// respaldo). Latest-wins: si la cola va detrás se guarda solo el último
// frame pendiente — el anti-bot castiga el paralelismo.

const normVision = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim()

async function processFrame(ev) {
  const v = active.vision
  const raw = String(ev?.text || '').trim()
  if (!raw) return
  const norm = normVision(raw)
  if (norm === v.lastText) return // mismo rótulo que el frame previo
  v.lastText = norm
  v.calls++
  // El OCR ya vino hecho del nativo (ML Kit on-device): solo se traduce el
  // texto leído — llamada de texto barata, sin gastar cupo de imágenes.
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4)
  const tr = await translateLines(lines, active?.abort?.signal)
  const text = tr.map(l => String(l).trim()).filter(Boolean).join('\n') || raw
  const a = Math.max(0, ev.ts - 1500)
  active.cues.times.push([a, ev.ts + VISION_CUE_MS])
  active.cues.texts.push(text)
  const order = active.cues.times.map((_, i) => i)
    .sort((x, y) => active.cues.times[x][0] - active.cues.times[y][0])
  active.cues.times = order.map(i => active.cues.times[i])
  active.cues.texts = order.map(i => active.cues.texts[i])
  await ExoPlayer.setExternalCues(active.cues)
}

function onVideoFrame(ev) {
  const s = active
  if (!s?.transcribing || !s.vision || s.vision.dead) return
  const v = s.vision
  if (v.calls >= VISION_MAX_CALLS) {
    v.dead = true
    osd('Subs IA: OCR pausado (máx. de fotogramas)')
    return
  }
  v.pending = ev // latest-wins: solo importa el fotograma más reciente
  if (v.busy) return
  v.busy = true
  s.queue = s.queue
    .then(async () => {
      while (active === s && !v.dead && v.pending) {
        const frame = v.pending
        v.pending = null
        try {
          await processFrame(frame)
        } catch (e) {
          v.errors++
          if (e?.name === 'AbortError') throw e
          if (v.errors >= VISION_MAX_ERRORS) {
            v.dead = true
            osd('Subs IA: OCR de texto en pantalla detenido (límite)')
          }
        }
      }
    })
    .catch(e => {
      console.warn('[aiSubs] frame error:', e?.message || e)
      if (e?.name === 'AbortError') active = null
    })
    .finally(() => {
      if (active?.vision === v) v.busy = false
    })
}

// ---------- entry points ----------

async function onRequest(meta) {
  if (active) {
    osdNow('Subs IA ya está en marcha')
    return
  }
  const key = mediaKey(meta)
  if (key) {
    const cached = cacheRead(key)
    if (cached?.times?.length) {
      await ExoPlayer.setExternalCues({ times: cached.times, texts: cached.texts })
      osdNow('Subtítulos IA (caché) aplicados')
      return
    }
  }
  active = {
    abort: new AbortController(),
    key,
    cues: { times: [], texts: [] },
    queue: Promise.resolve(),
    transcribing: false,
    vision: { calls: 0, errors: 0, dead: false, busy: false, pending: null, lastText: '' },
  }
  try {
    if (meta?.imdbId) {
      osdNow('Subs IA: buscando subtítulo…')
      // La sesión muere al terminar la traducción: los cues ya quedaron
      // aplicados al overlay y no hay nada más que procesar.
      if (await tryExistingSubtitle(meta)) {
        if (key && active.cues.times.length) cacheWrite(key, active.cues)
        active = null
        return
      }
    }
    active.transcribing = true
    osdNow('Subs IA: transcribiendo audio + OCR…')
    // video: el tap también captura fotogramas para leer carteles/rótulos
    // quemados en la imagen (mensajes de móvil, titulares…).
    await ExoPlayer.startAiAudio({ chunkSec: DICTATE_CHUNK_SEC, video: true })
  } catch (e) {
    console.warn('[aiSubs]', e?.message || e)
    osdNow(`Subs IA: ${String(e?.message || 'error').slice(0, 60)}`)
    disposeAiSubs()
    return
  }
  // El flujo de dictado sigue por eventos 'aiAudioChunk'; 'active' permanece.
}

function onAudioError(ev) {
  if (!active) return
  const msg = String(ev?.message || 'error').slice(0, 40)
  // Error transitorio del tap (túnel saturado, codec ocupado): un reintento
  // desde la posición actual del vídeo suele recuperarlo.
  if (active.transcribing && !active.retried) {
    active.retried = true
    osdNow('Subs IA: error de audio, reintentando…')
    active.queue = active.queue.then(async () => {
      if (!active?.transcribing) return
      try {
        await ExoPlayer.startAiAudio({ chunkSec: DICTATE_CHUNK_SEC, video: true })
      } catch {
        osdNow(`Subs IA: audio no accesible (${msg})`)
        disposeAiSubs()
      }
    })
    return
  }
  osdNow(`Subs IA: audio no accesible (${msg})`)
  disposeAiSubs()
}

function onAudioDone() {
  if (!active?.transcribing) return
  const s = active
  s.transcribing = false
  s.queue.finally(() => {
    if (active === s) {
      if (s.cues.times.length) {
        if (s.key) cacheWrite(s.key, s.cues)
        osdNow('Subs IA: transcripción completa')
      }
      active = null // permite volver a pedirla sin cerrar el player
    }
  })
}

// Auto-carga de subtítulos en español al reproducir: si el audio detectado
// del stream NO es español (ESP/LAT/DUAL/MULTI — SUB/VOSE ya llevan subs),
// se lanza el mismo pipeline del botón "Subs IA" sin intervención:
// OpenSubtitles → traducción → transcripción de audio como última vía.
// Idioma desconocido (sin dato) no dispara nada — podría ser cualquier cosa.
const SPANISH_AUDIO = new Set(['ESP', 'LAT', 'DUAL', 'MULTI', 'SUB', 'VOSE', 'ESPSUB', 'CAST'])
let lastAutoKey = '' // los reintentos de playStream no re-disparan

export function maybeAutoSubs(options = {}) {
  if (!isAndroidNative()) return
  // Ajuste del usuario (Ajustes → Subtítulos): apagado = nada automático.
  try { if (localStorage.getItem('octostream_autosubs') === 'false') return } catch { /* storage inaccesible */ }
  if (options.mode === 'live') return
  const lang = parseStreamLang({ lang: options.lang }) || String(options.lang || '').trim().toUpperCase()
  if (!lang || SPANISH_AUDIO.has(lang)) return
  const key = `${options.imdbId || ''}|${options.url || ''}`
  if (key === lastAutoKey) return
  lastAutoKey = key
  onRequest({
    imdbId: options.imdbId || '',
    season: options.season || 0,
    episode: options.episode || 0,
    url: options.url || '',
  }).catch(e => console.warn('[aiSubs] auto:', e?.message || e))
}

/** Desactiva sesión y listeners lógicos; se llama al cerrar el player. */
export function disposeAiSubs() {
  lastAutoKey = ''
  if (active) {
    try { active.abort.abort() } catch { /* el AbortController ya fue usado */ }
    if (active.key && active.cues.times.length) cacheWrite(active.key, active.cues)
    active = null
    ExoPlayer.stopAiAudio().catch(() => {})
  }
}

/** Registra los listeners nativos una vez (llamar al arrancar la app). */
export function initAiSubs() {
  if (listenersReady || !isAndroidNative()) return
  listenersReady = true
  ExoPlayer.addListener('aiSubsRequested', ev => {
    onRequest(ev).catch(e => {
      console.warn('[aiSubs] request:', e?.message || e)
      disposeAiSubs()
    })
  })
  ExoPlayer.addListener('aiAudioChunk', onAudioChunk)
  ExoPlayer.addListener('aiVideoFrame', onVideoFrame)
  ExoPlayer.addListener('aiAudioDone', onAudioDone)
  ExoPlayer.addListener('aiAudioError', onAudioError)
}
