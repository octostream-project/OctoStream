import type { CloudProxyPlugin, CloudProxyStatus } from './definitions'

export class CloudProxyWeb implements CloudProxyPlugin {
  async connect(): Promise<{ status: string }> {
    return { status: 'unsupported' }
  }
  async disconnect(): Promise<{ status: string }> {
    return { status: 'unsupported' }
  }
  async disconnectBackground(): Promise<{ status: string }> {
    return { status: 'unsupported' }
  }
  async getStatus(): Promise<CloudProxyStatus> {
    return { connected: false, connecting: false, error: 'Cloud proxy not available on web' }
  }
  async setStrictMode(): Promise<{ enabled: boolean }> {
    return { enabled: false }
  }
  async setRemoteHost(): Promise<{ remote: string }> {
    return { remote: '' }
  }
  async setRemoteSsh(): Promise<{ ssh: boolean }> {
    return { ssh: false }
  }
  async getRemoteSsh(): Promise<{ user: string; pass: string; port: number }> {
    return { user: '', pass: '', port: 22 }
  }
  async trustRemoteHost(): Promise<{ trusted: boolean }> {
    return { trusted: false }
  }
  async directFetch(): Promise<{ status: number; headers: Record<string, string>; data: unknown; url?: string }> {
    throw new Error('directFetch unsupported')
  }
}
