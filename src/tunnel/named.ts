import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";
import {
  buildChildEnv,
  buildNamedTunnelArgs,
  inspectTokenFile,
  namedTunnelAuthMode,
  namedTunnelFlavour,
  namedTunnelProblems,
  namedTunnelPublicUrl,
  protocolFlagSupported,
  protocolProbeArgs,
  redactArgs,
  type SpawnFn,
  type TunnelConfig,
} from "./config.js";

/** cloudflared log lines that mean "the tunnel is up". */
const READY_RE =
  /registered tunnel connection|registered connector|connection established|start(?:ing)? hello world/i;

const DEFAULT_READY_TIMEOUT_MS = 45_000;

export interface CloudflaredNamedTunnelOptions {
  config: TunnelConfig;
  /** cloudflared binary; resolved from PATH when omitted. */
  binary?: string;
  /** Injectable spawn, so tests never launch a real tunnel. */
  spawnFn?: SpawnFn;
  /** Pre-computed `--protocol` support; when omitted the binary is probed once. */
  protocolSupport?: boolean;
  readyTimeoutMs?: number;
}

/**
 * Cloudflare Named Tunnel provider.
 *
 * Unlike a Quick Tunnel the public URL is known up front — it comes from
 * `C2C_TUNNEL_HOSTNAME`, so the Connector URL never changes between restarts.
 * No random URL is ever produced here, and there is no implicit fallback to a
 * Quick Tunnel: a broken named tunnel must fail loudly instead of silently
 * moving the Connector to a new address.
 *
 * The tunnel token is passed to cloudflared through the child process
 * environment (TUNNEL_TOKEN), never through argv.
 */
export class CloudflaredNamedTunnel implements TunnelProvider {
  readonly name = "cloudflare-named";
  private child: ChildProcess | null = null;
  private url: string | null;
  private lastError: string | null = null;
  private readyTimeoutMs: number;
  private protocolSupport: boolean | undefined;

  constructor(
    private readonly logger: Logger = nullLogger,
    private readonly opts: CloudflaredNamedTunnelOptions
  ) {
    this.url = namedTunnelPublicUrl(opts.config);
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.protocolSupport = opts.protocolSupport;
  }

  private binary(): string | null {
    return this.opts.binary ?? findBinary("cloudflared");
  }

  /** The token must never reach a log file, the runtime JSON or an exception message. */
  private scrub(text: string): string {
    const token = this.opts.config.named.token;
    if (!token) return text;
    return text.split(token).join("[REDACTED]");
  }

  /**
   * `--protocol` is a hidden `cloudflared tunnel` option: it is absent from
   * `tunnel --help`, so the only reliable check is to run the real command
   * against a tunnel name that cannot exist. cloudflared then stops while
   * resolving credentials — it never opens a connection — and reports an
   * unsupported flag as "flag provided but not defined".
   */
  private resolveProtocolSupport(bin: string): boolean {
    if (this.protocolSupport !== undefined) return this.protocolSupport;
    const protocol = this.opts.config.protocol;
    if (protocol === "auto") {
      this.protocolSupport = false;
      return false;
    }
    try {
      const probe = spawnSync(bin, protocolProbeArgs(protocol), { encoding: "utf8", timeout: 15_000 });
      const text = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
      this.protocolSupport = protocolFlagSupported(text);
    } catch {
      this.protocolSupport = false;
    }
    if (!this.protocolSupport) {
      this.logger.warn("cloudflared rejected --protocol; continuing without it (transport stays on auto)");
    }
    return this.protocolSupport;
  }

