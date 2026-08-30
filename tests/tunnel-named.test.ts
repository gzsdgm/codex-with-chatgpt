import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { Logger } from "../src/logger/index.js";
import { CloudflaredQuickTunnel } from "../src/tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../src/tunnel/named.js";
import { createTunnelProvider } from "../src/tunnel/index.js";
import type { SpawnFn, TunnelConfig } from "../src/tunnel/config.js";
import type { TunnelProvider } from "../src/tunnel/provider.js";
import { AuthStore } from "../src/auth/store.js";
import { startBridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const TOKEN = "REDACTED_TEST_TOKEN_SUPERSECRET";
const HOSTNAME = "c2c.example.test";

interface SpawnCall {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

interface FakeSpawn {
  fn: SpawnFn;
  calls: SpawnCall[];
  emitExit(code: number): void;
}

/** A stand-in for child_process.spawn: no real cloudflared is ever started. */
function makeFakeSpawn(lines: string[] = ["INF Registered tunnel connection connIndex=0"]): FakeSpawn {
  const calls: SpawnCall[] = [];
  let last: EventEmitter | null = null;
  const fn: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const child = new EventEmitter() as unknown as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      setImmediate(() => child.emit("exit", 0));
      return true;
    };
    last = child;
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${line}\n`);
    });
    return child as unknown as ChildProcess;
  };
  return {
    fn,
    calls,
    emitExit: (code: number) => {
      if (last) last.emit("exit", code);
    },
  };
}

const namedConfig = (over: Partial<TunnelConfig["named"]> = {}, extra: Partial<TunnelConfig> = {}): TunnelConfig => ({
  mode: "named",
  protocol: "auto",
  named: { hostname: HOSTNAME, token: TOKEN, ...over },
  fallbackQuick: false,
  tokenInArgv: false,
  ...extra,
});

function recordingLogger(file: string): Logger {
  return new Logger({ name: "tunnel-test", file, console: false, level: "debug" });
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe("provider selection", () => {
  it("keeps Quick Tunnel as the default", () => {
    const provider = createTunnelProvider(undefined, { env: {} as NodeJS.ProcessEnv });
    expect(provider.name).toBe("cloudflare-quick");
  });

  it("selects the named provider when mode=named is complete", () => {
    const provider = createTunnelProvider(undefined, {
      env: {
        C2C_TUNNEL_MODE: "named",
        C2C_TUNNEL_HOSTNAME: HOSTNAME,
        C2C_TUNNEL_TOKEN: TOKEN,
      } as unknown as NodeJS.ProcessEnv,
    });
    expect(provider.name).toBe("cloudflare-named");
  });

  it("NEVER falls back to Quick when the named config is incomplete", () => {
    const provider = createTunnelProvider(undefined, {
      env: { C2C_TUNNEL_MODE: "named" } as unknown as NodeJS.ProcessEnv,
    });
    expect(provider.name).toBe("cloudflare-named");
  });

  it("falls back to Quick only with C2C_TUNNEL_FALLBACK_QUICK=1", () => {
    const provider = createTunnelProvider(undefined, {
      env: { C2C_TUNNEL_MODE: "named", C2C_TUNNEL_FALLBACK_QUICK: "1" } as unknown as NodeJS.ProcessEnv,
    });
    expect(provider.name).toBe("cloudflare-quick");
  });
});

describe("token transport", () => {
  it("never appears in argv and travels through TUNNEL_TOKEN in the child env", async () => {
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig(),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    const url = await provider.start(48765);
    expect(url).toBe("https://c2c.example.test");

    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0];
    expect(call.cmd).toBe("cloudflared");
    expect(call.args).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(call.args.join(" ")).not.toContain(TOKEN);
    expect(call.args).not.toContain("--token");
    expect(call.env).toBeDefined();
    expect(call.env!.TUNNEL_TOKEN).toBe(TOKEN);

    // process.env must stay clean: only the child gets the secret.
    expect(process.env.TUNNEL_TOKEN).toBeUndefined();

    await provider.stop();
  });

  it("still supports the legacy argv form when explicitly enabled", async () => {
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({}, { tokenInArgv: true }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    await provider.start(48765);
    expect(spawn.calls[0].args).toEqual(["tunnel", "--no-autoupdate", "run", "--token", TOKEN]);
    expect(spawn.calls[0].env!.TUNNEL_TOKEN).toBeUndefined();
    await provider.stop();
  });

  it("does not leak the token into logs", async () => {
    const dir = makeTmpDir("named-log");
    dirs.push(dir);
    const logFile = path.join(dir, "tunnel.log");
    const spawn = makeFakeSpawn(["INF Registered tunnel connection connIndex=0"]);
    const provider = new CloudflaredNamedTunnel(recordingLogger(logFile), {
      config: namedConfig(),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    await provider.start(48765);
    await provider.stop();

    const text = fs.readFileSync(logFile, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("https://c2c.example.test");
    // Remotely-managed tunnels must not be told they need a config.yml.
    expect(text).toContain("Remotely-managed");
    expect(text).not.toMatch(/config\.yml is required/);
  });

  it("does not leak the token into runtime/state files", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const dir = makeTmpDir("named-state");
    dirs.push(dir);

    const spawn = makeFakeSpawn();
    // Logger appends without creating parent directories.
    fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
    const bridgeLogger = new Logger({
      name: "bridge-named",
      file: path.join(stateDir, "logs", "bridge.log"),
      console: false,
      level: "debug",
    });
    const bridge = await startBridge({
      workspaceRoot: dir,
      port: 0,
      persistRuntime: true,
      logger: bridgeLogger,
      tunnelProvider: createTunnelProvider(bridgeLogger, {
        config: namedConfig(),
        spawnFn: spawn.fn,
        binary: "cloudflared",
      }),
    });
    const response = await fetch(`http://127.0.0.1:${bridge.port}/admin/tunnel/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.adminToken}` },
    });
    expect(response.ok).toBe(true);

    // While it is running, runtime JSON and the log file both exist.
    const runtimeFile = path.join(stateDir, "runtime", `${new Workspace(dir).id}.json`);
    expect(fs.existsSync(runtimeFile)).toBe(true);
    const runtimeJson = fs.readFileSync(runtimeFile, "utf8");
    expect(runtimeJson).not.toContain(TOKEN);
    expect(runtimeJson).toContain("https://c2c.example.test");

    const bridgeLog = path.join(stateDir, "logs", "bridge.log");
    expect(fs.existsSync(bridgeLog)).toBe(true);
    expect(fs.readFileSync(bridgeLog, "utf8")).not.toContain(TOKEN);

    await bridge.close();

    const files: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(stateDir);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(fs.readFileSync(file, "utf8")).not.toContain(TOKEN);
    }
  });
});

