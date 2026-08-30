import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { Logger } from "../src/logger/index.js";
import { CloudflaredNamedTunnel } from "../src/tunnel/named.js";
import { createTunnelProvider } from "../src/tunnel/index.js";
import {
  buildChildEnv,
  buildNamedTunnelArgs,
  defaultTokenFilePath,
  findBroadPrincipals,
  inspectTokenFile,
  namedTunnelAuthMode,
  namedTunnelProblems,
  parseIcaclsPrincipals,
  resolveTunnelConfig,
  tokenFileProblems,
  TOKEN_FILE_NAME,
  type SpawnFn,
  type TunnelConfig,
} from "../src/tunnel/config.js";
import { startBridge } from "../src/bridge/server.js";
import { AuthStore } from "../src/auth/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const TOKEN = "REDACTED_TEST_TOKEN";
const HOSTNAME = "c2c.example.test";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const autostartScript = path.join(repoRoot, "scripts", "c2c-autostart.mjs");
const cli = path.join(repoRoot, "dist", "cli", "index.js");

interface SpawnCall {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

interface FakeSpawn {
  fn: SpawnFn;
  calls: SpawnCall[];
}

function makeFakeSpawn(lines: string[] = ["INF Registered tunnel connection connIndex=0"]): FakeSpawn {
  const calls: SpawnCall[] = [];
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
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${line}\n`);
    });
    return child as unknown as ChildProcess;
  };
  return { fn, calls };
}

const namedConfig = (over: Partial<TunnelConfig["named"]> = {}, extra: Partial<TunnelConfig> = {}): TunnelConfig => ({
  mode: "named",
  protocol: "auto",
  named: { hostname: HOSTNAME, token: TOKEN, ...over },
  fallbackQuick: false,
  tokenInArgv: false,
  ...extra,
});

/** A throwaway token file. Contains only the placeholder REDACTED_TEST_TOKEN. */
function writeTokenFile(dir: string, name = "cloudflare-tunnel.token"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
  return file;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe("token-file configuration", () => {
  it("reads C2C_TUNNEL_TOKEN_FILE from the environment", () => {
    const cfg = resolveTunnelConfig({
      C2C_TUNNEL_TOKEN_FILE: "C:\\c2c\\secrets\\cloudflare-tunnel.token",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.named.tokenFile).toBe("C:\\c2c\\secrets\\cloudflare-tunnel.token");
  });

  it("never accepts token or token-file from .c2c.json", () => {
    const project = { mode: "named", hostname: "h", tokenFile: "C:\\x", token: "leak" } as never;
    const cfg = resolveTunnelConfig({} as NodeJS.ProcessEnv, project);
    expect(cfg.named.tokenFile).toBeUndefined();
    expect(cfg.named.token).toBeUndefined();
  });

  it("reports the auth mode without revealing anything", () => {
    expect(namedTunnelAuthMode(namedConfig({ tokenFile: "C:\\x\\t.token" }))).toBe("token-file");
    expect(namedTunnelAuthMode(namedConfig())).toBe("token-env");
    expect(namedTunnelAuthMode(namedConfig({ token: undefined, name: "t" }))).toBe("local-config");
    expect(namedTunnelAuthMode(namedConfig({ token: undefined }))).toBeNull();
  });

  it("prefers the token file over the inline token", () => {
    const cfg = namedConfig({ tokenFile: "C:\\x\\t.token" });
    const env = buildChildEnv(cfg, { PATH: "p" });
    expect(env.TUNNEL_TOKEN_FILE).toBe("C:\\x\\t.token");
    expect(env.TUNNEL_TOKEN).toBeUndefined();
  });

  it("keeps the inline token working for the old mode", () => {
    const env = buildChildEnv(namedConfig(), { PATH: "p" });
    expect(env.TUNNEL_TOKEN).toBe(TOKEN);
    expect(env.TUNNEL_TOKEN_FILE).toBeUndefined();
  });

  it("keeps the legacy argv escape hatch limited to the inline token", () => {
    const withFile = namedConfig({ tokenFile: "C:\\x\\t.token" }, { tokenInArgv: true });
    expect(buildNamedTunnelArgs(withFile)).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(buildChildEnv(withFile, { PATH: "p" }).TUNNEL_TOKEN_FILE).toBe("C:\\x\\t.token");
  });

  it("uses the unified state directory for the default path", () => {
    const file = defaultTokenFilePath("C:\\Users\\guanz\\AppData\\Local\\Packages\\OpenAI.Codex_abc\\LocalCache\\Local\\codex-with-chatgpt");
    expect(file.endsWith(path.join("secrets", TOKEN_FILE_NAME))).toBe(true);
    expect(file).toContain("OpenAI.Codex_abc");
  });
});

describe("token file validation (no contents are ever read)", () => {
  it("passes for a real file", () => {
    const dir = makeTmpDir("tokfile");
    dirs.push(dir);
    const file = writeTokenFile(dir);
    expect(tokenFileProblems(file)).toEqual([]);
    expect(namedTunnelProblems(namedConfig({ tokenFile: file }))).toEqual([]);
  });

  it("fails safe when the file is missing", () => {
    const dir = makeTmpDir("tokmissing");
    dirs.push(dir);
    const missing = path.join(dir, "nope.token");
    expect(tokenFileProblems(missing)).toHaveLength(1);
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({ tokenFile: missing }),
      binary: "cloudflared",
    });
    return expect(provider.start(48765)).rejects.toThrow(/NEED_NAMED_TUNNEL_CONFIG/);
  });

  it("fails safe when the path is a directory", () => {
    const dir = makeTmpDir("tokdir");
    dirs.push(dir);
    const asDir = path.join(dir, "adirectory.token");
    fs.mkdirSync(asDir, { recursive: true });
    expect(tokenFileProblems(asDir)[0]).toMatch(/directory/);
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({ tokenFile: asDir }),
      binary: "cloudflared",
    });
    return expect(provider.start(48765)).rejects.toThrow(/NEED_NAMED_TUNNEL_CONFIG/);
  });

  it("never reads the file contents while starting", async () => {
    const dir = makeTmpDir("toknoread");
    dirs.push(dir);
    const file = writeTokenFile(dir);
    const spy = vi.spyOn(fs, "readFileSync");
    try {
      const spawn = makeFakeSpawn();
      const provider = new CloudflaredNamedTunnel(undefined, {
        config: namedConfig({ tokenFile: file }),
        spawnFn: spawn.fn,
        binary: "cloudflared",
      });
      await provider.start(48765);
      await provider.stop();
      const readPaths = spy.mock.calls.map((call) => String(call[0]));
      expect(readPaths.filter((p) => p === file)).toHaveLength(0);
      expect(readPaths.filter((p) => p.endsWith(TOKEN_FILE_NAME))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ACL inspection", () => {
  it("flags broad principals", () => {
    expect(findBroadPrincipals(["DESKTOP-X\\guanz", "NT AUTHORITY\\SYSTEM", "Everyone"])).toEqual(["Everyone"]);
    expect(findBroadPrincipals(["BUILTIN\\Users"])).toEqual(["BUILTIN\\Users"]);
    expect(findBroadPrincipals(["NT AUTHORITY\\Authenticated Users"])).toEqual(["NT AUTHORITY\\Authenticated Users"]);
    expect(findBroadPrincipals(["DESKTOP-X\\guanz", "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"])).toEqual([]);
  });

  it("parses icacls principals", () => {
    const output = [
      "C:\\c2c secrets\\cloudflare-tunnel.token DESKTOP-X\\guanz:(R)",
      "                                        NT AUTHORITY\\SYSTEM:(R)",
      "                                        BUILTIN\\Administrators:(R)",
      "",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");
    expect(parseIcaclsPrincipals(output)).toEqual([
      "DESKTOP-X\\guanz",
      "NT AUTHORITY\\SYSTEM",
      "BUILTIN\\Administrators",
    ]);
  });

  it("reports missing files without leaking anything", () => {
    const dir = makeTmpDir("acl-missing");
    dirs.push(dir);
    const report = inspectTokenFile(path.join(dir, "nope.token"));
    expect(report).not.toBeNull();
    expect(report!.exists).toBe(false);
    expect(report!.secure).toBe(false);
    expect(report!.detail).not.toContain(TOKEN);
  });

  it("inspects a real file and reports existence + ACL", () => {
    const dir = makeTmpDir("acl-real");
    dirs.push(dir);
    const file = writeTokenFile(dir);
    const report = inspectTokenFile(file);
    expect(report).not.toBeNull();
    expect(report!.exists).toBe(true);
    expect(report!.isFile).toBe(true);
    expect(report!.detail).not.toContain(TOKEN);
    expect(typeof report!.secure).toBe("boolean");
  });
});

describe("named tunnel start with a token file", () => {
  it("passes only the path via TUNNEL_TOKEN_FILE and keeps argv clean", async () => {
    const dir = makeTmpDir("start-tokfile");
    dirs.push(dir);
    const file = writeTokenFile(dir);
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({ tokenFile: file }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    const url = await provider.start(48765);
    expect(url).toBe("https://c2c.example.test");

    const call = spawn.calls[0];
    expect(call.args).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(call.args.join(" ")).not.toContain(TOKEN);
    expect(call.args.join(" ")).not.toContain(file);
    expect(call.args).not.toContain("--token-file");
    expect(call.env!.TUNNEL_TOKEN_FILE).toBe(file);
    expect(call.env!.TUNNEL_TOKEN).toBeUndefined();
    expect(process.env.TUNNEL_TOKEN).toBeUndefined();
    await provider.stop();
  });

  it("keeps restart stable and reports authMode=token-file", async () => {
    const dir = makeTmpDir("restart-tokfile");
    dirs.push(dir);
    const file = writeTokenFile(dir);
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({ tokenFile: file }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    const first = await provider.start(48765);
    expect(provider.status().authMode).toBe("token-file");
    await provider.stop();
    expect(await provider.start(48765)).toBe(first);
    await provider.stop();
  });

  it("handles Windows paths with spaces", async () => {
    const dir = makeTmpDir("space dir");
    dirs.push(dir);
    const withSpace = path.join(dir, "c2c secrets");
    fs.mkdirSync(withSpace, { recursive: true });
    const file = writeTokenFile(withSpace);
    expect(file).toContain(" ");

    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({ tokenFile: file }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    await provider.start(48765);
    expect(spawn.calls[0].env!.TUNNEL_TOKEN_FILE).toBe(file);
    expect(spawn.calls[0].args.join(" ")).not.toContain(file);
    await provider.stop();
  });
});

describe("protocol + token file", () => {
  it("places --protocol http2 right after `tunnel`", async () => {
    const dir = makeTmpDir("proto-tokfile");
    dirs.push(dir);
    const file = writeTokenFile(dir);
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig({ tokenFile: file }, { protocol: "http2" }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
      protocolSupport: true,
    });
    await provider.start(48765);
    expect(spawn.calls[0].args).toEqual(["tunnel", "--protocol", "http2", "--no-autoupdate", "run"]);
    expect(spawn.calls[0].env!.TUNNEL_TOKEN_FILE).toBe(file);
    await provider.stop();
  });
});

describe("logs and state stay free of token content", () => {
  it("no token content in logs", async () => {
    const dir = makeTmpDir("log-tokfile");
    dirs.push(dir);
    const file = writeTokenFile(dir);
    const logFile = path.join(dir, "tunnel.log");
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(new Logger({ file: logFile, console: false, level: "debug" }), {
      config: namedConfig({ tokenFile: file }),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    await provider.start(48765);
    await provider.stop();
    const text = fs.readFileSync(logFile, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("token-file");
  });

  it("no token content in runtime/state, authMode is reported", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const wsDir = makeTmpDir("state-tokfile");
    dirs.push(wsDir);
    const file = writeTokenFile(wsDir);

    fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
    const logger = new Logger({
      name: "bridge-tokenfile",
      file: path.join(stateDir, "logs", "bridge.log"),
      console: false,
      level: "debug",
    });
    const spawn = makeFakeSpawn();
    const bridge = await startBridge({
      workspaceRoot: wsDir,
      port: 0,
      persistRuntime: true,
      logger,
      tunnelProvider: createTunnelProvider(logger, {
        config: namedConfig({ tokenFile: file }),
        spawnFn: spawn.fn,
        binary: "cloudflared",
      }),
    });
    const headers = { Authorization: `Bearer ${bridge.adminToken}` };
    const response = await fetch(`http://127.0.0.1:${bridge.port}/admin/tunnel/start`, {
      method: "POST",
      headers,
    });
    expect(response.ok).toBe(true);

    const info = (await (await fetch(`http://127.0.0.1:${bridge.port}/admin/info`, { headers })).json()) as {
      tunnel: { authMode?: string };
    };
    expect(info.tunnel.authMode).toBe("token-file");

    const runtimeFile = path.join(stateDir, "runtime", `${new Workspace(wsDir).id}.json`);
    expect(fs.readFileSync(runtimeFile, "utf8")).not.toContain(TOKEN);
    expect(fs.readFileSync(path.join(stateDir, "logs", "bridge.log"), "utf8")).not.toContain(TOKEN);

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
    for (const found of files) {
      expect(fs.readFileSync(found, "utf8")).not.toContain(TOKEN);
    }
  });
});

