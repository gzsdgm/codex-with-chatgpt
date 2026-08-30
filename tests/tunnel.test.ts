import { describe, it, expect } from "vitest";
import { parseQuickTunnelUrl } from "../src/tunnel/cloudflared.js";
import {
  buildChildEnv,
  buildNamedTunnelArgs,
  buildQuickTunnelArgs,
  CLOUDFLARED_PROTOCOL_PROBE_TUNNEL,
  CLOUDFLARED_TOKEN_ENV_KEY,
  isNamedTunnelUsable,
  namedTunnelFlavour,
  namedTunnelMcpUrl,
  namedTunnelProblems,
  namedTunnelPublicUrl,
  normalizeHostname,
  protocolFlagSupported,
  protocolProbeArgs,
  redactArgs,
  resolveTunnelConfig,
  type ProjectTunnelConfig,
  type TunnelConfig,
} from "../src/tunnel/config.js";

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  ({ ...process.env, ...values }) as NodeJS.ProcessEnv;

const named = (over: Partial<TunnelConfig["named"]> = {}, extra: Partial<TunnelConfig> = {}): TunnelConfig => ({
  mode: "named",
  protocol: "auto",
  named: { hostname: "c2c.example.test", token: "REDACTED_TEST_TOKEN", ...over },
  fallbackQuick: false,
  tokenInArgv: false,
  ...extra,
});

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe("https://random-words-here-1234.trycloudflare.com");
  });

  it("ignores unrelated lines", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
  });

  it("does not match non-trycloudflare hosts", () => {
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });
});

describe("resolveTunnelConfig", () => {
  it("defaults to Quick Tunnel when nothing is configured", () => {
    const cfg = resolveTunnelConfig({} as NodeJS.ProcessEnv);
    expect(cfg.mode).toBe("quick");
    expect(cfg.protocol).toBe("auto");
    expect(cfg.fallbackQuick).toBe(false);
    expect(cfg.tokenInArgv).toBe(false);
    expect(cfg.named).toEqual({});
  });

  it("reads named mode and hostname from the environment", () => {
    const cfg = resolveTunnelConfig(
      env({ C2C_TUNNEL_MODE: "named", C2C_TUNNEL_HOSTNAME: "c2c.example.test", C2C_TUNNEL_TOKEN: "tok" })
    );
    expect(cfg.mode).toBe("named");
    expect(cfg.named.hostname).toBe("c2c.example.test");
    expect(cfg.named.token).toBe("tok");
  });

  it("falls back to the project .c2c.json tunnel block", () => {
    const project: ProjectTunnelConfig = { mode: "named", hostname: "from.project", config: "C:\\cf\\config.yml" };
    const cfg = resolveTunnelConfig({} as NodeJS.ProcessEnv, project);
    expect(cfg.mode).toBe("named");
    expect(cfg.named.hostname).toBe("from.project");
    expect(cfg.named.configFile).toBe("C:\\cf\\config.yml");
  });

  it("lets environment variables win over the project config", () => {
    const project: ProjectTunnelConfig = { mode: "quick", hostname: "from.project" };
    const cfg = resolveTunnelConfig(env({ C2C_TUNNEL_MODE: "named", C2C_TUNNEL_HOSTNAME: "from.env" }), project);
    expect(cfg.mode).toBe("named");
    expect(cfg.named.hostname).toBe("from.env");
  });

  it("never reads a tunnel token from the project config", () => {
    // .c2c.json lives in the workspace and is routinely sent to ChatGPT.
    const project = { mode: "named", hostname: "h", token: "leaked" } as ProjectTunnelConfig;
    const cfg = resolveTunnelConfig({} as NodeJS.ProcessEnv, project);
    expect(cfg.named.token).toBeUndefined();
  });

  it("parses C2C_TUNNEL_FALLBACK_QUICK and C2C_CLOUDFLARED_PROTOCOL", () => {
    expect(resolveTunnelConfig(env({ C2C_TUNNEL_FALLBACK_QUICK: "1" })).fallbackQuick).toBe(true);
    expect(resolveTunnelConfig(env({ C2C_TUNNEL_FALLBACK_QUICK: "0" })).fallbackQuick).toBe(false);
    expect(resolveTunnelConfig(env({})).fallbackQuick).toBe(false);
    expect(resolveTunnelConfig(env({ C2C_CLOUDFLARED_PROTOCOL: "http2" })).protocol).toBe("http2");
    expect(resolveTunnelConfig(env({ C2C_CLOUDFLARED_PROTOCOL: "nonsense" })).protocol).toBe("auto");
  });

  it("keeps the legacy argv-token escape hatch off unless explicitly enabled", () => {
    expect(resolveTunnelConfig(env({})).tokenInArgv).toBe(false);
    expect(resolveTunnelConfig(env({ C2C_TUNNEL_TOKEN_IN_ARGV: "nonsense" })).tokenInArgv).toBe(false);
    expect(resolveTunnelConfig(env({ C2C_TUNNEL_TOKEN_IN_ARGV: "1" })).tokenInArgv).toBe(true);
  });

  it("treats unknown modes as quick", () => {
    expect(resolveTunnelConfig(env({ C2C_TUNNEL_MODE: "weird" })).mode).toBe("quick");
  });
});

