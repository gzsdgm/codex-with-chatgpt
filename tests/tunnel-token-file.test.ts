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
  inspectWindowsTokenFileAcl,
  namedTunnelProblems,
  resolveTunnelConfig,
  type TunnelConfig,
} from "../src/tunnel/config.js";
import { CloudflaredNamedTunnel } from "../src/tunnel/cloudflared-named.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const TOKEN = "token-file-secret-that-must-not-leak";
const HOSTNAME = "c2c.example.test";
const ACL_FILE = "C:\\secret.token";
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
  it("accepts a restricted ACL with inherited and propagation markers", () => {
    const report = inspectWindowsTokenFileAcl(ACL_FILE, {
      status: 0,
      stdout: [
        `${ACL_FILE} G260618\\guanz:(I)(F)`,
        "NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
        "Successfully processed 1 files; Failed processing 0 files",
      ].join("\r\n"),
    });
    expect(report).toEqual({ secure: true, detail: "token file ACL is restricted", problems: [] });
  });

  it("rejects broad principals with all supported marker layouts and write permissions", () => {
    for (const ace of [
      "Everyone:(F)",
      "Everyone:(I)(F)",
      "Everyone:(OI)(CI)(F)",
      "BUILTIN\\Users:(I)(M)",
      "Everyone:(W)",
    ]) {
      const report = inspectWindowsTokenFileAcl(ACL_FILE, { status: 0, stdout: `${ACL_FILE} ${ace}\r\n` });
      expect(report.secure, ace).toBe(false);
      expect(report.problems, ace).toContain("ACL_BROAD_PRINCIPAL");
    }
  });

  it("fails closed for icacls failures, empty output, absent ACEs, and malformed or partial ACEs", () => {
    const cases = [
      { result: { status: null, stdout: null, error: new Error("spawn failed") }, problem: "ACL_INSPECTION_FAILED" },
      { result: { status: 1, stdout: "" }, problem: "ACL_INSPECTION_FAILED" },
      { result: { status: 0, stdout: "" }, problem: "ACL_OUTPUT_EMPTY" },
      { result: { status: 0, stdout: "Successfully processed 1 files; Failed processing 0 files" }, problem: "ACL_OUTPUT_UNPARSEABLE" },
      {
        result: { status: 0, stdout: `${ACL_FILE} G260618\\guanz:(I)(F)\r\nEveryone:(I)(UNKNOWN)` },
        problem: "ACL_ENTRY_UNPARSEABLE",
      },
      {
        result: { status: 0, stdout: `${ACL_FILE} G260618\\guanz:(I)(F)\r\nnot-an-ace` },
        problem: "ACL_ENTRY_UNPARSEABLE",
      },
    ];
    for (const testCase of cases) {
      const report = inspectWindowsTokenFileAcl(ACL_FILE, testCase.result);
      expect(report.secure, testCase.problem).toBe(false);
      expect(report.problems, testCase.problem).toContain(testCase.problem);
    }
  });

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
