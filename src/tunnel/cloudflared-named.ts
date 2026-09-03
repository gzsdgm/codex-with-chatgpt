import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";
import {
  buildChildEnv,
  buildNamedTunnelArgs,
  namedTunnelProblems,
  namedTunnelPublicUrl,
  type TunnelConfig,
  type SpawnOptions,
} from "./config.js";

const CONNECTED_RE = /registered tunnel connection/i;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export interface CloudflaredNamedTunnelOptions {
  tunnelName?: string;
  hostname?: string;
  tokenFile?: string;
  protocol?: TunnelConfig["protocol"];
  logger?: Logger;
  binaryOverride?: string;
  startTimeoutMs?: number;
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export function normalizeNamedTunnelHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_RE.test(normalized)) {
    throw new Error(`Invalid named tunnel hostname: ${hostname}`);
  }
  return normalized;
}

/**
 * Locally-managed Cloudflare named tunnel.
 *
 * The tunnel object and its DNS route are provisioned once with cloudflared.
 * This provider only starts and monitors the connector process, so the public
 * URL remains stable across bridge restarts.
 */
export class CloudflaredNamedTunnel implements TunnelProvider {
  readonly name = "cloudflare-named";
  private readonly config: TunnelConfig;
  private readonly logger: Logger;
  private readonly binaryOverride?: string;
  private readonly startTimeoutMs: number;
  private readonly spawnFn: NonNullable<CloudflaredNamedTunnelOptions["spawnFn"]>;
  private child: ChildProcess | null = null;
  private connected = false;
  private lastError: string | null = null;

  constructor(opts: CloudflaredNamedTunnelOptions) {
    this.config = {
      mode: "named",
      protocol: opts.protocol ?? "auto",
      named: { name: opts.tunnelName?.trim(), hostname: opts.hostname, tokenFile: opts.tokenFile },
    };
    this.logger = opts.logger ?? nullLogger;
    this.binaryOverride = opts.binaryOverride;
    this.startTimeoutMs = opts.startTimeoutMs ?? 45_000;
    this.spawnFn = opts.spawnFn ?? ((command, args, options) => spawn(command, args, options));
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  private publicUrl(): string {
    return namedTunnelPublicUrl(this.config)!;
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.connected) return this.publicUrl();
    const problems = namedTunnelProblems(this.config);
    if (problems.length > 0) {
      throw new Error(`NEED_NAMED_TUNNEL_CONFIG: ${problems.join("; ")}`);
    }
    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
      );
    }

    const args = buildNamedTunnelArgs(this.config, localPort);
    const env = buildChildEnv(this.config);
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
      } catch (error) {
        this.lastError = `cloudflared failed to start: ${(error as Error).message}`;
        reject(new Error(this.lastError));
        return;
      }
      this.child = child;
      this.connected = false;
      this.lastError = null;
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };
      const timeout = setTimeout(() => {
        if (!this.connected) {
          this.lastError = "Named tunnel start timed out";
          child.kill("SIGTERM");
          this.child = null;
          finish(() => reject(new Error(this.lastError ?? "Named tunnel start timed out")));
        }
      }, this.startTimeoutMs);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          if (CONNECTED_RE.test(line) && !this.connected) {
            this.connected = true;
            const url = this.publicUrl();
            this.logger.info(`Named tunnel established: ${url}`);
            finish(() => resolve(url));
          }
          if (/\b(error|failed|fatal)\b/i.test(line)) {
            this.lastError = "cloudflared reported an error";
            this.logger.debug(this.lastError);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        this.child = null;
        this.connected = false;
        finish(() => reject(new Error(`cloudflared failed to start: ${error.message}`)));
      });
      child.on("exit", (code) => {
        const wasStarting = !this.connected;
        this.logger.warn(`cloudflared named tunnel exited with code ${code}`);
        this.child = null;
        this.connected = false;
        if (wasStarting) {
          finish(() =>
            reject(
              new Error(
                `cloudflared exited (code ${code}) before establishing the named tunnel${
                  this.lastError ? `: ${this.lastError}` : ""
                }`
              )
            )
          );
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.connected = false;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.connected,
      url: this.connected ? this.publicUrl() : null,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.connected ? this.publicUrl() : null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("named tunnel process not running");
    if (this.child && !this.connected) problems.push("named tunnel is not connected yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null && this.connected,
      url: this.connected ? this.publicUrl() : null,
      problems,
    };
  }
}
