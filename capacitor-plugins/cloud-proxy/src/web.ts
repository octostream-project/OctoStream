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
}
