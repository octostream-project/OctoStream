export interface CloudProxyStatus {
  connected: boolean;
  /** True while the Aether tunnel handshake is in progress. */
  connecting?: boolean;
  error: string;
  /** Active transport protocol: masque | masque-h2 | wg. */
  protocol?: string;
  /** Foreground guard service running (anti phantom-kill, background only). */
  guard?: boolean;
  /** Tunnel death streak before protocol escalation. */
  tunnelFails?: number;
  /** Strict kill-switch: dead proxy kept on tunnel loss (fail-closed). */
  strict?: boolean;
  /** Reconnections during this app session. */
  reconnects?: number;
  /** Milliseconds the tunnel has been continuously up. */
  uptimeMs?: number;
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
   * Strict kill-switch: when enabled, a detected tunnel loss keeps the
   * proxy pointing at the dead port so every request FAILS instead of
   * leaking the real IP (same semantics as disconnectBackground).
   */
  setStrictMode(options: { enabled: boolean }): Promise<{ enabled: boolean }>;

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

  /**
   * Fetch a URL bound to the physical network (WiFi/cellular), bypassing
   * the Riseup VPN tunnel. Restricted to geo-blocked hosts (TDT/RTVE/
   * Atresmedia/Mediaset…) so live TV keeps working while the VPN is on.
   * Returns a CapacitorHttp-shaped {status, headers, data} response.
   */
  directFetch(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    data?: unknown;
    responseType?: string;
    connectTimeout?: number;
    readTimeout?: number;
  }): Promise<{ status: number; headers: Record<string, string>; data: unknown; url?: string }>;
}
