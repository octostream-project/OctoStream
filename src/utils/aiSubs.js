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
import { dictateWav, duckChat, duckChatImage } from './duckAi.js'
import { getJsonSync, setJsonSync } from './storage.js'

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

async function translateLines(lines, signal) {
  if (!lines.length) return lines
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
    return parsed.map(v => String(v ?? ''))
  }
  // Fallback: mismo número de líneas no vacías → usar tal cual; si no,
  // devolver el original (mejor inglés que nada).
  const alt = body.split('\n').filter(l => l.trim() !== '')
  if (alt.length === lines.length) return alt.map(l => l.trim())
  return lines
}

async function translateCues(cues, signal, onProgress) {
  const out = new Array(cues.texts.length)
  let done = 0
  for (let i = 0; i < cues.texts.length; i += TRANSLATE_BATCH_CUES) {
    const batch = cues.texts.slice(i, i + TRANSLATE_BATCH_CUES)
    const tr = await translateLines(batch, signal)
    for (let k = 0; k < tr.length; k++) out[i + k] = tr[k]
    done += batch.length
    onProgress?.(done, cues.texts.length)
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
  const translated = await translateCues(cues, active?.abort?.signal, (done, total) => {
    if (done % (TRANSLATE_BATCH_CUES * 4) === 0 || done === total) {
      osd(`Subs IA: traducidas ${done}/${total}`)
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

const DICTATE_PROMPT = t =>
  'Texto transcrito de audio para subtítulos. Si ya está en español, ' +
  'devuélvelo corregido (puntuación, mayúsculas, tildes). Si está en otro ' +
  'idioma, tradúcelo al español castellano. Responde SOLO con el texto final, ' +
  'sin comillas ni comentarios.\n' + t

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
  let final = src
  try {
    const tr = await duckChat([{ role: 'user', content: DICTATE_PROMPT(src) }], {
      signal: active?.abort?.signal,
    })
    if (tr) final = tr
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

// ---------- OCR de texto en pantalla (visión) ----------
// El tap emite 'aiVideoFrame' solo cuando el fotograma cambió. Aquí cada
// imagen va al modelo vision para leer carteles/rótulos/mensajes quemados en
// el vídeo y traducirlos. Latest-wins: si la cola va detrás se guarda solo
// el último frame pendiente — el anti-bot castiga el paralelismo.

const VISION_PROMPT =
  'Esta imagen es un fotograma de una película. Lee TODO el texto visible ' +
  '(carteles, rótulos, mensajes de móvil, subtítulos quemados, titulares). ' +
  'Tradúcelo al español castellano y responde SOLO con el texto final, una ' +
  'frase por línea. Si no hay texto legible responde exactamente: SIN_TEXTO'

const normVision = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim()

async function processFrame(ev) {
  const v = active.vision
  const dataUrl = `data:image/jpeg;base64,${ev.jpeg}`
  const out = await duckChatImage(dataUrl, VISION_PROMPT, { signal: active?.abort?.signal })
  v.calls++
  v.errors = 0
  const text = String(out || '').trim()
  if (!text || /^SIN_TEXTO/.test(text)) return
  if (normVision(text) === v.lastText) return // mismo rótulo que el frame previo
  v.lastText = normVision(text)
  const a = Math.max(0, ev.ts - 1500)
  active.cues.times.push([a, ev.ts + VISION_CUE_MS])
  active.cues.texts.push(text.split('\n').filter(Boolean).slice(0, 2).join('\n'))
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
  osdNow(`Subs IA: audio no accesible (${String(ev?.message || 'error').slice(0, 40)})`)
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

/** Desactiva sesión y listeners lógicos; se llama al cerrar el player. */
export function disposeAiSubs() {
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
