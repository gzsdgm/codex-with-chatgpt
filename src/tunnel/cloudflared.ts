import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import {
  buildQuickTunnelArgs,
  protocolFlagSupported,
  protocolProbeArgs,
  redactArgs,
  type CloudflaredProtocol,
  type SpawnFn,
} from "./config.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/** Extract a Quick Tunnel public URL from a cloudflared log line. */
export function parseQuickTunnelUrl(line: string): string | null {
  const match = line.match(QUICK_TUNNEL_URL_RE);
  return match ? match[0] : null;
}

export interface CloudflaredQuickTunnelOptions {
  /** cloudflared binary; resolved from PATH when omitted. */
  binary?: string;
  /** Transport protocol. `auto` keeps the historical behaviour. */
  protocol?: CloudflaredProtocol;
  /** Pre-computed `--protocol` support; when omitted the binary is probed once. */
  protocolSupport?: boolean;
  /** Injectable spawn, so tests never launch a real tunnel. */
  spawnFn?: SpawnFn;
}

/**
 * Cloudflare Quick Tunnel provider.
 * Quick Tunnels need no account/login; the URL changes on every start,
 * which the bridge and the Skill handle by reconfiguring automatically.
 */
export class CloudflaredQuickTunnel implements TunnelProvider {
  readonly name = "cloudflare-quick";
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private lastError: string | null = null;
  private protocolSupport: boolean | undefined;

  constructor(
    private readonly logger: Logger = nullLogger,
    private readonly opts: CloudflaredQuickTunnelOptions = {}
  ) {}

  private binary(): string | null {
    return this.opts.binary ?? findBinary("cloudflared");
  }

  private resolveProtocolSupport(bin: string): boolean {
    if (this.protocolSupport !== undefined) return this.protocolSupport;
    const protocol = this.opts.protocol ?? "auto";
    if (protocol === "auto") {
      this.protocolSupport = false;
      return false;
    }
    try {
      // `--protocol` is hidden from `tunnel --help`; probe the real syntax.
      const probe = spawnSync(bin, protocolProbeArgs(protocol), { encoding: "utf8", timeout: 15_000 });
      this.protocolSupport = protocolFlagSupported(`${probe.stdout ?? ""}${probe.stderr ?? ""}`);
    } catch {
      this.protocolSupport = false;
    }
    if (!this.protocolSupport) {
      this.logger.warn("cloudflared rejected --protocol; continuing without it");
    }
    return this.protocolSupport;
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.url) return this.url;
    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
      );
    }
    const protocolSupported = this.resolveProtocolSupport(bin);
    const args = buildQuickTunnelArgs(localPort, {
      protocol: this.opts.protocol ?? "auto",
      protocolSupported,
    });
    const spawnFn =
      this.opts.spawnFn ??
      ((cmd: string, a: string[], o: { stdio: ["ignore", "pipe", "pipe"]; env?: NodeJS.ProcessEnv }) =>
        spawn(cmd, a, o));

    this.logger.debug(`Starting quick tunnel: ${redactArgs(args).join(" ")}`);

    return new Promise<string>((resolve, reject) => {
      const child = spawnFn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
      this.child = child;
      this.url = null;
      this.lastError = null;

      const timeout = setTimeout(() => {
        if (!this.url) {
          this.logger.error("Quick tunnel did not produce a URL within 45s");
          child.kill("SIGTERM");
          reject(new Error("Tunnel start timed out"));
        }
      }, 45_000);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          const url = parseQuickTunnelUrl(line);
          if (url && !this.url) {
            this.url = url;
            clearTimeout(timeout);
            this.logger.info(`Quick tunnel established: ${url}`);
            resolve(url);
          }
          if (/error/i.test(line)) {
            this.lastError = line.slice(0, 400);
            this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error: Error) => {
        clearTimeout(timeout);
        this.child = null;
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        const wasStarting = this.url === null;
        this.logger.warn(`cloudflared exited with code ${code}`);
        this.child = null;
        this.url = null;
        if (wasStarting) {
          reject(new Error(`cloudflared exited (code ${code}) before establishing a tunnel${this.lastError ? `: ${this.lastError}` : ""}`));
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.url = null;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.url !== null,
      url: this.url,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("tunnel process not running");
    if (this.child && !this.url) problems.push("tunnel running but no public URL yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null,
      url: this.url,
      problems,
    };
  }
}