describe("CloudflaredNamedTunnel", () => {
  it("spawns cloudflared in locally-managed mode with config + name", async () => {
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({ token: undefined, name: "my-tunnel", configFile: "C:\\cf\\config.yml" }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    await provider.start(48765);
    expect(spawn.calls[0].args).toEqual([
      "tunnel",
      "--config",
      "C:\\cf\\config.yml",
      "--no-autoupdate",
      "run",
      "my-tunnel",
    ]);
    expect(spawn.calls[0].env!.TUNNEL_TOKEN).toBeUndefined();
    await provider.stop();
  });

  it("places --protocol http2 right after `tunnel`", async () => {
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({}, { protocol: "http2" }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
      protocolSupport: true,
    });
    await provider.start(48765);
    expect(spawn.calls[0].args).toEqual(["tunnel", "--protocol", "http2", "--no-autoupdate", "run"]);
    expect(spawn.calls[0].env!.TUNNEL_TOKEN).toBe(TOKEN);
    await provider.stop();
  });

  it("places --protocol quic right after `tunnel`", async () => {
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({}, { protocol: "quic" }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
      protocolSupport: true,
    });
    await provider.start(48765);
    expect(spawn.calls[0].args).toEqual(["tunnel", "--protocol", "quic", "--no-autoupdate", "run"]);
    await provider.stop();
  });

  it("drops --protocol when the binary does not support it", async () => {
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({}, { protocol: "http2" }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
      protocolSupport: false,
    });
    await provider.start(48765);
    expect(spawn.calls[0].args).toEqual(["tunnel", "--no-autoupdate", "run"]);
    await provider.stop();
  });

  it("keeps auto behaviour by default (no protocol flag at all)", async () => {
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig(),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    await provider.start(48765);
    expect(spawn.calls[0].args).not.toContain("--protocol");
    await provider.stop();
  });

  it("returns the SAME public URL after stop -> start (restart never rotates it)", async () => {
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({}, { protocol: "http2" }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
      protocolSupport: true,
    });
    const first = await provider.start(48765);
    await provider.stop();
    expect(provider.status().running).toBe(false);
    const second = await provider.start(48765);
    expect(second).toBe(first);
    expect(second).toBe("https://c2c.example.test");
    await provider.stop();
  });

  it("does not start a second cloudflared while one is running", async () => {
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig(),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    await provider.start(48765);
    await provider.start(48765);
    expect(spawn.calls).toHaveLength(1);
    await provider.stop();
  });

  it("fails safe when hostname or credentials are missing", async () => {
    const spawn = makeFakeSpawn();
    const noHost = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({ hostname: undefined }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    await expect(noHost.start(48765)).rejects.toThrow(/NEED_NAMED_TUNNEL_CONFIG/);
    expect(spawn.calls).toHaveLength(0);

    const noCreds = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({ token: undefined }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    await expect(noCreds.start(48765)).rejects.toThrow(/NEED_NAMED_TUNNEL_CONFIG/);
    expect(spawn.calls).toHaveLength(0);
  });

  it("rejects when cloudflared exits before the tunnel is ready", async () => {
    const spawn = makeFakeSpawn([]);
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig(),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    const pending = provider.start(48765);
    setImmediate(() => spawn.emitExit(1));
    await expect(pending).rejects.toThrow(/exited/);
  });

  it("reports configuration problems through doctor()", async () => {
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({ hostname: undefined }),
      binary: "cloudflared",
    });
    const report = await provider.doctor();
    expect(report.provider).toBe("cloudflare-named");
    expect(report.problems.join(" ")).toMatch(/C2C_TUNNEL_HOSTNAME/);
  });
});

