import type { PluginListenerHandle } from '@capacitor/core'

export interface AppUpdaterPlugin extends Plugin {
  /** Installed package version: {versionCode, versionName} */
  getAppVersion(): Promise<{ versionCode: number; versionName: string }>
  /** Android 8+: whether the app may install packages */
  canInstallUnknownApps(): Promise<{ allowed: boolean }>
  /** Opens the per-app "install unknown apps" system settings page */
  openInstallSettings(): Promise<void>
  /**
   * Downloads an APK (https only) to cache. Emits 'downloadProgress'
   * ({received, total, percent}). If sha256 is provided it is verified
   * before resolving {path}.
   */
  downloadApk(options: { url: string; sha256?: string }): Promise<{ path: string }>
  /** Launches the system package installer for a previously downloaded APK */
  installApk(options: { path: string }): Promise<void>
  addListener(
    eventName: 'downloadProgress',
    listener: (data: { received: number; total: number; percent: number }) => void
  ): Promise<PluginListenerHandle>
}