describe("c2c-autostart with a token file", () => {
  it(
    "passes the path through, stays idempotent and never leaks content",
    async () => {
      const stateDir = makeTmpDir("autostart-state");
      const workspace = makeTmpDir("autostart-ws");
      const tokenDir = makeTmpDir("autostart-token");
      dirs.push(stateDir, workspace, tokenDir);
      fs.writeFileSync(path.join(workspace, "hello.txt"), "hello\n");
      const tokenFile = writeTokenFile(tokenDir);

      const configFile = path.join(stateDir, "autostart.json");
      fs.writeFileSync(configFile, JSON.stringify({ workspaces: [workspace], tunnel: false }));

      const runEnv: NodeJS.ProcessEnv = {
        ...process.env,
        C2C_STATE_DIR: stateDir,
        C2C_AUTOSTART_CONFIG: configFile,
        C2C_TUNNEL_MODE: "named",
        C2C_TUNNEL_HOSTNAME: HOSTNAME,
        C2C_TUNNEL_TOKEN_FILE: tokenFile,
      };

      const run = (): void => {
        const result = spawnSync(process.execPath, [autostartScript], {
          encoding: "utf8",
          env: runEnv,
          windowsHide: true,
        });
        expect(result.status).toBe(0);
      };

      run();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const runtimeDir = path.join(stateDir, "runtime");
      const first = JSON.parse(fs.readFileSync(path.join(runtimeDir, fs.readdirSync(runtimeDir)[0]), "utf8"));

      run();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const second = JSON.parse(fs.readFileSync(path.join(runtimeDir, fs.readdirSync(runtimeDir)[0]), "utf8"));
      expect(second.pid).toBe(first.pid);

      const log = fs.readFileSync(path.join(stateDir, "logs", "autostart.log"), "utf8");
      expect(log).toContain(`fixed url=https://${HOSTNAME}`);
      expect(log).toContain("authMode=");
      expect(log.toLowerCase()).not.toContain("trycloudflare.com");
      expect(log).not.toContain(TOKEN);
      // The token file path itself is fine to log; its content is not.
      expect(log).not.toContain("falling back");

      spawnSync(process.execPath, [cli, "stop", "-w", workspace], {
        encoding: "utf8",
        env: { ...process.env, C2C_STATE_DIR: stateDir },
        windowsHide: true,
      });
    },
    120_000
  );
});

