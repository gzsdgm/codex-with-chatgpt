/**
 * Tunnel provider factory.
 *
 * Quick Tunnel stays the default, so an upgrade never changes behaviour for
 * existing users. Named Tunnel is opt-in through C2C_TUNNEL_MODE=named.
 */
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { CloudflaredQuickTunnel } from "./cloudflared.js";
import { CloudflaredNamedTunnel } from "./named.js";
import {
  isNamedTunnelUsable,
  namedTunnelProblems,
  resolveTunnelConfig,
  type ProjectTunnelConfig,
  type SpawnFn,
  type TunnelConfig,
} from "./config.js";
import type { TunnelProvider } from "./provider.js";

export * from "./config.js";
export * from "./provider.js";
export { CloudflaredQuickTunnel } from "./cloudflared.js";
export { CloudflaredNamedTunnel } from "./named.js";

export interface CreateTunnelProviderOptions {
  /** Pre-resolved config (tests). */
  config?: TunnelConfig;
  env?: NodeJS.ProcessEnv;
  /** `tunnel` block of the workspace's `.c2c.json`. */
  project?: ProjectTunnelConfig | null;
  /** Injectable spawn (tests). */
  spawnFn?: SpawnFn;
  /** Pre-computed `--protocol` support (tests). */
  protocolSupport?: boolean;
}

export function createTunnelProvider(
  logger: Logger = nullLogger,
  opts: CreateTunnelProviderOptions = {}
): TunnelProvider {
  const config = opts.config ?? resolveTunnelConfig(opts.env ?? process.env, opts.project);

  if (config.mode !== "named") {
    return new CloudflaredQuickTunnel(logger, {
      protocol: config.protocol,
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
      ...(opts.protocolSupport !== undefined ? { protocolSupport: opts.protocolSupport } : {}),
    });
  }

  if (isNamedTunnelUsable(config)) {
    return new CloudflaredNamedTunnel(logger, {
      config,
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
      ...(opts.protocolSupport !== undefined ? { protocolSupport: opts.protocolSupport } : {}),
    });
  }

  const problems = namedTunnelProblems(config);
  logger.warn(`Named tunnel requested but not usable: ${problems.join("; ")}`);

  if (config.fallbackQuick) {
    logger.warn("C2C_TUNNEL_FALLBACK_QUICK=1: falling back to a Quick Tunnel (the URL will change)");
    return new CloudflaredQuickTunnel(logger, {
      protocol: config.protocol,
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
      ...(opts.protocolSupport !== undefined ? { protocolSupport: opts.protocolSupport } : {}),
    });
  }

  // No fallback: hand back the named provider so the failure surfaces at
  // start()/doctor() with a precise message, and the Connector URL never
  // silently becomes a random trycloudflare.com address.
  return new CloudflaredNamedTunnel(logger, {
    config,
    ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    ...(opts.protocolSupport !== undefined ? { protocolSupport: opts.protocolSupport } : {}),
  });
}