describe("CloudflaredQuickTunnel regression", () => {
  it("still parses a random trycloudflare.com URL", async () => {
    const spawn = makeFakeSpawn(["INF |  https://random-words-here-1234.trycloudflare.com  |"]);
    const provider = new CloudflaredQuickTunnel(undefined, { spawnFn: spawn.fn, binary: "cloudflared" });
    const url = await provider.start(48765);
    expect(url).toBe("https://random-words-here-1234.trycloudflare.com");
    expect(spawn.calls[0].args).toEqual(["tunnel", "--url", "http://127.0.0.1:48765", "--no-autoupdate"]);
    await provider.stop();
  });

  it("places --protocol http2 after `tunnel` and keeps --url", async () => {
    const spawn = makeFakeSpawn(["INF |  https://random-words-here-1234.trycloudflare.com  |"]);
    const provider = new CloudflaredQuickTunnel(undefined, {
      spawnFn: spawn.fn,
      binary: "cloudflared",
      protocol: "http2",
      protocolSupport: true,
    });
    await provider.start(48765);
    expect(spawn.calls[0].args).toEqual([
      "tunnel",
      "--protocol",
      "http2",
      "--url",
      "http://127.0.0.1:48765",
      "--no-autoupdate",
    ]);
    await provider.stop();
  });

  it("clears its URL on stop (quick URLs must not be reused)", async () => {
    const spawn = makeFakeSpawn(["INF |  https://random-words-here-1234.trycloudflare.com  |"]);
    const provider = new CloudflaredQuickTunnel(undefined, { spawnFn: spawn.fn, binary: "cloudflared" });
    await provider.start(48765);
    await provider.stop();
    expect(provider.getPublicUrl()).toBeNull();
  });
});

class FakeTunnel implements TunnelProvider {
  readonly name = "fake";
  private url: string | null = null;
  starts = 0;

