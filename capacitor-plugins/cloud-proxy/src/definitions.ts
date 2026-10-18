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

  /**
   * Write an OpenVPN profile to the app cache and open it with the
   * system's OpenVPN client (RiseupVPN alternative VPN layer).
   */
  exportOvpn(options: { config: string; name?: string }): Promise<{ opened: boolean; name: string }>;

  /**
   * Connect the RiseupVPN tunnel via the OpenVPN for Android remote API
   * (de.blinkt.openvpn must be installed). Status: connected | consent |
   * need-vpn-permission. Rejects 'no-openvpn-app' when the app is missing.
   */
  riseupConnect(options: { config: string }): Promise<{ status: string }>;

  /** Disconnect the RiseupVPN tunnel (remote API). */
  riseupDisconnect(): Promise<{ status: string }>;

  /** RiseupVPN remote-API status. */
  riseupTunnelStatus(): Promise<{ installed: boolean; connected: boolean; hasEngine: boolean }>;
}
