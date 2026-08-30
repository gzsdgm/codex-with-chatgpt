/**
 * Tunnel configuration.
 *
 * Resolution order (highest priority first):
 *   1. explicit environment variables (`C2C_TUNNEL_*`, `C2C_CLOUDFLARED_PROTOCOL`)
 *   2. per-project `.c2c.json` -> `tunnel` block
 *   3. built-in defaults
 *
 * The defaults reproduce the historical behaviour exactly: Cloudflare Quick
 * Tunnel, no protocol flag, no fallback. Existing users are unaffected.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export type TunnelMode = "quick" | "named";

/**
 * Transport protocol for the cloudflared edge connection.
 * `auto` lets cloudflared decide (current behaviour). `http2` is useful behind
 * proxies that break QUIC (e.g. Clash fake-IP ranges).
 */
export type CloudflaredProtocol = "auto" | "quic" | "http2";

export interface NamedTunnelSettings {
  /** Cloudflare tunnel token (remotely-managed tunnels, temp sessions). */
  token?: string;
  /** Path to a file holding the tunnel token (remotely-managed, long-lived). */
  tokenFile?: string;
  /** Fixed public hostname, e.g. `c2c.example.com`. */
  hostname?: string;
  /** Tunnel name (locally-managed tunnels, stored credentials). */
  name?: string;
  /** Path to a cloudflared config.yml (locally-managed tunnels). */
  configFile?: string;
}

/**
 * How a named tunnel authenticates. Reported by status/doctor — never the
 * credential itself.
 *  - token-file:   C2C_TUNNEL_TOKEN_FILE (recommended on Windows / autostart)
 *  - token-env:    C2C_TUNNEL_TOKEN (transient sessions, compatibility)
 *  - local-config: C2C_TUNNEL_NAME + C2C_TUNNEL_CONFIG (credentials on disk)
 */
export type NamedTunnelAuthMode = "token-file" | "token-env" | "local-config";

export interface TunnelConfig {
  mode: TunnelMode;
  protocol: CloudflaredProtocol;
  named: NamedTunnelSettings;
  /**
   * If a named tunnel is configured but cannot be started, fall back to a
   * Quick Tunnel. Off by default: silently swapping a fixed Connector URL for
   * a random one is worse than failing loudly.
   */
  fallbackQuick: boolean;
  /**
   * Legacy escape hatch: pass the tunnel token as `--token <value>` on the
   * command line instead of through the child environment. Off by default and
   * never enabled implicitly — a token in argv is readable by any local
   * process via the Windows process list / /proc.
   */
  tokenInArgv: boolean;
}

/** Shape of the optional `tunnel` block in a workspace's `.c2c.json`. */
export interface ProjectTunnelConfig {
  mode?: TunnelMode;
  protocol?: CloudflaredProtocol;
  hostname?: string;
  name?: string;
  config?: string;
  fallbackQuick?: boolean;
}

export const DEFAULT_TUNNEL_CONFIG: TunnelConfig = {
  mode: "quick",
  protocol: "auto",
  named: {},
  fallbackQuick: false,
  tokenInArgv: false,
};

/** File name of the token file inside the state directory's `secrets` folder. */
export const TOKEN_FILE_NAME = "cloudflare-tunnel.token";

/**
 * Recommended location: inside the unified state directory, which is already
 * per-user and 0700. A path only — the token itself is never held here.
 */
export function defaultTokenFilePath(stateDir: string): string {
  return path.join(stateDir, "secrets", TOKEN_FILE_NAME);
}

/**
 * Validate the token file WITHOUT ever reading its contents.
 * Returns an empty array when the path is absent (a different auth mode).
 */