  async start(): Promise<string> {
    this.starts += 1;
    this.url = "https://fake.example.test";
    return this.url;
  }
  async stop(): Promise<void> {
    this.url = null;
  }
  async restart(): Promise<string> {
    await this.stop();
    return this.start();
  }
  status() {
    return { running: this.url !== null, url: this.url, provider: this.name };
  }
  getPublicUrl() {
    return this.url;
  }
  async doctor() {
    return {
      provider: this.name,
      binaryFound: true,
      binaryPath: "fake",
      running: this.url !== null,
      url: this.url,
      problems: [] as string[],
    };
  }
}

describe("bridge end-to-end with a mocked cloudflared (named mode)", () => {
  it("exposes https://<hostname> and /mcp, and keeps them across tunnel restarts", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const dir = makeTmpDir("named-bridge");
    dirs.push(dir);

    const spawn = makeFakeSpawn();
    const config = namedConfig();
    const bridge = await startBridge({
      workspaceRoot: dir,
      port: 0,
      persistRuntime: true,
      tunnelProvider: createTunnelProvider(undefined, { config, spawnFn: spawn.fn, binary: "cloudflared" }),
    });

    const adminHeaders = { Authorization: `Bearer ${bridge.adminToken}` };
    const start = async (): Promise<void> => {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/admin/tunnel/start`, {
        method: "POST",
        headers: adminHeaders,
      });
      expect(response.ok).toBe(true);
    };

    await start();
    let info = (await (
      await fetch(`http://127.0.0.1:${bridge.port}/admin/info`, { headers: adminHeaders })
    ).json()) as { publicUrl: string | null; tunnel: { provider: string; url: string | null } };

    expect(info.publicUrl).toBe("https://c2c.example.test");
    expect(info.tunnel.provider).toBe("cloudflare-named");
    expect(info.tunnel.url).toBe("https://c2c.example.test");
    expect(`${info.publicUrl}/mcp`).toBe("https://c2c.example.test/mcp");
    expect(bridge.getPublicBaseUrl()).toBe("https://c2c.example.test");

    // Simulated "reboot": tunnel down, tunnel back up -> identical URL.
    await fetch(`http://127.0.0.1:${bridge.port}/admin/tunnel/stop`, { method: "POST", headers: adminHeaders });
    await start();
    info = (await (
      await fetch(`http://127.0.0.1:${bridge.port}/admin/info`, { headers: adminHeaders })
    ).json()) as typeof info;
    expect(info.publicUrl).toBe("https://c2c.example.test");

    // No Quick Tunnel was ever attempted, and the token never reached argv.
    expect(spawn.calls.length).toBeGreaterThan(0);
    for (const call of spawn.calls) {
      expect(call.args).toContain("run");
      expect(call.args.join(" ")).not.toContain("--url");
      expect(call.args.join(" ")).not.toContain(TOKEN);
      expect(call.env!.TUNNEL_TOKEN).toBe(TOKEN);
    }

    await bridge.close();
  });
});

describe("OAuth state survives tunnel restarts", () => {
  it("keeps tokens across /admin/tunnel/start and /admin/tunnel/stop", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const dir = makeTmpDir("oauth-tunnel");
    dirs.push(dir);

    const workspace = new Workspace(dir);
    const seed = new AuthStore(workspace.id);
    const client = seed.registerClient({
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector/oauth/test"],
    });
    seed.issueTokens({ clientId: client.clientId, scopes: ["offline_access"] });
    expect(seed.tokenCount()).toBe(2);

    const tunnel = new FakeTunnel();
    const bridge = await startBridge({
      workspaceRoot: dir,
      port: 0,
      persistRuntime: true,
      tunnelProvider: tunnel,
    });

    expect(bridge.authStore.tokenCount()).toBe(2);

    for (const route of ["/admin/tunnel/start", "/admin/tunnel/stop", "/admin/tunnel/start"]) {
      const response = await fetch(`http://127.0.0.1:${bridge.port}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(response.ok).toBe(true);
    }

    expect(bridge.authStore.tokenCount()).toBe(2);
    const reread = new AuthStore(workspace.id);
    expect(reread.tokenCount()).toBe(2);
    // Neither the client registration nor the tokens were touched by the tunnel churn.
    expect(reread.getClient(client.clientId)).toBeDefined();

    await bridge.close();
    const afterClose = new AuthStore(workspace.id);
    expect(afterClose.tokenCount()).toBe(2);
  });
});
