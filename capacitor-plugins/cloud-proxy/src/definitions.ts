export interface CloudProxyStatus {
  connected: boolean;
  /** True while the Aether tunnel handshake is in progress. */
  connecting?: boolean;
  error: string;
}

export interface CloudProxyPlugin {
  /**
   * Start the Aether local proxy for Cloudflare WARP.
   * Routes app traffic through the WARP tunnel (MASQUE over QUIC).
   */
  connect(): Promise<{ status: string }>;

  /**
   * Stop the Aether proxy and clear routing.
   * Allows direct traffic (no tunnel).
   */
  disconnect(): Promise<{ status: string }>;

  /**
   * Background disconnect: stops Aether but keeps proxy pointing to
   * dead port so requests fail instead of leaking the real IP.
   */
  disconnectBackground(): Promise<{ status: string }>;

  /**
   * Get the current proxy connection status.
   */
  getStatus(): Promise<CloudProxyStatus>;
}
