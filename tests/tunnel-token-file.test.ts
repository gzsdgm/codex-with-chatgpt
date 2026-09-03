import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { Logger } from "../src/logger/index.js";
import {
  buildChildEnv,
  buildNamedTunnelArgs,
  inspectTokenFile,
  namedTunnelProblems,
  resolveTunnelConfig,
  type TunnelConfig,
} from "../src/tunnel/config.js";
import { CloudflaredNamedTunnel } from "../src/tunnel/cloudflared-named.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const TOKEN = "token-file-secret-that-must-not-leak";
const HOSTNAME = "c2c.example.test";
const dirs: string[] = [];

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

function config(tokenFile?: string): TunnelConfig {
  return {
    mode: "named",
    protocol: "auto",
    named: { name: "c2c-production", hostname: HOSTNAME, tokenFile },
  };
}

function fakeSpawn(): { spawn: (command: string, args: string[], options: any) => ChildProcess; child: FakeChild; calls: any[] } {
  const child = new FakeChild();
  const calls: any[] = [];
  return {
    child,
    calls,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return child as unknown as ChildProcess;
    },
  };
}

function tokenFile(): string {
  const dir = makeTmpDir("token-file");
  dirs.push(dir);
  const file = write(dir, "cloudflare.token", TOKEN);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return file;
}

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe("token-file named tunnel configuration", () => {
  it("maps C2C_TUNNEL_* values without reading the token", () => {
    const file = tokenFile();
    const resolved = resolveTunnelConfig({
      C2C_TUNNEL_MODE: "named",
      C2C_TUNNEL_NAME: "c2c-production",
      C2C_TUNNEL_HOSTNAME: HOSTNAME,
      C2C_TUNNEL_TOKEN_FILE: file,
    });
    expect(resolved).toEqual(config(file));
    expect(namedTunnelProblems(resolved)).toEqual([]);
    expect(inspectTokenFile(file)?.secure).toBe(true);
  });

  it("constructs cloudflared args and child env without token contents", () => {
    const file = tokenFile();
    const named = config(file);
    expect(buildNamedTunnelArgs(named, 48765)).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://127.0.0.1:48765",
      "run",
      "c2c-production",
    ]);
    const env = buildChildEnv(named, { BASE: "1" });
    expect(env).toEqual({ BASE: "1", TUNNEL_TOKEN_FILE: file });
    expect(JSON.stringify(buildNamedTunnelArgs(named, 48765))).not.toContain(TOKEN);
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });

  it("fails closed when the token-file is missing", async () => {
    const spawn = fakeSpawn();
    const missingDir = makeTmpDir("missing-token");
    dirs.push(missingDir);
    const provider = new CloudflaredNamedTunnel({
      tunnelName: "c2c-production",
      hostname: HOSTNAME,
      tokenFile: path.join(missingDir, "missing.token"),
      binaryOverride: "cloudflared",
      spawnFn: spawn.spawn,
    });
    await expect(provider.start(48765)).rejects.toThrow(/token file not found/i);
    expect(spawn.calls).toHaveLength(0);
  });

  it("does not fallback to Quick Tunnel after named startup failure", async () => {
    const spawn = fakeSpawn();
    const provider = new CloudflaredNamedTunnel({
      tunnelName: "c2c-production",
      hostname: HOSTNAME,
      tokenFile: tokenFile(),
      binaryOverride: "cloudflared",
      spawnFn: spawn.spawn,
      startTimeoutMs: 100,
    });
    const starting = provider.start(48765);
    spawn.child.emit("exit", 17);
    await expect(starting).rejects.toThrow(/before establishing/i);
    expect(provider.name).toBe("cloudflare-named");
    expect(provider.getPublicUrl()).toBeNull();
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].args.join(" ")).not.toContain("trycloudflare.com");
  });

  it("keeps windowsHide=true and publishes URL only after a real ready marker", async () => {
    const spawn = fakeSpawn();
    const provider = new CloudflaredNamedTunnel({
      tunnelName: "c2c-production",
      hostname: HOSTNAME,
      tokenFile: tokenFile(),
      binaryOverride: "cloudflared",
      spawnFn: spawn.spawn,
      startTimeoutMs: 500,
    });
    const starting = provider.start(48765);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spawn.calls[0].options.windowsHide).toBe(true);
    expect(provider.status()).toMatchObject({ running: false, url: null, provider: "cloudflare-named" });
    expect(provider.getPublicUrl()).toBeNull();
    spawn.child.stderr.write("INF Registered tunnel connection connIndex=0\n");
    await expect(starting).resolves.toBe(`https://${HOSTNAME}`);
    expect(provider.status()).toMatchObject({ running: true, url: `https://${HOSTNAME}` });
    await provider.stop();
  });

  it("does not write token-file contents to diagnostics", async () => {
    const dir = makeTmpDir("token-log");
    dirs.push(dir);
    const file = write(dir, "cloudflare.token", TOKEN);
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    const logFile = path.join(dir, "tunnel.log");
    const logger = new Logger({ name: "token-file-test", file: logFile, console: false, level: "debug" });
    const spawn = fakeSpawn();
    const provider = new CloudflaredNamedTunnel({
      tunnelName: "c2c-production",
      hostname: HOSTNAME,
      tokenFile: file,
      binaryOverride: "cloudflared",
      spawnFn: spawn.spawn,
      logger,
    });
    const starting = provider.start(48765);
    spawn.child.stderr.write("ERR cloudflared failed to authenticate\n");
    spawn.child.stderr.write("INF Registered tunnel connection connIndex=0\n");
    await starting;
    await provider.stop();
    expect(fs.readFileSync(logFile, "utf8")).not.toContain(TOKEN);
  });
});
