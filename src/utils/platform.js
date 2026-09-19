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
export function isAndroidTv() {
  return isAndroidNative() && /\bOctoTV\b/.test(navigator.userAgent || '')
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
