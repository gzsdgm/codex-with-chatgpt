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

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const TUNNEL_NAME_MAX_LENGTH = 128;
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

export function normalizeNamedTunnelName(input: string | undefined): string | null {
  const value = input?.trim() ?? "";
  return value.length >= 1 && value.length <= TUNNEL_NAME_MAX_LENGTH ? value : null;
}

export function normalizeHostname(input: string | undefined): string | null {
  if (!input) return null;
  const value = input.trim().replace(/\.$/, "").toLowerCase();
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

const ACE_FLAGS = new Set(["I", "OI", "CI", "IO", "NP"]);
const ACE_PERMISSIONS = new Set(["F", "M", "W", "R", "RX"]);

interface ParsedAce {
  principal: string;
  flags: string[];
  permission: string;
}

function isIcaclsSummary(line: string): boolean {
  return /^(successfully processed|failed processing|已成功处理|处理失败)\b/i.test(line);
}

function parseIcaclsAce(line: string, tokenFile: string): ParsedAce | null {
  const normalized = line.toLowerCase();
  const tokenPrefix = tokenFile.trim().toLowerCase();
  if (normalized.startsWith(tokenPrefix)) line = line.slice(tokenFile.trim().length).trim();

  const markerIndex = line.search(/:\s*\(/);
  if (markerIndex <= 0) return null;
  const principal = line.slice(0, markerIndex).trim();
  const markerText = line.slice(markerIndex + 1).trim();
  const markers = Array.from(markerText.matchAll(/\(([^()]*)\)/g), (match) => match[1].trim().toUpperCase());
  const normalizedMarkers = markers.map((marker) => `(${marker})`).join("");
  if (!principal || markers.length === 0 || markerText.replace(/\s+/g, "").toUpperCase() !== normalizedMarkers) return null;

  const unknown = markers.filter((marker) => !ACE_FLAGS.has(marker) && !ACE_PERMISSIONS.has(marker));
  const permissions = markers.filter((marker) => ACE_PERMISSIONS.has(marker));
  if (unknown.length > 0 || permissions.length !== 1) return null;
  return { principal, flags: markers.filter((marker) => ACE_FLAGS.has(marker)), permission: permissions[0] };
}

function parseIcaclsAces(output: string, tokenFile: string): ParsedAce[] | "malformed" | null {
  const aces: ParsedAce[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || isIcaclsSummary(line)) continue;
    const ace = parseIcaclsAce(line, tokenFile);
    if (!ace) return aces.length > 0 ? "malformed" : null;
    aces.push(ace);
  }
  return aces.length > 0 ? aces : null;
}

export interface TokenFileReport {
  path: string;
  exists: boolean;
  regularFile: boolean;
  secure: boolean;
  detail: string;
  problems: string[];
}

export interface IcaclsInspectionResult {
  status: number | null;
  stdout: string | null;
  error?: unknown;
}

function aclFailure(detail: string, problem: string): Pick<TokenFileReport, "secure" | "detail" | "problems"> {
  return { secure: false, detail, problems: [problem] };
}

/** Validate a completed icacls result without reading token-file contents. */
export function inspectWindowsTokenFileAcl(
  tokenFile: string,
  result: IcaclsInspectionResult
): Pick<TokenFileReport, "secure" | "detail" | "problems"> {
  if (result.error || result.status !== 0) {
    return aclFailure("could not inspect token file ACL", "ACL_INSPECTION_FAILED");
  }
  if (!result.stdout?.trim()) return aclFailure("token file ACL output is empty", "ACL_OUTPUT_EMPTY");
  const aces = parseIcaclsAces(result.stdout, tokenFile);
  if (aces === "malformed") return aclFailure("token file ACL entry is unparseable", "ACL_ENTRY_UNPARSEABLE");
  if (!aces) return aclFailure("token file ACL output is unparseable", "ACL_OUTPUT_UNPARSEABLE");

  const broad = aces.filter((ace) => BROAD_PRINCIPALS.has(principalKey(ace.principal)));
  if (broad.length > 0) {
    return aclFailure("token file ACL is too permissive", "ACL_BROAD_PRINCIPAL");
  }
  return { secure: true, detail: "token file ACL is restricted", problems: [] };
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
    const aclReport = inspectWindowsTokenFileAcl(tokenFile, {
      status: acl.status,
      stdout: typeof acl.stdout === "string" ? acl.stdout : null,
      error: acl.error,
    });
    return {
      ...missing,
      exists: true,
      regularFile: true,
      ...aclReport,
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
  if (!normalizeNamedTunnelName(config.named.name)) {
    problems.push("Named tunnel name must be between 1 and 128 characters");
  }
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
