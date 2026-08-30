/**
 * Tunnel abstraction. Business logic never talks to a specific vendor;
 * it only sees this interface. V1 ships a Cloudflare Quick Tunnel provider,
 * but ngrok / Tailscale / custom providers can be added without touching
 * the bridge.
 */
export interface TunnelStatus {
  running: boolean;
  url: string | null;
  provider: string;
  detail?: string;
  /**
   * Non-sensitive authentication mode of a named tunnel
   * (`token-file` | `token-env` | `local-config`). Never the credential itself.
   */
  authMode?: string;
}

export interface TunnelDoctorReport {
  provider: string;
  binaryFound: boolean;
  binaryPath: string | null;
  running: boolean;
  url: string | null;
  problems: string[];
}

export interface TunnelProvider {
  readonly name: string;
  /** Start the tunnel for a local port; resolves with the public URL. */
  start(localPort: number): Promise<string>;
  stop(): Promise<void>;
  restart(localPort: number): Promise<string>;
  status(): TunnelStatus;
  getPublicUrl(): string | null;
  doctor(): Promise<TunnelDoctorReport>;
}