describe("token file does not disturb other modes", () => {
  it("token-env mode keeps working unchanged", async () => {
    const spawn = makeFakeSpawn();
    const provider = new CloudflaredNamedTunnel(undefined, {
      config: namedConfig(),
      spawnFn: spawn.fn,
      binary: "cloudflared",
    });
    await provider.start(48765);
    expect(spawn.calls[0].args).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(spawn.calls[0].env!.TUNNEL_TOKEN).toBe(TOKEN);
    expect(spawn.calls[0].env!.TUNNEL_TOKEN_FILE).toBeUndefined();
    expect(provider.status().authMode).toBe("token-env");
    await provider.stop();
  });

  it("locally-managed mode still needs name + config", async () => {
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
    expect(spawn.calls[0].env!.TUNNEL_TOKEN_FILE).toBeUndefined();
    expect(provider.status().authMode).toBe("local-config");
    await provider.stop();
  });

  it("Quick Tunnel stays the default", () => {
    expect(createTunnelProvider(undefined, { env: {} as NodeJS.ProcessEnv }).name).toBe("cloudflare-quick");
  });

  it("OAuth tokens survive a token-file tunnel restart", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const wsDir = makeTmpDir("oauth-tokfile");
    dirs.push(wsDir);
    const file = writeTokenFile(wsDir);

    const workspace = new Workspace(wsDir);
    const seed = new AuthStore(workspace.id);
    const client = seed.registerClient({ clientName: "ChatGPT", redirectUris: ["https://chatgpt.com/x"] });
    seed.issueTokens({ clientId: client.clientId, scopes: ["offline_access"] });

    const spawn = makeFakeSpawn();
    const bridge = await startBridge({
      workspaceRoot: wsDir,
      port: 0,
      persistRuntime: true,
      tunnelProvider: createTunnelProvider(undefined, {
        config: namedConfig({ tokenFile: file }),
        spawnFn: spawn.fn,
        binary: "cloudflared",
      }),
    });
    const headers = { Authorization: `Bearer ${bridge.adminToken}` };
    for (const route of ["/admin/tunnel/start", "/admin/tunnel/stop", "/admin/tunnel/start"]) {
      const response = await fetch(`http://127.0.0.1:${bridge.port}${route}`, { method: "POST", headers });
      expect(response.ok).toBe(true);
    }
    expect(bridge.authStore.tokenCount()).toBe(2);
    await bridge.close();
    expect(new AuthStore(workspace.id).tokenCount()).toBe(2);
  });
});