  async start(localPort: number): Promise<string> {
    const problems = namedTunnelProblems(this.opts.config);
    if (problems.length > 0) {
      throw new Error(`NEED_NAMED_TUNNEL_CONFIG: ${problems.join("; ")}`);
    }
    const url = namedTunnelPublicUrl(this.opts.config);
    if (!url) throw new Error("NEED_NAMED_TUNNEL_CONFIG: could not derive a public URL from C2C_TUNNEL_HOSTNAME");
    if (this.child && this.url) return this.url;

    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `winget install Cloudflare.cloudflared`) and retry."
      );
    }

    const protocolSupported = this.resolveProtocolSupport(bin);
    const args = buildNamedTunnelArgs(this.opts.config, { protocolSupported });
    // Child-only environment: process.env is never mutated.
    const env = buildChildEnv(this.opts.config);
    const spawnFn =
      this.opts.spawnFn ??
      ((cmd: string, a: string[], o: { stdio: ["ignore", "pipe", "pipe"]; env?: NodeJS.ProcessEnv }) =>
        spawn(cmd, a, o));

    this.logger.info(`Starting named tunnel -> ${url} (${redactArgs(args).join(" ")})`);
    const flavour = namedTunnelFlavour(this.opts.config);
    const authMode = namedTunnelAuthMode(this.opts.config);
    const hostname = url.replace(/^https:\/\//, "");
    this.logger.info(`Named tunnel auth mode: ${authMode ?? "unknown"}`);
    if (authMode === "token-file") {
      const acl = inspectTokenFile(this.opts.config.named.tokenFile);
      if (acl) {
        this.logger.info(`Token file: ${acl.secure ? acl.detail : `WARNING - ${acl.detail}`}`);
      }
    }
    if (flavour === "remote") {
      this.logger.info(
        `Remotely-managed tunnel: route the Published application ${hostname} -> http://127.0.0.1:${localPort} in the Cloudflare dashboard (no local config.yml required)`
      );
    } else {
      this.logger.info(
        `Locally-managed tunnel: config.yml ingress must route ${hostname} -> http://127.0.0.1:${localPort}`
      );
    }

    return new Promise<string>((resolve, reject) => {
      const child = spawnFn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
      this.child = child;
      this.lastError = null;

      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.url = url;
        this.logger.info(`Named tunnel established: ${url}`);
        resolve(url);
      };
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.child = null;
        reject(new Error(this.scrub(message)));
      };

      const timeout = setTimeout(() => {
        // The URL is deterministic, so a missing ready marker is not fatal —
        // but say so, otherwise a misconfigured tunnel looks healthy.
        this.logger.warn(
          `Named tunnel did not report a ready marker within ${Math.round(this.readyTimeoutMs / 1000)}s; using ${url} anyway`
        );
        finish();
      }, this.readyTimeoutMs);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          const safe = this.scrub(line);
          if (READY_RE.test(safe)) {
            finish();
            return;
          }
          if (/error|fatal/i.test(safe)) {
            this.lastError = safe.slice(0, 400);
            this.logger.debug(`cloudflared: ${safe.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error: Error) => {
        fail(`cloudflared failed to start: ${this.scrub(error.message)}`);
      });
      child.on("exit", (code) => {
        this.logger.warn(`cloudflared exited with code ${code}`);
        const wasStarting = !settled;
        this.child = null;
        if (wasStarting) {
          fail(
            `cloudflared exited (code ${code}) before the named tunnel was ready${
              this.lastError ? `: ${this.lastError}` : ""
            }`
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
    // Keep the URL: it is derived from configuration, not from the process, so
    // a restart always yields exactly the same public address.
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    const problems = namedTunnelProblems(this.opts.config);
    return {
      running: this.child !== null,
      url: this.url,
      provider: this.name,
      detail: this.lastError ?? (problems.length > 0 ? problems.join("; ") : undefined),
      authMode: namedTunnelAuthMode(this.opts.config) ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems = namedTunnelProblems(this.opts.config);
    if (namedTunnelAuthMode(this.opts.config) === "token-file") {
      const acl = inspectTokenFile(this.opts.config.named.tokenFile);
      if (acl) problems.push(...acl.problems);
    }
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("tunnel process not running");
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
