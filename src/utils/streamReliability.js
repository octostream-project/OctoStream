import { getJsonSync, setJsonSync } from './storage.js'

const KEY = 'octostream_stream_reliability_v1'
const MAX_SOURCES = 120
let scoresCache = null
const listeners = new Set()

function safeLabel(value) {
  const label = String(value || '').trim()
  if (/^https?:\/\//i.test(label)) {
    try { return new URL(label).hostname.toLowerCase().slice(0, 120) } catch { return '' }
  }
  return label.replace(/[|\r\n]/g, '').slice(0, 120)
}

function sourceKey(streamOrPluginId, server = '') {
  if (typeof streamOrPluginId === 'object' && streamOrPluginId) {
    const plugin = safeLabel(streamOrPluginId.pluginId || streamOrPluginId.pluginName)
    const provider = safeLabel(streamOrPluginId.server || streamOrPluginId.channelName)
    return `${plugin}|${provider}`.toLowerCase()
  }
  return `${safeLabel(streamOrPluginId)}|${safeLabel(server)}`.toLowerCase()
}

function loadScores() {
  if (scoresCache) return scoresCache
  const scores = getJsonSync(KEY, {})
  scoresCache = scores && typeof scores === 'object' && !Array.isArray(scores) ? scores : {}
  return scoresCache
}

// Count one outcome after playback reaches ready, or after the player exhausts
// its retries. No URLs or titles are stored; this stays local to the device.
export function recordStreamOutcome(stream, success, latencyMs = null) {
  const key = sourceKey(stream)
  if (!key || key === '|') return
  const scores = loadScores()
  const prev = scores[key] || { success: 0, failure: 0, lastAt: 0 }
  const next = {
    success: prev.success + (success ? 1 : 0),
    failure: prev.failure + (success ? 0 : 1),
    lastAt: Date.now(),
  }
  const latency = Number(latencyMs)
  const latencySamples = Math.max(0, Number(prev.latencySamples) || 0)
  if (Number.isFinite(latency) && latency >= 0 && latency <= 10 * 60 * 1000) {
    next.latencyMs = latencySamples
      ? ((Number(prev.latencyMs) || 0) * latencySamples + latency) / (latencySamples + 1)
      : latency
    next.latencySamples = Math.min(latencySamples + 1, 100)
  } else if (latencySamples) {
    next.latencyMs = prev.latencyMs
    next.latencySamples = latencySamples
  }
  scores[key] = next
  const keys = Object.keys(scores)
  if (keys.length > MAX_SOURCES) {
    keys.sort((a, b) => (scores[a]?.lastAt || 0) - (scores[b]?.lastAt || 0))
    for (const old of keys.slice(0, keys.length - MAX_SOURCES)) delete scores[old]
  }
  setJsonSync(KEY, scores)
  for (const listener of listeners) {
    try { listener() } catch { /* isolate subscribers */ }
  }
}

// Bayesian smoothing keeps a source with one success from outranking a source
// with a long, consistently successful history.
export function getStreamReliability(stream) {
  const stat = loadScores()[sourceKey(stream)]
  if (!stat) return 0.5
  return (stat.success + 2) / (stat.success + stat.failure + 4)
}

export function getStreamLatency(stream) {
  const stat = loadScores()[sourceKey(stream)]
  return Number.isFinite(stat?.latencyMs) ? stat.latencyMs : Number.POSITIVE_INFINITY
}

export function compareStreamsByReliability(a, b, languageRank = () => 99) {
  return languageRank(a) - languageRank(b)
    || Number(b.cached === true) - Number(a.cached === true)
    || getStreamReliability(b) - getStreamReliability(a)
    || getStreamLatency(a) - getStreamLatency(b)
    || (Number(b.seeds) || 0) - (Number(a.seeds) || 0)
}

export function subscribeStreamReliability(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