export function tokenFileProblems(tokenFile: string | undefined): string[] {
  if (!tokenFile) return [];
  if (!fs.existsSync(tokenFile)) return [`token file not found: ${tokenFile}`];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(tokenFile);
  } catch (error) {
    return [`token file is not readable: ${tokenFile} (${(error as Error).message})`];
  }
  if (stat.isDirectory()) return [`token file is a directory, expected a file: ${tokenFile}`];
  if (!stat.isFile()) return [`token file is not a regular file: ${tokenFile}`];
  if (stat.size === 0) return [`token file is empty: ${tokenFile}`];
  return [];
}

export interface TokenFileAclReport {
  path: string;
  exists: boolean;
  isFile: boolean;
  /** True when only the owning user / SYSTEM / Administrators can read it. */
  secure: boolean;
  /** Human-readable, secret-free summary. */
  detail: string;
  problems: string[];
}

/** Principals that must NOT hold read access to the token file. */
const BROAD_PRINCIPALS = [
  "everyone",
  "authenticated users",
  "users",
  "builtin\\users",
  "nt authority\\authenticated users",
  "s-1-1-0", // Everyone
  "s-1-5-11", // Authenticated Users
  "s-1-5-32-545", // BUILTIN\Users
];

/**
 * Strip a machine/domain prefix so `BUILTIN\Users` and `Users` compare equal.
 * Well-known SIDs have no prefix and are matched as-is.
 */
export function principalKey(principal: string): string {
  const trimmed = principal.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("\\");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Which of the given principals are too broad for a token file. */
export function findBroadPrincipals(principals: readonly string[]): string[] {
  return principals.filter((principal) => BROAD_PRINCIPALS.includes(principalKey(principal)));
}

/**
 * Inspect a token file's existence and permissions. Never prints or reads the
 * token contents.
 */
export function inspectTokenFile(tokenFile: string | undefined): TokenFileAclReport | null {
  if (!tokenFile) return null;
  const base: TokenFileAclReport = {
    path: tokenFile,
    exists: false,
    isFile: false,
    secure: false,
    detail: "token file not found",
    problems: [`token file not found: ${tokenFile}`],
  };
  if (!fs.existsSync(tokenFile)) return base;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(tokenFile);
  } catch (error) {
    return { ...base, exists: true, detail: "token file is not readable", problems: [(error as Error).message] };
  }
  if (!stat.isFile()) {
    return {
      ...base,
      exists: true,
      detail: "not a regular file",
      problems: [`token file is not a regular file: ${tokenFile}`],
    };
  }

  if (process.platform === "win32") {
    const result = spawnSync("icacls", [tokenFile], { encoding: "utf8", timeout: 10_000 });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (!out.trim()) {
      return {
        ...base,
        exists: true,
        isFile: true,
        detail: "could not read ACL (icacls unavailable)",
        problems: ["could not read ACL (icacls unavailable)"],
      };
    }
    const principals = parseIcaclsPrincipals(out);
    const broad = findBroadPrincipals(principals);
    if (broad.length > 0) {
      return {
        ...base,
        exists: true,
        isFile: true,
        secure: false,
        detail: `ACL too permissive (readable by ${broad.join(", ")})`,
        problems: [`token file is readable by ${broad.join(", ")}`],
      };
    }
    return {
      ...base,
      exists: true,
      isFile: true,
      secure: true,
      detail: "ACL limited to the owning user / SYSTEM / Administrators",
      problems: [],
    };
  }

  // POSIX: no group/other access.
  const mode = stat.mode & 0o777;
  if (mode & 0o077) {
    return {
      ...base,
      exists: true,
      isFile: true,
      secure: false,
      detail: `permissions too open (${(mode & 0o777).toString(8)})`,
      problems: [`token file permissions too open: ${(mode & 0o777).toString(8)} (use 0600)`],
    };
  }
  return {
    ...base,
    exists: true,
    isFile: true,
    secure: true,
    detail: `permissions ${(mode & 0o777).toString(8)}`,
    problems: [],
  };
}

