const MAX_LOGS = 200

const logs = []
const listeners = new Set()

let originalConsole = null

function notify() {
  listeners.forEach(cb => cb())
}

export function log(level, message, details = null) {
  const entry = {
    id: Date.now() + Math.random(),
    timestamp: Date.now(),
    level,
    message: typeof message === 'string' ? message : JSON.stringify(message),
    details: details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
  }
  logs.unshift(entry)
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS
  notify()
  if (originalConsole) {
    originalConsole[level]?.(entry.message, details)
  }
}

export const logInfo = (msg, details) => log('info', msg, details)
export const logWarn = (msg, details) => log('warn', msg, details)
export const logError = (msg, details) => log('error', msg, details)
export const logDebug = (msg, details) => log('debug', msg, details)

export function getLogs() {
  return logs
}

export function subscribeLogs(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

export function clearLogs() {
  logs.length = 0
  notify()
}

export function captureConsole() {
  originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  }
  console.log = (...args) => { log('info', args[0], args.slice(1)); originalConsole.log.apply(console, args) }
  console.info = (...args) => { log('info', args[0], args.slice(1)); originalConsole.info.apply(console, args) }
  console.warn = (...args) => { log('warn', args[0], args.slice(1)); originalConsole.warn.apply(console, args) }
  console.error = (...args) => { log('error', args[0], args.slice(1)); originalConsole.error.apply(console, args) }
}
