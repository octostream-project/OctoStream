export interface CloudProxyStatus {
  connected: boolean;
  /** True while the Aether tunnel handshake is in progress. */
  connecting?: boolean;
  error: string;
  /** Active transport protocol for general traffic: gool | mim | remote.
   *  (SSH/VPS mode also runs aether locally — protocol stays gool|mim; see
   *  `vps` for whether the dedicated debrid forward is up.) */
  protocol?: string;
  socks?: string;
  http?: string;
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
  /** Requested exit location (auto/random/ISO) and observed exit metadata. */
  exitLoc?: string;
  exitIp?: string;
  exitCountry?: string;
  exitColo?: string;
  /** Effective remote host and whether SSH mode is configured. */
  remote?: string;
  ssh?: boolean;
  /** SSH forward to the VPS is live (debrid-only egress on
   *  127.0.0.1:2819/2820). False while reconnecting — debrid streams then
   *  fall back to the WARP proxy, never to the physical network. */
  vps?: boolean;
}

export interface CloudProxyPlugin {
  /**
   * Start the Aether local proxy for Cloudflare WARP.
   * Routes app traffic through the WARP tunnel (MASQUE over QUIC).
   */
  connect(options?: { exitLoc?: string }): Promise<{ status: string }>;

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
   * Remote proxy host. Empty string returns to the local Aether tunnel.
   * Android also accepts host:ssh-port / ssh://user@host:port input.
   */
  setRemoteHost(options: { host: string }): Promise<{ remote: string }>;

  /**
   * SSH credentials for a VPS remote (Android only). An empty user returns
   * to the legacy plain remote-proxy mode. The password is persisted
   * encrypted with an Android Keystore AES key — never as plaintext.
   */
  setRemoteSsh(options: { user?: string; pass?: string; port?: number }): Promise<{ ssh: boolean }>;

  /**
   * Saved SSH credentials for the remote (Android only). The plugin
   * decrypts the password from its Keystore-backed store so the settings
   * UI can repopulate without keeping it in localStorage.
   */
  getRemoteSsh(): Promise<{ user: string; pass: string; port: number }>;

  /**
   * Confirm the pending SSH host key for the configured remote (Android
   * only, TOFU): pins exactly the key whose fingerprint was shown to the
   * user. Rejects when no pending key exists for that host.
   */
  trustRemoteHost(): Promise<{ trusted: boolean; fingerprint?: string }>;

  /**
   * Fetch a URL bound to the physical network (WiFi/cellular), bypassing
   * the local proxy. Restricted to geo-blocked hosts (TDT/RTVE/
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
    /** Debrid traffic: route via the SSH forward to the VPS (127.0.0.1:2820)
     *  instead of the physical network or the general WARP proxy. Falls back
     *  to the default proxy (aether) when no VPS tunnel is up — never goes
     *  out in the clear. Not restricted to the geo-bypass host list. */
    vps?: boolean;
  }): Promise<{ status: number; headers: Record<string, string>; data: unknown; url?: string }>;
}