/** Extract the principals granted access from `icacls` output. */
export function parseIcaclsPrincipals(output: string): string[] {
  const principals: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (/^(successfully processed|已成功处理)/i.test(line.trim())) continue;
    const withoutAce = line.replace(/:\([^)]*\)\s*$/, "").trim();
    if (!withoutAce) continue;
    if (/^\S+:/.test(raw) === false && raw.startsWith(" ")) {
      // continuation line: the whole trimmed remainder is the principal
      principals.push(withoutAce);
      continue;
    }
    const parts = withoutAce.split(/\s+/);
    principals.push(parts[parts.length - 1]);
  }
  return principals;
}

/**
 * Restrict a token file to the owning user, SYSTEM and Administrators.
 * Never deletes the file: a failed hardening must not destroy the credential.
 */
export function secureTokenFile(tokenFile: string): { ok: boolean; detail: string } {
  try {
    fs.chmodSync(tokenFile, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
  if (process.platform !== "win32") {
    return { ok: true, detail: "permissions set to 0600" };
  }
  const result = spawnSync(
    "icacls",
    [
      tokenFile,
      "/inheritance:r",
      "/grant:r",
      `${process.env.USERNAME ?? "%USERNAME%"}:(R)`,
      "*S-1-5-18:(R)", // SYSTEM
      "*S-1-5-32-544:(R)", // BUILTIN\Administrators
    ],
    { encoding: "utf8", timeout: 15_000 }
  );
  if (result.status !== 0) {
    return {
      ok: false,
      detail: `icacls failed: ${(result.stderr ?? result.stdout ?? "unknown error").trim().slice(0, 200)}`,
    };
  }
  return { ok: true, detail: "ACL limited to the owning user / SYSTEM / Administrators" };
}

/**
 * Named tunnel flavours:
 *  - `remote`: remotely-managed, identified by a tunnel token. The public
 *    hostname is routed to the origin in the Cloudflare dashboard
 *    (Published application); no local config.yml is needed.
 *  - `local`: locally-managed, identified by name + config.yml which carries
 *    `tunnel`, `credentials-file` and the `ingress` rules.
 */
export type NamedTunnelFlavour = "remote" | "local";

/** cloudflared reads the tunnel token from this environment variable. */
export const CLOUDFLARED_TOKEN_ENV_KEY = "TUNNEL_TOKEN";

/** cloudflared reads the tunnel token FILE PATH from this environment variable. */
export const CLOUDFLARED_TOKEN_FILE_ENV_KEY = "TUNNEL_TOKEN_FILE";

/**
 * Tunnel name used by the `--protocol` capability probe. It cannot resolve to
 * a real tunnel, so cloudflared stops during argument/credential resolution and
 * never opens a connection.
 */
export const CLOUDFLARED_PROTOCOL_PROBE_TUNNEL = "__c2c_capability_probe__";

export interface SpawnOptions {
  stdio: ["ignore", "pipe", "pipe"];
  env?: NodeJS.ProcessEnv;
}

/** Minimal shape of child_process.spawn, injectable so tests never touch a real binary. */
export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

const REDACTED = "[REDACTED]";

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseMode(value: string | undefined): TunnelMode | undefined {
  return value === "named" || value === "quick" ? value : undefined;
}

function parseProtocol(value: string | undefined): CloudflaredProtocol | undefined {
  return value === "auto" || value === "quic" || value === "http2" ? value : undefined;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === "1" || lower === "true" || lower === "yes") return true;
  if (lower === "0" || lower === "false" || lower === "no") return false;
  return undefined;
}

export function resolveTunnelConfig(
  env: NodeJS.ProcessEnv = process.env,
  project: ProjectTunnelConfig | null | undefined = null
): TunnelConfig {
  const p = project ?? {};
  return {
    mode: parseMode(envValue(env, "C2C_TUNNEL_MODE")) ?? p.mode ?? DEFAULT_TUNNEL_CONFIG.mode,
    protocol:
      parseProtocol(envValue(env, "C2C_CLOUDFLARED_PROTOCOL")) ??
      p.protocol ??
      DEFAULT_TUNNEL_CONFIG.protocol,
    named: {
      // Secrets (and secret paths) are never read from the project file:
      // .c2c.json lives in the workspace and is routinely shown to ChatGPT /
      // committed to git.
      tokenFile: envValue(env, "C2C_TUNNEL_TOKEN_FILE"),
      token: envValue(env, "C2C_TUNNEL_TOKEN"),
      hostname: envValue(env, "C2C_TUNNEL_HOSTNAME") ?? p.hostname,
      name: envValue(env, "C2C_TUNNEL_NAME") ?? p.name,
      configFile: envValue(env, "C2C_TUNNEL_CONFIG") ?? p.config,
    },
    fallbackQuick:
      parseBool(envValue(env, "C2C_TUNNEL_FALLBACK_QUICK")) ??
      p.fallbackQuick ??
      DEFAULT_TUNNEL_CONFIG.fallbackQuick,
    // Deliberately environment-only: no project file may re-enable it.
    tokenInArgv: parseBool(envValue(env, "C2C_TUNNEL_TOKEN_IN_ARGV")) ?? DEFAULT_TUNNEL_CONFIG.tokenInArgv,
  };
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Accept `c2c.example.com`, `https://c2c.example.com/`, `HTTPS://C2C.Example.com/mcp`… */
export function normalizeHostname(input: string | undefined): string | null {
  if (!input) return null;
  let value = input.trim();
  if (value === "") return null;
  value = value.replace(/^https?:\/\//i, "");
  value = value.split(/[/?#]/)[0];
  value = value.replace(/\.$/, "").toLowerCase();
  return HOSTNAME_RE.test(value) ? value : null;
}

/** Fixed public base URL of a named tunnel, or null when no valid hostname is configured. */
export function namedTunnelPublicUrl(config: TunnelConfig): string | null {
  const host = normalizeHostname(config.named.hostname);
  return host ? `https://${host}` : null;
}

/** MCP endpoint for a fixed hostname. */
export function namedTunnelMcpUrl(config: TunnelConfig): string | null {
  const base = namedTunnelPublicUrl(config);
  return base ? `${base}/mcp` : null;
}

/** Which named-tunnel flavour is configured, or null when neither is. */
export function namedTunnelFlavour(config: TunnelConfig): NamedTunnelFlavour | null {
  if (config.named.tokenFile || config.named.token) return "remote";
  if (config.named.name) return "local";
  return null;
}

/** Authentication mode: token file wins over the inline token. */
export function namedTunnelAuthMode(config: TunnelConfig): NamedTunnelAuthMode | null {
  if (config.named.tokenFile) return "token-file";
  if (config.named.token) return "token-env";
  if (config.named.name) return "local-config";
  return null;
}

/**
 * Reasons a named tunnel cannot start. Empty array means "usable".
 *
 * Remotely-managed tunnels (token) need no config.yml: the hostname -> origin
 * routing lives in the Cloudflare dashboard. Locally-managed tunnels do need
 * name + config.yml (tunnel / credentials-file / ingress).
 */
export function namedTunnelProblems(config: TunnelConfig): string[] {
  const problems: string[] = [];
  const { token, tokenFile, hostname, name, configFile } = config.named;
  if (!normalizeHostname(hostname)) {
    problems.push("C2C_TUNNEL_HOSTNAME is required in named mode (expected a hostname, e.g. c2c.example.com)");
  }
  if (tokenFile) {
    // Never read the file's contents — only stat it.
    return problems.concat(tokenFileProblems(tokenFile));
  }
  if (token) return problems;
  if (!name) {
    problems.push(
      "C2C_TUNNEL_TOKEN (remotely-managed) or C2C_TUNNEL_NAME (locally-managed) is required in named mode"
    );
    return problems;
  }
  if (!configFile) {
    problems.push(
      "C2C_TUNNEL_CONFIG is required for locally-managed tunnels (config.yml with tunnel, credentials-file and ingress)"
    );
  }
  return problems;
}

export function isNamedTunnelUsable(config: TunnelConfig): boolean {
  return namedTunnelProblems(config).length === 0 && namedTunnelPublicUrl(config) !== null;
}

/**
 * Extra environment for the cloudflared child process. The token travels here,
 * never in argv. `process.env` is never mutated.
 */
export function buildChildEnv(config: TunnelConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // cloudflared lets --token override --token-file, so the two must never be
  // set at the same time: token-file mode passes the path only.
  if (config.named.tokenFile) {
    return { ...base, [CLOUDFLARED_TOKEN_FILE_ENV_KEY]: config.named.tokenFile };
  }
  if (config.named.token && !config.tokenInArgv) {
    return { ...base, [CLOUDFLARED_TOKEN_ENV_KEY]: config.named.token };
  }
  return { ...base };
}

/** Replace the value that follows `--token` (and any bare token) with a placeholder. */
export function redactArgs(args: readonly string[], secret?: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--token") {
      out.push(arg, REDACTED);
      i += 1;
      continue;
    }
    out.push(secret && arg === secret ? REDACTED : arg);
  }
  return out;
}

/**
 * Arguments for the `--protocol` capability probe.
 *
 * `--protocol` is a hidden option of `cloudflared tunnel`: it does not appear
 * in `tunnel --help`, so help text cannot be used to detect it. Running the
 * real command against a tunnel name that cannot exist makes cloudflared fail
 * during argument/credential resolution — no connection is opened — and an
 * unsupported flag is reported as "flag provided but not defined".
 */
export function protocolProbeArgs(protocol: CloudflaredProtocol): string[] {
  return ["tunnel", "--protocol", protocol, "run", CLOUDFLARED_PROTOCOL_PROBE_TUNNEL];
}

/** True when cloudflared accepted `--protocol` (i.e. did not reject the flag). */
export function protocolFlagSupported(probeOutput: string): boolean {
  if (!probeOutput || probeOutput.trim() === "") return false;
  return !/flag provided but not defined/i.test(probeOutput);
}

/** Shared `tunnel` + transport flags for both providers. */
function baseArgs(protocol: CloudflaredProtocol, protocolSupported: boolean): string[] {
  const args = ["tunnel"];
  if (protocol !== "auto" && protocolSupported) {
    // Official syntax: cloudflared tunnel --protocol <auto|http2|quic> run ...
    args.push("--protocol", protocol);
  }
  return args;
}

export function buildQuickTunnelArgs(
  localPort: number,
  opts: { protocol?: CloudflaredProtocol; protocolSupported?: boolean } = {}
): string[] {
  const protocol = opts.protocol ?? "auto";
  return [
    ...baseArgs(protocol, opts.protocolSupported ?? false),
    "--url",
    `http://127.0.0.1:${localPort}`,
    "--no-autoupdate",
  ];
}

/**
 * Named tunnel arguments.
 *
 * Token mode wins over name mode, matching cloudflared's own precedence. By
 * default the token is NOT present here — it is handed to the child through
 * TUNNEL_TOKEN (see buildChildEnv).
 */
export function buildNamedTunnelArgs(
  config: TunnelConfig,
  opts: { protocolSupported?: boolean } = {}
): string[] {
  const { token, tokenFile, name, configFile } = config.named;
  const args = baseArgs(config.protocol, opts.protocolSupported ?? false);
  if (configFile) args.push("--config", configFile);
  args.push("--no-autoupdate", "run");
  if (tokenFile) {
    // Path travels through TUNNEL_TOKEN_FILE in the child env, never argv.
    return args;
  }
  if (token) {
    // Only with C2C_TUNNEL_TOKEN_IN_ARGV=1 (legacy cloudflared builds).
    if (config.tokenInArgv) args.push("--token", token);
  } else if (name) {
    args.push(name);
  }
  return args;
}