describe("fixed public URL", () => {
  it("normalizes hostnames written with a scheme or path", () => {
    expect(normalizeHostname("c2c.example.test")).toBe("c2c.example.test");
    expect(normalizeHostname("https://c2c.example.test")).toBe("c2c.example.test");
    expect(normalizeHostname("HTTPS://C2C.Example.Test/mcp")).toBe("c2c.example.test");
    expect(normalizeHostname("not a host")).toBeNull();
    expect(normalizeHostname("")).toBeNull();
    expect(normalizeHostname(undefined)).toBeNull();
  });

  it("derives https://<hostname> and /mcp", () => {
    expect(namedTunnelPublicUrl(named())).toBe("https://c2c.example.test");
    expect(namedTunnelMcpUrl(named())).toBe("https://c2c.example.test/mcp");
  });

  it("does not depend on the trycloudflare.com pattern", () => {
    // A named hostname must resolve even though it never matches the quick regex.
    expect(parseQuickTunnelUrl("https://c2c.example.test")).toBeNull();
    expect(namedTunnelPublicUrl(named())).toBe("https://c2c.example.test");
  });
});

describe("named tunnel flavours", () => {
  it("classifies token mode as remotely-managed and name mode as locally-managed", () => {
    expect(namedTunnelFlavour(named())).toBe("remote");
    expect(namedTunnelFlavour(named({ token: undefined, name: "t", configFile: "c.yml" }))).toBe("local");
    expect(namedTunnelFlavour(named({ token: undefined }))).toBeNull();
  });

  it("does NOT require config.yml for remotely-managed (token) tunnels", () => {
    const cfg = named();
    expect(cfg.named.configFile).toBeUndefined();
    expect(namedTunnelProblems(cfg)).toEqual([]);
    expect(isNamedTunnelUsable(cfg)).toBe(true);
  });

  it("still requires name + config.yml for locally-managed tunnels", () => {
    expect(namedTunnelProblems(named({ token: undefined, name: "t" }))).toHaveLength(1);
    expect(namedTunnelProblems(named({ token: undefined, name: "t" }))[0]).toMatch(/C2C_TUNNEL_CONFIG/);
    expect(namedTunnelProblems(named({ token: undefined, name: "t", configFile: "c.yml" }))).toEqual([]);
    expect(namedTunnelProblems(named({ token: undefined }))[0]).toMatch(/C2C_TUNNEL_TOKEN|C2C_TUNNEL_NAME/);
  });

  it("always requires a hostname", () => {
    expect(namedTunnelProblems(named({ hostname: undefined }))[0]).toMatch(/C2C_TUNNEL_HOSTNAME/);
    expect(isNamedTunnelUsable(named({ hostname: "not a host" }))).toBe(false);
  });
});

