import fs from "node:fs";
import { spawnSync } from "node:child_process";

export type TunnelMode = "quick" | "named";
export type CloudflaredProtocol = "auto" | "quic" | "http2";

export interface SpawnOptions {
  stdio: ["ignore", "pipe", "pipe"];
  env?: NodeJS.ProcessEnv;
  windowsHide: boolean;
}

export interface TunnelConfig {
  mode?: TunnelMode;
  protocol: CloudflaredProtocol;
  named: {
    name?: string;
    hostname?: string;
    tokenFile?: string;
  };
}

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const BROAD_PRINCIPALS = new Set([
  "everyone",
  "authenticated users",
  "users",
  "builtin\\users",
  "nt authority\\authenticated users",
  "s-1-1-0",
  "s-1-5-11",
  "s-1-5-32-545",
]);

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseMode(value: string | undefined): TunnelMode | undefined {
  return value === "quick" || value === "named" ? value : undefined;
}

function parseProtocol(value: string | undefined): CloudflaredProtocol {
  return value === "quic" || value === "http2" ? value : "auto";
}

export function resolveTunnelConfig(env: NodeJS.ProcessEnv = process.env): TunnelConfig {
  return {
    mode: parseMode(envValue(env, "C2C_TUNNEL_MODE")),
    protocol: parseProtocol(envValue(env, "C2C_CLOUDFLARED_PROTOCOL")),
    named: {
      name: envValue(env, "C2C_TUNNEL_NAME"),
      hostname: envValue(env, "C2C_TUNNEL_HOSTNAME"),
      tokenFile: envValue(env, "C2C_TUNNEL_TOKEN_FILE"),
    },
  };
}

export function normalizeHostname(input: string | undefined): string | null {
  if (!input) return null;
  const value = input.trim().replace(/^https?:\/\//i, "").split(/[/?#]/)[0].replace(/\.$/, "").toLowerCase();
  return HOSTNAME_RE.test(value) ? value : null;
}

export function namedTunnelPublicUrl(config: TunnelConfig): string | null {
  const hostname = normalizeHostname(config.named.hostname);
  return hostname ? `https://${hostname}` : null;
}

function principalKey(principal: string): string {
  const value = principal.trim().toLowerCase();
  const slash = value.lastIndexOf("\\");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function parseIcaclsPrincipals(output: string): string[] {
  const principals: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(successfully processed|已成功处理)/i.test(line)) continue;
    const withoutAce = line.replace(/:\([^)]*\)\s*$/, "").trim();
    if (withoutAce) principals.push(withoutAce.split(/\s+/).at(-1) ?? withoutAce);
  }
  return principals;
}

export interface TokenFileReport {
  path: string;
  exists: boolean;
  regularFile: boolean;
  secure: boolean;
  detail: string;
  problems: string[];
}

/** Inspect metadata only. The token-file contents are never opened or read. */
export function inspectTokenFile(tokenFile: string | undefined): TokenFileReport | null {
  if (!tokenFile) return null;
  const missing: TokenFileReport = {
    path: tokenFile,
    exists: false,
    regularFile: false,
    secure: false,
    detail: "token file not found",
    problems: [`token file not found: ${tokenFile}`],
  };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(tokenFile);
  } catch {
    return missing;
  }
  if (!stat.isFile()) {
    return {
      ...missing,
      exists: true,
      detail: "token file is not a regular file",
      problems: [`token file is not a regular file: ${tokenFile}`],
    };
  }
  if (stat.size === 0) {
    return {
      ...missing,
      exists: true,
      regularFile: true,
      detail: "token file is empty",
      problems: [`token file is empty: ${tokenFile}`],
    };
  }
  try {
    const fd = fs.openSync(tokenFile, "r");
    fs.closeSync(fd);
  } catch {
    return {
      ...missing,
      exists: true,
      regularFile: true,
      detail: "token file is not readable",
      problems: [`token file is not readable: ${tokenFile}`],
    };
  }

  if (process.platform === "win32") {
    const acl = spawnSync("icacls", [tokenFile], { encoding: "utf8", timeout: 10_000 });
    const output = `${acl.stdout ?? ""}${acl.stderr ?? ""}`;
    if (!output.trim()) {
      return {
        ...missing,
        exists: true,
        regularFile: true,
        detail: "could not read token file ACL",
        problems: [],
      };
    }
    const broad = parseIcaclsPrincipals(output).filter((principal) => BROAD_PRINCIPALS.has(principalKey(principal)));
    if (broad.length > 0) {
      return {
        ...missing,
        exists: true,
        regularFile: true,
        detail: "token file ACL is too permissive",
        problems: [],
      };
    }
    return {
      ...missing,
      exists: true,
      regularFile: true,
      secure: true,
      detail: "token file ACL is restricted",
      problems: [],
    };
  }

  const mode = stat.mode & 0o777;
  if (mode & 0o077) {
    return {
      ...missing,
      exists: true,
      regularFile: true,
      detail: "token file permissions are too open",
      problems: [`token file permissions are too open: ${(mode & 0o777).toString(8)}`],
    };
  }
  return {
    ...missing,
    exists: true,
    regularFile: true,
    secure: true,
    detail: "token file permissions are restricted",
    problems: [],
  };
}

export function tokenFileProblems(tokenFile: string | undefined): string[] {
  return inspectTokenFile(tokenFile)?.problems ?? [];
}

export function namedTunnelProblems(config: TunnelConfig): string[] {
  const problems: string[] = [];
  if (!config.named.name?.trim()) problems.push("C2C_TUNNEL_NAME is required in named mode");
  if (!normalizeHostname(config.named.hostname)) {
    problems.push("C2C_TUNNEL_HOSTNAME is required in named mode");
  }
  if (config.named.tokenFile) problems.push(...tokenFileProblems(config.named.tokenFile));
  return problems;
}

/** Build only non-secret child environment state. */
export function buildChildEnv(config: TunnelConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!config.named.tokenFile) return { ...base };
  return { ...base, TUNNEL_TOKEN_FILE: config.named.tokenFile };
}

/** Token-file mode carries the path through the child environment, never argv. */
export function buildNamedTunnelArgs(config: TunnelConfig, localPort: number): string[] {
  const args = ["tunnel"];
  if (config.protocol !== "auto") args.push("--protocol", config.protocol);
  args.push("--no-autoupdate", "--url", `http://127.0.0.1:${localPort}`, "run", config.named.name ?? "");
  return args;
}
