// Platform detection utility
// Works across Electron, Android (Capacitor), and web

import { Capacitor } from '@capacitor/core'

export function isAndroidNative() {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

// Android TV / box leanback: MainActivity añade "OctoTV" al User-Agent del
// WebView solo cuando el dispositivo es TV (UI_MODE_TYPE_TELEVISION/leanback).
// Fallback: boxes con ROM de tablet (sin feature leanback pero sin pantalla
// táctil y pantalla grande) también son TV para el layout.
export function isAndroidTv() {
  if (!isAndroidNative()) return false
  if (/\bOctoTV\b/.test(navigator.userAgent || '')) return true
  try {
    return navigator.maxTouchPoints === 0 && Math.max(screen.width, screen.height) >= 960
  } catch {
    return false
  }
}

/**
 * Whether Widevine DRM is available as a production client on this platform.
 * - Android: yes (Play Services provides a production-certified CDM)
 * - Electron/Linux with Castlabs ECS: development client only (rejected by some servers)
 * - Web: depends on browser
 */
export function supportsProductionWidevine() {
  return isAndroidNative()
}