describe("cloudflared argument construction", () => {
  it("keeps the historical Quick Tunnel command unchanged", () => {
    expect(buildQuickTunnelArgs(48765)).toEqual([
      "tunnel",
      "--url",
      "http://127.0.0.1:48765",
      "--no-autoupdate",
    ]);
  });

  it("puts --protocol directly after `tunnel` (official syntax)", () => {
    expect(buildQuickTunnelArgs(48765, { protocol: "http2", protocolSupported: true })).toEqual([
      "tunnel",
      "--protocol",
      "http2",
      "--url",
      "http://127.0.0.1:48765",
      "--no-autoupdate",
    ]);
    expect(buildQuickTunnelArgs(48765, { protocol: "quic", protocolSupported: true })).toEqual([
      "tunnel",
      "--protocol",
      "quic",
      "--url",
      "http://127.0.0.1:48765",
      "--no-autoupdate",
    ]);
    // Unsupported builds keep the legacy command untouched.
    expect(buildQuickTunnelArgs(48765, { protocol: "http2", protocolSupported: false })).toEqual([
      "tunnel",
      "--url",
      "http://127.0.0.1:48765",
      "--no-autoupdate",
    ]);
  });

  it("never puts the token in argv", () => {
    const cfg = named();
    const args = buildNamedTunnelArgs(cfg, { protocolSupported: true });
    expect(args).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(args.join(" ")).not.toContain(cfg.named.token!);
    expect(args).not.toContain("--token");
  });

  it("uses protocol + env-token for a remotely-managed tunnel", () => {
    const cfg = named({}, { protocol: "http2" });
    expect(buildNamedTunnelArgs(cfg, { protocolSupported: true })).toEqual([
      "tunnel",
      "--protocol",
      "http2",
      "--no-autoupdate",
      "run",
    ]);
    expect(buildChildEnv(cfg, { PATH: "x" })).toEqual({ PATH: "x", TUNNEL_TOKEN: cfg.named.token });
  });

  it("builds locally-managed (config + name) arguments", () => {
    const cfg = named({ token: undefined, name: "my-tunnel", configFile: "C:\\cf\\config.yml" });
    expect(buildNamedTunnelArgs(cfg)).toEqual([
      "tunnel",
      "--config",
      "C:\\cf\\config.yml",
      "--no-autoupdate",
      "run",
      "my-tunnel",
    ]);
    // Locally-managed tunnels use credentials on disk, so no token env is set.
    expect(buildChildEnv(cfg, { PATH: "x" })).toEqual({ PATH: "x" });
  });

  it("only puts the token in argv with the legacy escape hatch", () => {
    const cfg = named({}, { tokenInArgv: true });
    const args = buildNamedTunnelArgs(cfg);
    expect(args).toEqual(["tunnel", "--no-autoupdate", "run", "--token", cfg.named.token]);
    // ...and then it is not duplicated into the environment.
    expect(buildChildEnv(cfg, { PATH: "x" })).toEqual({ PATH: "x" });
  });
});

describe("protocol capability detection", () => {
  it("probes the real syntax against an impossible tunnel name", () => {
    expect(protocolProbeArgs("http2")).toEqual([
      "tunnel",
      "--protocol",
      "http2",
      "run",
      CLOUDFLARED_PROTOCOL_PROBE_TUNNEL,
    ]);
  });

  it("treats 'flag provided but not defined' as unsupported", () => {
    expect(protocolFlagSupported("Incorrect Usage. flag provided but not defined: -protocol")).toBe(false);
  });

  it("treats a credential/tunnel resolution error as supported", () => {
    expect(protocolFlagSupported("error parsing tunnel ID: Error locating origin cert")).toBe(true);
    expect(protocolFlagSupported("2026-08-30 ERR Cannot determine default origin certificate path.")).toBe(true);
  });

  it("does not treat empty output as supported", () => {
    expect(protocolFlagSupported("")).toBe(false);
  });
});

describe("secret redaction", () => {
  const TOKEN = "REDACTED_TEST_TOKEN_SUPERSECRET";

  it("redacts the value that follows --token", () => {
    expect(redactArgs(["tunnel", "run", "--token", TOKEN])).toEqual([
      "tunnel",
      "run",
      "--token",
      "[REDACTED]",
    ]);
  });

  it("redacts a bare token occurrence", () => {
    expect(redactArgs(["run", TOKEN], TOKEN)).toEqual(["run", "[REDACTED]"]);
  });

  it("maps C2C_TUNNEL_TOKEN onto cloudflared's TUNNEL_TOKEN", () => {
    expect(CLOUDFLARED_TOKEN_ENV_KEY).toBe("TUNNEL_TOKEN");
    const child = buildChildEnv(named(), { HOME: "/h" });
    expect(child.TUNNEL_TOKEN).toBe("REDACTED_TEST_TOKEN");
    expect(child.HOME).toBe("/h");
  });

  it("never mutates process.env", () => {
    const before = { ...process.env };
    buildChildEnv(named());
    expect(process.env).toEqual(before);
    expect(process.env.TUNNEL_TOKEN).toBeUndefined();
  });
});

describe("Windows paths", () => {
  it("accepts a Windows config.yml path", () => {
    const cfg = resolveTunnelConfig(env({ C2C_TUNNEL_CONFIG: "C:\\Users\\guanz\\.cloudflared\\config.yml" }));
    expect(cfg.named.configFile).toBe("C:\\Users\\guanz\\.cloudflared\\config.yml");
  });

  it("keeps backslashes when building arguments", () => {
    const cfg = named({ token: undefined, name: "t", configFile: "C:\\cf\\config.yml" });
    expect(buildNamedTunnelArgs(cfg)).toContain("C:\\cf\\config.yml");
  });
});
