import { OctoPlayer } from '@octostream/octo-player'
import { Capacitor } from '@capacitor/core'

export function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

export async function playWithExoPlayer(url, title) {
  if (!isAndroidNative()) return false
  try {
    await OctoPlayer.playExoPlayer({ url, title })
    return true
  } catch (e) {
    console.warn('[AndroidPlayer] ExoPlayer error:', e)
    return false
  }
}

export async function playWithVlc(url, title) {
  if (!isAndroidNative()) return false
  try {
    await OctoPlayer.playVlc({ url, title })
    return true
  } catch (e) {
    console.warn('[AndroidPlayer] VLC error:', e)
    return false
  }
}
