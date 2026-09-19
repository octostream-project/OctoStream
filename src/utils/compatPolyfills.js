// Polyfills mínimos para WebViews antiguos (Chrome ~66 en boxes Android 9).
// El build ya transpila sintaxis a es2015, pero las APIs de runtime no se
// transpilan: sin esto, Promise.allSettled/crypto.randomUUID/etc. lanzan
// TypeError en la TV y rompen pantallas enteras.
// Se importa lo primero en main.jsx.

/* eslint-disable no-extend-native */

if (typeof globalThis === 'undefined') {
  // eslint-disable-next-line no-global-assign
  window.globalThis = window
}

if (typeof queueMicrotask !== 'function') {
  window.queueMicrotask = (cb) => Promise.resolve().then(cb)
}

if (!Promise.allSettled) {
  Promise.allSettled = (it) => Promise.all([...it].map(p =>
    Promise.resolve(p).then(
      value => ({ status: 'fulfilled', value }),
      reason => ({ status: 'rejected', reason }),
    )))
}

if (!Promise.any) {
  Promise.any = (it) => Promise.all([...it].map(p =>
    Promise.resolve(p).then(v => { throw v }, e => e)
  )).then(errors => { throw errors }, v => v)
}

if (!String.prototype.replaceAll) {
  String.prototype.replaceAll = function (search, repl) {
    if (search instanceof RegExp) {
      const re = search.global ? search : new RegExp(search.source, search.flags + 'g')
      return this.replace(re, repl)
    }
    return this.split(search).join(repl)
  }
}

if (!String.prototype.matchAll) {
  String.prototype.matchAll = function* (re) {
    const r = re.global ? re : new RegExp(re.source, re.flags + 'g')
    let m
    while ((m = r.exec(this)) !== null) {
      yield m
      if (m.index === r.lastIndex) r.lastIndex++
    }
  }
}

if (!Array.prototype.flat) {
  Array.prototype.flat = function (depth = 1) {
    const out = []
    for (const el of this) {
      if (Array.isArray(el) && depth > 0) out.push(...el.flat(depth - 1))
      else out.push(el)
    }
    return out
  }
}

if (!Array.prototype.flatMap) {
  Array.prototype.flatMap = function (fn, thisArg) {
    return this.map(fn, thisArg).flat(1)
  }
}

if (!Array.prototype.at) {
  Array.prototype.at = function (i) {
    const n = this.length
    return this[i < 0 ? n + i : i]
  }
}

if (!Object.fromEntries) {
  Object.fromEntries = (it) => {
    const o = {}
    for (const [k, v] of it) o[k] = v
    return o
  }
}

if (!Object.hasOwn) {
  Object.hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
}

if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
  crypto.randomUUID = () => '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> (c / 4)).toString(16))
}

if (typeof AbortSignal !== 'undefined') {
  if (!AbortSignal.timeout) {
    AbortSignal.timeout = (ms) => {
      const ctl = new AbortController()
      setTimeout(() => ctl.abort(), ms)
      return ctl.signal
    }
  }
  if (!AbortSignal.abort) {
    AbortSignal.abort = () => {
      const ctl = new AbortController()
      ctl.abort()
      return ctl.signal
    }
  }
}
