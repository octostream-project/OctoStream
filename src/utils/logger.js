// Minimal leveled logger. Warnings/errors go to the console so they surface in
// logcat/DevTools (console.log is stripped from production bundles by esbuild;
// console.warn/error are kept). Kept as a thin wrapper so call sites can later
// be redirected (e.g. to a remote sink) without touching every module.

export const logWarn = (message, details) =>
  details == null ? console.warn(message) : console.warn(message, details)

export const logError = (message, details) =>
  details == null ? console.error(message) : console.error(message, details)
