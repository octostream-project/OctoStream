import type { PluginListenerHandle } from '@capacitor/core'

export interface SyncServerPlugin extends Plugin {
  start(): Promise<{ port: number; ip: string; url: string }>
  stop(): Promise<void>
  getIpAddress(): Promise<{ ip: string; port: number; url: string }>
  setLocalData(options: { data: string }): Promise<void>
  getReceivedData(): Promise<{ data: string }>
  clearReceivedData(): Promise<void>
  /** Autoriza (allow=true, persistente) o rechaza (allow=false, sesión) una IP */
  allowDevice(options: { ip: string; allow?: boolean }): Promise<void>
  getPairedDevices(): Promise<{ devices: string[] }>
  forgetDevices(): Promise<void>
  addListener(eventName: 'syncDataReceived', listener: (data: { data: string }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'playReceived', listener: (data: { url: string; title: string; type: string; mode: string }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'stopReceived', listener: () => void): Promise<PluginListenerHandle>
  /** Un dispositivo no emparejado pidió /play o /sync — mostrar aceptación al usuario */
  addListener(eventName: 'pairRequest', listener: (data: { ip: string; endpoint: string; data?: string }) => void): Promise<PluginListenerHandle>
}
